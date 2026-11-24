import logging
import os
import secrets
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime, parseaddr
from urllib.parse import quote, urlencode

import requests
from flask import Flask, jsonify, redirect, render_template, request, session, url_for


app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "").lower() == "true",
)
logging.basicConfig(level=logging.INFO)

app.config["FEEDBACK_DB_PATH"] = os.path.join(app.instance_path, "feedback.sqlite3")

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
MICROSOFT_CLIENT_ID = os.environ.get("MICROSOFT_CLIENT_ID", "")
MICROSOFT_CLIENT_SECRET = os.environ.get("MICROSOFT_CLIENT_SECRET", "")
MICROSOFT_TENANT = os.environ.get("MICROSOFT_TENANT", "common")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://127.0.0.1:5000").rstrip("/")

# Tokens stay on the server and are intentionally not written to disk.
TOKEN_STORE = {}
TOKEN_LOCK = threading.Lock()
REFRESH_LOCK = threading.Lock()
REQUEST_TIMEOUT = 15
MESSAGE_PAGE_SIZE = 100
MAX_THROTTLE_RETRIES = 3


@contextmanager
def _feedback_connection():
    database_path = app.config["FEEDBACK_DB_PATH"]
    os.makedirs(os.path.dirname(database_path), exist_ok=True)
    connection = sqlite3.connect(database_path, timeout=10)
    try:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS sender_feedback (
                provider TEXT NOT NULL,
                account_email TEXT NOT NULL,
                sender_email TEXT NOT NULL,
                action TEXT NOT NULL CHECK (action IN ('keep', 'delete')),
                updated_at TEXT NOT NULL,
                PRIMARY KEY (provider, account_email, sender_email)
            )
        """)
        yield connection
        connection.commit()
    except sqlite3.Error:
        connection.rollback()
        raise
    finally:
        connection.close()


def _sender_email(sender):
    if not isinstance(sender, str):
        return ""
    _, address = parseaddr(sender)
    address = address.strip().lower()
    if len(address) > 320 or address.count("@") != 1 or any(char.isspace() for char in address):
        return ""
    return address


def _load_feedback_rules(auth):
    with _feedback_connection() as connection:
        rows = connection.execute(
            "SELECT sender_email, action FROM sender_feedback WHERE provider = ? AND account_email = ?",
            (auth["provider"], auth.get("email", "")),
        ).fetchall()
    return dict(rows)


def _save_sender_feedback(auth, sender, action):
    address = _sender_email(sender)
    if not address:
        return False
    with _feedback_connection() as connection:
        connection.execute(
            """
            INSERT INTO sender_feedback (provider, account_email, sender_email, action, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(provider, account_email, sender_email)
            DO UPDATE SET action = excluded.action, updated_at = excluded.updated_at
            """,
            (
                auth["provider"],
                auth.get("email", ""),
                address,
                action,
                datetime.now(timezone.utc).isoformat(),
            ),
        )
    return True


class ProviderError(Exception):
    pass


def _session_id():
    if "sid" not in session:
        session["sid"] = secrets.token_urlsafe(32)
    return session["sid"]


def _tokens():
    sid = _session_id()
    with TOKEN_LOCK:
        return TOKEN_STORE.get(sid)


def _save_tokens(value):
    with TOKEN_LOCK:
        TOKEN_STORE[_session_id()] = value


def _remove_tokens():
    with TOKEN_LOCK:
        TOKEN_STORE.pop(_session_id(), None)


def _provider_config(provider):
    if provider == "google":
        if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
            raise ProviderError("Google sign-in is not configured yet.")
        return {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "authorize": "https://accounts.google.com/o/oauth2/v2/auth",
            "token": "https://oauth2.googleapis.com/token",
            "redirect_uri": PUBLIC_BASE_URL + url_for("oauth_callback", provider=provider),
            "scopes": "openid email profile https://www.googleapis.com/auth/gmail.modify",
        }
    if provider == "microsoft":
        if not MICROSOFT_CLIENT_ID or not MICROSOFT_CLIENT_SECRET:
            raise ProviderError("Microsoft sign-in is not configured yet.")
        base = "https://login.microsoftonline.com/{}/oauth2/v2.0".format(MICROSOFT_TENANT)
        return {
            "client_id": MICROSOFT_CLIENT_ID,
            "client_secret": MICROSOFT_CLIENT_SECRET,
            "authorize": base + "/authorize",
            "token": base + "/token",
            "redirect_uri": PUBLIC_BASE_URL + url_for("oauth_callback", provider=provider),
            "scopes": "openid profile email offline_access User.Read Mail.ReadWrite",
        }
    raise ProviderError("That email provider is not supported.")


def _json_response(response):
    try:
        body = response.json()
    except ValueError:
        body = {}
    if not response.ok:
        provider_error = body.get("error", "")
        if isinstance(provider_error, dict):
            provider_error = provider_error.get("message", "")
        detail = body.get("error_description") or provider_error
        if response.status_code == 401:
            raise ProviderError("Your connection expired. Please reconnect your account.")
        if response.status_code == 429:
            logging.warning("Email provider returned HTTP 429: %s", str(detail)[:300])
            raise ProviderError("Your mailbox is still busy after automatic retries. Wait briefly, then retry the failed action.")
        logging.warning("Email provider returned HTTP %s: %s", response.status_code, str(detail)[:300])
        raise ProviderError("The email provider could not complete that request. Please try again.")
    return body


def _token_request(provider, payload):
    config = _provider_config(provider)
    try:
        response = requests.post(
            config["token"],
            data=dict(payload, client_id=config["client_id"], client_secret=config["client_secret"]),
            timeout=REQUEST_TIMEOUT,
        )
    except requests.RequestException as exc:
        logging.warning("OAuth token request failed: %s", exc)
        raise ProviderError("Could not reach the sign-in service. Please try again.") from exc
    return _json_response(response)


def _authorized_request(method, url, **kwargs):
    auth = _tokens()
    if not auth:
        raise ProviderError("Connect an email account to continue.")
    if auth.get("expires_at", 0) <= time.time() + 60:
        with REFRESH_LOCK:
            auth = _tokens()
            if not auth:
                raise ProviderError("Connect an email account to continue.")
            if auth.get("expires_at", 0) <= time.time() + 60:
                refresh_token = auth.get("refresh_token")
                if not refresh_token:
                    raise ProviderError("Your connection expired. Please reconnect your account.")
                refreshed = _token_request(auth["provider"], {
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                })
                try:
                    auth["access_token"] = refreshed["access_token"]
                    auth["expires_at"] = time.time() + int(refreshed.get("expires_in", 3600))
                except (KeyError, TypeError, ValueError) as exc:
                    raise ProviderError("Your connection could not be refreshed. Please reconnect your account.") from exc
                auth["refresh_token"] = refreshed.get("refresh_token", refresh_token)
                _save_tokens(auth)
    headers = dict(kwargs.pop("headers", {}))
    headers["Authorization"] = "Bearer " + auth["access_token"]
    headers.setdefault("User-Agent", "Clearspace/1.0")
    for attempt in range(MAX_THROTTLE_RETRIES + 1):
        try:
            response = requests.request(method, url, headers=headers, timeout=REQUEST_TIMEOUT, **kwargs)
        except requests.RequestException as exc:
            logging.warning("Email API request failed: %s", exc)
            raise ProviderError("Could not reach your email provider. Please try again.") from exc
        if response.status_code != 429 or attempt == MAX_THROTTLE_RETRIES:
            return response
        retry_after = response.headers.get("Retry-After", "")
        try:
            delay = max(0.0, float(retry_after))
        except (TypeError, ValueError):
            try:
                retry_time = parsedate_to_datetime(retry_after)
                if retry_time.tzinfo is None:
                    retry_time = retry_time.replace(tzinfo=timezone.utc)
                delay = max(0.0, (retry_time - datetime.now(timezone.utc)).total_seconds())
            except (TypeError, ValueError, OverflowError):
                delay = float(2 ** attempt)
        logging.warning(
            "Email provider throttled the request; retrying in %.1f seconds (%s/%s)",
            delay,
            attempt + 1,
            MAX_THROTTLE_RETRIES,
        )
        time.sleep(delay)


def _google_header(headers, name):
    return next((item.get("value", "") for item in headers if item.get("name", "").lower() == name.lower()), "")


def _suggestion(message, sender_feedback=None):
    reasons = []
    if message.get("has_unsubscribe"):
        reasons.append("Mailing list")
    if message.get("is_promotion"):
        reasons.append("Promotions category")
    received = message.get("received_at")
    if received and message.get("is_read"):
        try:
            timestamp = datetime.fromisoformat(received.replace("Z", "+00:00"))
            age_days = (datetime.now(timezone.utc) - timestamp).days
            if age_days >= 180:
                reasons.append("Read more than 6 months ago")
        except (AttributeError, TypeError, ValueError):
            pass
    sender_address = _sender_email(message.get("sender", ""))
    message["sender_email"] = sender_address
    learned_action = (sender_feedback or {}).get(sender_address)
    message["learning_note"] = ""
    if learned_action == "keep":
        reasons = []
        message["learning_note"] = "Previously kept sender"
    elif learned_action == "delete":
        reasons.append("Previously deleted sender")
    message["reasons"] = reasons
    message["suggested"] = bool(reasons)
    return message


def _load_google_messages(page_token=None, sender_feedback=None):
    url = "https://gmail.googleapis.com/gmail/v1/users/me/messages"
    params = {"q": "in:inbox", "maxResults": MESSAGE_PAGE_SIZE}
    if page_token:
        params["pageToken"] = page_token
    result = _json_response(_authorized_request("GET", url, params=params))
    items = result.get("messages", [])

    def load_one(item):
        raw = _json_response(_authorized_request(
            "GET",
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + item["id"],
            params={"format": "metadata", "metadataHeaders": ["From", "Subject", "Date", "List-Unsubscribe"]},
        ))
        headers = raw.get("payload", {}).get("headers", [])
        labels = raw.get("labelIds", [])
        sender = _google_header(headers, "From")
        if not _sender_email(sender):
            sender = _google_header(headers, "Sender") or sender
        received_ms = raw.get("internalDate")
        try:
            received = datetime.fromtimestamp(int(received_ms) / 1000, timezone.utc).isoformat()
        except (TypeError, ValueError, OSError):
            received = None
        message = {
            "id": raw["id"],
            "subject": _google_header(headers, "Subject") or "(no subject)",
            "sender": sender or "Unknown sender",
            "preview": raw.get("snippet", ""),
            "received_at": received,
            "is_read": "UNREAD" not in labels,
            "is_promotion": "CATEGORY_PROMOTIONS" in labels,
            "has_unsubscribe": bool(_google_header(headers, "List-Unsubscribe")),
        }
        return _suggestion(message, sender_feedback)

    with ThreadPoolExecutor(max_workers=8) as pool:
        messages = list(pool.map(load_one, items))
    return messages, result.get("nextPageToken")


def _load_microsoft_messages(page_url=None, sender_feedback=None):
    url = page_url or "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages"
    params = {
        "$top": str(MESSAGE_PAGE_SIZE),
        "$select": "id,subject,from,sender,receivedDateTime,bodyPreview,isRead,categories,internetMessageHeaders",
        "$orderby": "receivedDateTime desc",
    } if not page_url else None
    response = _json_response(_authorized_request("GET", url, params=params))
    messages = []
    for raw in response.get("value", []):
        headers = raw.get("internetMessageHeaders", [])
        unsubscribe = any(
            header.get("name", "").lower() == "list-unsubscribe" for header in headers
        )
        from_address = (raw.get("from") or {}).get("emailAddress") or {}
        sender_address = (raw.get("sender") or {}).get("emailAddress") or {}
        sender_name = from_address.get("name") or sender_address.get("name", "")
        sender_email = from_address.get("address") or sender_address.get("address", "")
        messages.append(_suggestion({
            "id": raw["id"],
            "subject": raw.get("subject") or "(no subject)",
            "sender": "{} <{}>".format(sender_name, sender_email),
            "preview": raw.get("bodyPreview", ""),
            "received_at": raw.get("receivedDateTime"),
            "is_read": bool(raw.get("isRead")),
            "is_promotion": any(
                category.lower() in ("promotions", "newsletter") for category in raw.get("categories", [])
            ),
            "has_unsubscribe": unsubscribe,
        }, sender_feedback))
    return messages, response.get("@odata.nextLink")


@app.before_request
def ensure_session():
    _session_id()
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(24)


@app.route("/")
def index():
    return render_template("index.html", csrf_token=session["csrf"])


@app.route("/auth/<provider>")
def start_oauth(provider):
    try:
        config = _provider_config(provider)
    except ProviderError as exc:
        return redirect(url_for("index", setup_error=str(exc)))
    state = secrets.token_urlsafe(32)
    session["oauth_state_" + provider] = state
    query = {
        "client_id": config["client_id"],
        "redirect_uri": config["redirect_uri"],
        "response_type": "code",
        "scope": config["scopes"],
        "state": state,
    }
    if provider == "google":
        query.update({"access_type": "offline", "prompt": "consent"})
    else:
        query["response_mode"] = "query"
    return redirect(config["authorize"] + "?" + urlencode(query))


@app.route("/auth/<provider>/callback")
def oauth_callback(provider):
    expected_state = session.pop("oauth_state_" + provider, None)
    if not expected_state or not secrets.compare_digest(expected_state, request.args.get("state", "")):
        return redirect(url_for("index", setup_error="Sign-in could not be verified. Please try again."))
    if request.args.get("error"):
        return redirect(url_for("index", setup_error="Sign-in was cancelled or denied."))
    code = request.args.get("code")
    if not code:
        return redirect(url_for("index", setup_error="Sign-in did not return an authorization code."))
    try:
        config = _provider_config(provider)
        result = _token_request(provider, {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": config["redirect_uri"],
        })
        auth = {
            "provider": provider,
            "access_token": result["access_token"],
            "refresh_token": result.get("refresh_token"),
            "expires_at": time.time() + int(result.get("expires_in", 3600)),
            "email": "",
        }
        _save_tokens(auth)
        profile_url = (
            "https://www.googleapis.com/oauth2/v2/userinfo"
            if provider == "google" else "https://graph.microsoft.com/v1.0/me"
        )
        profile = _json_response(_authorized_request("GET", profile_url))
        auth["email"] = profile.get("email") or profile.get("userPrincipalName") or profile.get("mail") or "Connected account"
        _save_tokens(auth)
    except (ProviderError, KeyError, TypeError, ValueError) as exc:
        _remove_tokens()
        logging.warning("Account connection failed: %s", exc)
        message = str(exc) if isinstance(exc, ProviderError) else "Sign-in returned an incomplete response. Please try again."
        return redirect(url_for("index", setup_error=message))
    return redirect(url_for("index"))


def _require_csrf():
    token = request.headers.get("X-CSRF-Token", "")
    if not secrets.compare_digest(token, session.get("csrf", "")):
        return jsonify({"error": "Your session expired. Refresh the page and try again."}), 403
    return None


@app.route("/api/account")
def account():
    auth = _tokens()
    if not auth:
        return jsonify({"connected": False})
    return jsonify({
        "connected": True,
        "provider": auth["provider"],
        "email": auth.get("email", ""),
        "provider_name": "Gmail" if auth["provider"] == "google" else "Outlook",
    })


@app.route("/api/messages")
def messages():
    auth = _tokens()
    if not auth:
        return jsonify({"error": "Connect an email account to continue."}), 401
    cursor = request.args.get("cursor")
    if cursor:
        expected_cursor = auth.get("messages_cursor")
        if not expected_cursor or not secrets.compare_digest(cursor, expected_cursor):
            return jsonify({"error": "That inbox page expired. Refresh to start a new scan."}), 400
        provider_cursor = auth.get("messages_provider_cursor")
    else:
        provider_cursor = None
    try:
        sender_feedback = _load_feedback_rules(auth)
        if auth["provider"] == "google":
            items, next_provider_cursor = _load_google_messages(provider_cursor, sender_feedback)
        else:
            items, next_provider_cursor = _load_microsoft_messages(provider_cursor, sender_feedback)
    except ProviderError as exc:
        return jsonify({"error": str(exc)}), 502
    except sqlite3.Error:
        logging.exception("Could not load local sender feedback")
        return jsonify({"error": "Could not read local learning data. Check that the app can write to its instance folder."}), 500
    next_cursor = None
    if next_provider_cursor:
        next_cursor = secrets.token_urlsafe(24)
        auth["messages_cursor"] = next_cursor
        auth["messages_provider_cursor"] = next_provider_cursor
    else:
        auth.pop("messages_cursor", None)
        auth.pop("messages_provider_cursor", None)
    return jsonify({"messages": items, "next_cursor": next_cursor})


@app.route("/api/feedback", methods=["POST"])
def save_feedback():
    csrf_error = _require_csrf()
    if csrf_error:
        return csrf_error
    auth = _tokens()
    if not auth:
        return jsonify({"error": "Connect an email account to continue."}), 401
    payload = request.get_json(silent=True) or {}
    if payload.get("action") != "keep":
        return jsonify({"error": "Choose a valid learning action."}), 400
    if not _sender_email(payload.get("sender_email")):
        return jsonify({"error": "This email has no sender address to learn from."}), 400
    try:
        _save_sender_feedback(auth, payload["sender_email"], "keep")
    except sqlite3.Error:
        logging.exception("Could not save sender feedback")
        return jsonify({"error": "Could not save learning data. Check that the app can write to its instance folder."}), 500
    return jsonify({"saved": True})


@app.route("/api/feedback/reset", methods=["POST"])
def reset_feedback():
    csrf_error = _require_csrf()
    if csrf_error:
        return csrf_error
    auth = _tokens()
    if not auth:
        return jsonify({"error": "Connect an email account to continue."}), 401
    try:
        with _feedback_connection() as connection:
            cursor = connection.execute(
                "DELETE FROM sender_feedback WHERE provider = ? AND account_email = ?",
                (auth["provider"], auth.get("email", "")),
            )
            cleared = cursor.rowcount
    except sqlite3.Error:
        logging.exception("Could not reset sender feedback")
        return jsonify({"error": "Could not clear local learning data. Check that the app can write to its instance folder."}), 500
    return jsonify({"cleared": cleared})


@app.route("/api/delete", methods=["POST"])
def delete_message():
    csrf_error = _require_csrf()
    if csrf_error:
        return csrf_error
    auth = _tokens()
    if not auth:
        return jsonify({"error": "Connect an email account to continue."}), 401
    payload = request.get_json(silent=True) or {}
    message_id = payload.get("id")
    if not isinstance(message_id, str) or not message_id or len(message_id) > 500:
        return jsonify({"error": "Choose a valid message to delete."}), 400
    try:
        if auth["provider"] == "google":
            response = _authorized_request(
                "POST",
                "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/trash".format(quote(message_id, safe="")),
            )
        else:
            response = _authorized_request(
                "DELETE",
                "https://graph.microsoft.com/v1.0/me/messages/{}".format(quote(message_id, safe="")),
            )
        _json_response(response)
    except ProviderError as exc:
        return jsonify({"error": str(exc)}), 502
    sender_feedback_saved = False
    warning = ""
    try:
        sender_feedback_saved = _save_sender_feedback(auth, payload.get("sender_email"), "delete")
        if not sender_feedback_saved:
            warning = "The email was moved to Trash/Deleted Items, but no usable sender address was available for learning."
    except sqlite3.Error:
        logging.exception("Email was deleted but sender feedback could not be saved")
        warning = "The email was moved to Trash/Deleted Items, but learning feedback could not be saved."
    return jsonify({
        "deleted": True,
        "learning_saved": sender_feedback_saved,
        "warning": warning,
    })


@app.route("/api/disconnect", methods=["POST"])
def disconnect():
    csrf_error = _require_csrf()
    if csrf_error:
        return csrf_error
    _remove_tokens()
    return jsonify({"connected": False})


@app.errorhandler(ProviderError)
def handle_provider_error(error):
    return jsonify({"error": str(error)}), 502


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False)
