import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import app


class FakeResponse:
    def __init__(self, body, status_code=200, headers=None):
        self.body = body
        self.status_code = status_code
        self.ok = 200 <= status_code < 400
        self.headers = headers or {}

    def json(self):
        return self.body


class ClearspaceTests(unittest.TestCase):
    def setUp(self):
        app.app.config.update(TESTING=True)
        self.feedback_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.feedback_dir.cleanup)
        app.app.config["FEEDBACK_DB_PATH"] = os.path.join(self.feedback_dir.name, "feedback.sqlite3")
        with app.TOKEN_LOCK:
            app.TOKEN_STORE.clear()
        self.client = app.app.test_client()

    def test_old_read_message_is_suggested_but_old_unread_message_is_not(self):
        old_date = (datetime.now(timezone.utc) - timedelta(days=181)).isoformat().replace("+00:00", "Z")
        read_message = app._suggestion({"received_at": old_date, "is_read": True})
        unread_message = app._suggestion({"received_at": old_date, "is_read": False})

        self.assertTrue(read_message["suggested"])
        self.assertIn("Read more than 6 months ago", read_message["reasons"])
        self.assertFalse(unread_message["suggested"])

    def test_mailing_list_message_is_suggested(self):
        message = app._suggestion({"has_unsubscribe": True})

        self.assertTrue(message["suggested"])
        self.assertEqual(message["reasons"], ["Mailing list"])

    def test_keep_and_delete_feedback_personalize_only_the_matching_sender(self):
        auth = {"provider": "microsoft", "email": "owner@example.com"}
        app._save_sender_feedback(auth, "Newsletter <news@example.com>", "keep")
        feedback = app._load_feedback_rules(auth)

        kept_message = app._suggestion({
            "sender": "News <news@example.com>",
            "has_unsubscribe": True,
        }, feedback)
        other_sender = app._suggestion({
            "sender": "Other <other@example.com>",
            "has_unsubscribe": True,
        }, feedback)

        self.assertFalse(kept_message["suggested"])
        self.assertEqual(kept_message["learning_note"], "Previously kept sender")
        self.assertTrue(other_sender["suggested"])

        app._save_sender_feedback(auth, "news@example.com", "delete")
        feedback = app._load_feedback_rules(auth)
        deleted_sender_message = app._suggestion({"sender": "news@example.com"}, feedback)
        self.assertTrue(deleted_sender_message["suggested"])
        self.assertIn("Previously deleted sender", deleted_sender_message["reasons"])

    def test_google_messages_return_batched_pages(self):
        def request(_method, url, **kwargs):
            if url.endswith("/messages"):
                self.assertEqual(kwargs["params"]["maxResults"], app.MESSAGE_PAGE_SIZE)
                if kwargs["params"].get("pageToken") == "page-2":
                    return FakeResponse({"messages": [{"id": "second"}]})
                return FakeResponse({"messages": [{"id": "first"}], "nextPageToken": "page-2"})
            message_id = url.rsplit("/", 1)[-1]
            return FakeResponse({
                "id": message_id,
                "payload": {"headers": []},
                "labelIds": [],
                "internalDate": "0",
            })

        with patch.object(app, "_authorized_request", side_effect=request):
            first_page, next_page = app._load_google_messages()
            second_page, final_page = app._load_google_messages(next_page)

        self.assertEqual([message["id"] for message in first_page], ["first"])
        self.assertEqual(next_page, "page-2")
        self.assertEqual([message["id"] for message in second_page], ["second"])
        self.assertIsNone(final_page)

    def test_microsoft_messages_return_batched_pages(self):
        next_page = "https://graph.microsoft.com/v1.0/next-page"

        def request(_method, url, **kwargs):
            message_id = "first" if url.endswith("/messages") else "second"
            if url.endswith("/messages"):
                self.assertEqual(kwargs["params"]["$top"], str(app.MESSAGE_PAGE_SIZE))
            body = {"value": [{"id": message_id}]}
            if message_id == "first":
                body["@odata.nextLink"] = next_page
            return FakeResponse(body)

        with patch.object(app, "_authorized_request", side_effect=request):
            first_page, returned_next_page = app._load_microsoft_messages()
            second_page, final_page = app._load_microsoft_messages(returned_next_page)

        self.assertEqual([message["id"] for message in first_page], ["first"])
        self.assertEqual(returned_next_page, next_page)
        self.assertEqual([message["id"] for message in second_page], ["second"])
        self.assertIsNone(final_page)

    def test_microsoft_uses_sender_address_when_from_address_is_missing(self):
        body = {
            "value": [{
                "id": "message",
                "from": {"emailAddress": {"name": "Visible sender"}},
                "sender": {"emailAddress": {"name": "Mailbox sender", "address": "sender@example.com"}},
            }],
        }

        with patch.object(app, "_authorized_request", return_value=FakeResponse(body)):
            messages, next_page = app._load_microsoft_messages()

        self.assertEqual(messages[0]["sender_email"], "sender@example.com")
        self.assertEqual(messages[0]["sender"], "Visible sender <sender@example.com>")
        self.assertIsNone(next_page)

    def test_authorized_request_retries_throttling_after_retry_after(self):
        auth = {
            "provider": "microsoft",
            "access_token": "test-token",
            "expires_at": datetime.now(timezone.utc).timestamp() + 3600,
        }
        throttled = FakeResponse({"error": "throttled"}, 429, {"Retry-After": "2"})
        success = FakeResponse({"value": []})

        with patch.object(app, "_tokens", return_value=auth), patch.object(
            app.requests, "request", side_effect=[throttled, success]
        ) as request, patch.object(app.time, "sleep") as sleep:
            response = app._authorized_request("DELETE", "https://graph.microsoft.com/v1.0/me/messages/id")

        self.assertIs(response, success)
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(2.0)

    def test_messages_api_uses_an_opaque_cursor_for_following_batches(self):
        auth = {"provider": "microsoft"}

        def load_page(provider_cursor, _sender_feedback):
            if provider_cursor is None:
                return [{"id": "first"}], "provider-next-link"
            return [{"id": "second"}], None

        with patch.object(app, "_tokens", return_value=auth), patch.object(
            app, "_load_feedback_rules", return_value={}
        ), patch.object(app, "_load_microsoft_messages", side_effect=load_page) as load:
            first_response = self.client.get("/api/messages")
            first_page = first_response.get_json()
            second_response = self.client.get(
                "/api/messages",
                query_string={"cursor": first_page["next_cursor"]},
            )

        self.assertEqual(first_response.status_code, 200)
        self.assertNotEqual(first_page["next_cursor"], "provider-next-link")
        self.assertEqual(second_response.get_json()["messages"], [{"id": "second"}])
        self.assertIsNone(second_response.get_json()["next_cursor"])
        self.assertEqual(load.call_args_list[1].args[0], "provider-next-link")

    def test_keep_feedback_requires_csrf_and_a_connected_account(self):
        self.client.get("/")
        with self.client.session_transaction() as browser_session:
            csrf_token = browser_session["csrf"]

        payload = {"action": "keep", "sender_email": "news@example.com"}
        rejected = self.client.post("/api/feedback", json=payload, headers={"X-CSRF-Token": "invalid"})
        self.assertEqual(rejected.status_code, 403)

        not_connected = self.client.post(
            "/api/feedback",
            json=payload,
            headers={"X-CSRF-Token": csrf_token},
        )
        self.assertEqual(not_connected.status_code, 401)

    def test_delete_requires_csrf_and_a_connected_account(self):
        self.client.get("/")
        with self.client.session_transaction() as browser_session:
            csrf_token = browser_session["csrf"]

        payload = {"id": "message", "sender_email": "news@example.com"}
        rejected = self.client.post("/api/delete", json=payload, headers={"X-CSRF-Token": "invalid"})
        self.assertEqual(rejected.status_code, 403)

        not_connected = self.client.post(
            "/api/delete",
            json=payload,
            headers={"X-CSRF-Token": csrf_token},
        )
        self.assertEqual(not_connected.status_code, 401)

    def test_delete_moves_outlook_mail_to_deleted_items_and_learns_sender(self):
        auth = {"provider": "microsoft", "email": "owner@example.com"}
        self.client.get("/")
        with self.client.session_transaction() as browser_session:
            csrf_token = browser_session["csrf"]

        with patch.object(app, "_tokens", return_value=auth), patch.object(
            app, "_authorized_request", return_value=FakeResponse({})
        ) as authorized_request:
            response = self.client.post(
                "/api/delete",
                json={"id": "message-1", "sender_email": "news@example.com"},
                headers={"X-CSRF-Token": csrf_token},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(authorized_request.call_args.args[0], "DELETE")
        self.assertIn("/me/messages/message-1", authorized_request.call_args.args[1])
        self.assertTrue(response.get_json()["learning_saved"])
        self.assertEqual(app._load_feedback_rules(auth), {"news@example.com": "delete"})

    def test_delete_moves_gmail_mail_to_trash(self):
        auth = {"provider": "google", "email": "owner@gmail.com"}
        self.client.get("/")
        with self.client.session_transaction() as browser_session:
            csrf_token = browser_session["csrf"]

        with patch.object(app, "_tokens", return_value=auth), patch.object(
            app, "_authorized_request", return_value=FakeResponse({})
        ) as authorized_request:
            response = self.client.post(
                "/api/delete",
                json={"id": "message-2", "sender_email": "news@example.com"},
                headers={"X-CSRF-Token": csrf_token},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(authorized_request.call_args.args[0], "POST")
        self.assertTrue(authorized_request.call_args.args[1].endswith("/messages/message-2/trash"))
        self.assertTrue(response.get_json()["learning_saved"])

    def test_delete_succeeds_with_clear_warning_when_sender_is_unavailable(self):
        auth = {"provider": "microsoft", "email": "owner@example.com"}
        self.client.get("/")
        with self.client.session_transaction() as browser_session:
            csrf_token = browser_session["csrf"]

        with patch.object(app, "_tokens", return_value=auth), patch.object(
            app, "_authorized_request", return_value=FakeResponse({})
        ):
            response = self.client.post(
                "/api/delete",
                json={"id": "message-3", "sender_email": ""},
                headers={"X-CSRF-Token": csrf_token},
            )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["deleted"])
        self.assertFalse(response.get_json()["learning_saved"])
        self.assertIn("no usable sender address", response.get_json()["warning"])

    def test_feedback_reset_removes_only_current_account_rules(self):
        auth = {"provider": "microsoft", "email": "owner@example.com"}
        app._save_sender_feedback(auth, "news@example.com", "keep")
        app._save_sender_feedback(
            {"provider": "microsoft", "email": "other@example.com"},
            "news@example.com",
            "delete",
        )
        self.client.get("/")
        with self.client.session_transaction() as browser_session:
            csrf_token = browser_session["csrf"]

        with patch.object(app, "_tokens", return_value=auth):
            response = self.client.post(
                "/api/feedback/reset",
                headers={"X-CSRF-Token": csrf_token},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["cleared"], 1)
        self.assertEqual(app._load_feedback_rules(auth), {})
        self.assertEqual(
            app._load_feedback_rules({"provider": "microsoft", "email": "other@example.com"}),
            {"news@example.com": "delete"},
        )


if __name__ == "__main__":
    unittest.main()
