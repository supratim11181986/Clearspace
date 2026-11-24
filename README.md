# Clearspace

Clearspace is a small web app for reviewing Gmail or Outlook inbox messages. It explains suggestions, learns from explicit Keep/Delete choices, and moves messages to Trash/Deleted Items only after you confirm. It never permanently deletes or automatically deletes mail.

## Run locally

1. Install Python 3.10 or newer.
2. If `.venv` does not already exist, create it. Then install or update dependencies:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

   If `.venv` already exists, skip the `py -m venv .venv` command and run only the pip command.

   If `py` is not recognized, use the Python install path instead:

   ```powershell
   & "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -m venv .venv
   ```

3. Register OAuth applications with Google and/or Microsoft. For Microsoft local sign-in, use `http://localhost:5000/auth/microsoft/callback` (`127.0.0.1` is not accepted by Microsoft). Google can use either `http://127.0.0.1:5000/auth/google/callback` or `http://localhost:5000/auth/google/callback`.
4. Set the credentials in PowerShell (use the values from your provider registration):

   ```powershell
   $env:GOOGLE_CLIENT_ID="your-google-client-id"
   $env:GOOGLE_CLIENT_SECRET="your-google-client-secret"
   $env:MICROSOFT_CLIENT_ID="your-microsoft-client-id"
   $env:MICROSOFT_CLIENT_SECRET="your-microsoft-client-secret"
   $env:SECRET_KEY="a-long-random-secret"
   ```

   Configure only the provider(s) you intend to use. `PUBLIC_BASE_URL` defaults to `http://127.0.0.1:5000`; for Microsoft local sign-in, set it to `http://localhost:5000` and open the app at that same origin. If using both providers with `localhost`, register the matching localhost callback URI in Google too. For a public deployment, set it to the app's HTTPS origin.
5. Start the server and open `http://127.0.0.1:5000`:

   ```powershell
   .\.venv\Scripts\python.exe app.py
   ```

### Sanity checks

- In a second PowerShell window, run `.\.venv\Scripts\python.exe -m unittest discover -s tests` to run the local tests.
- Open `http://127.0.0.1:5000/api/account`. Before connecting, it should return `{"connected":false}`. After OAuth sign-in, the page should show the connected email account.
- After connecting an account, check that the dashboard's inbox count matches the number of messages Clearspace loaded. The count can take longer to appear for large inboxes.

### OAuth setup

- **Google:** Create an OAuth client in Google Cloud, enable the Gmail API, and add the callback URI above to the authorized redirect URIs. The app requests `openid`, `email`, `profile`, and `gmail.modify`. Google may require test-user configuration while the OAuth consent screen is in testing.
- **Microsoft:** Register a web app in Microsoft Entra, add the callback URI, and grant delegated `User.Read` and `Mail.ReadWrite` permissions. `MICROSOFT_TENANT` can be set to `common` (default), `consumers`, or a tenant ID, depending on the account and app registration.

## How suggestions work

The app paginates through the entire inbox in batches of 100. Each batch appears as soon as it loads, while later batches continue in the background so you can review messages during the scan. It suggests messages with a mailing-list unsubscribe header, a promotions/newsletter category, that are read and more than six months old, or from a sender you previously chose to delete. These are review hints, not a judgment about importance. You can browse all inbox messages, keep suggestions, search, select multiple, or delete individual messages. Each delete operation requires explicit confirmation and moves the message to Trash/Deleted Items. Bulk deletes are sent one at a time, and provider throttling is retried with backoff. Large inboxes may take longer to finish loading.

## Learning and safe automation

Keep and Delete choices update the learned action for that exact sender address and email account. Keep suppresses future suggestions from that sender; Delete makes future messages from that sender suggestions, with the reason shown. These choices only affect recommendations: Clearspace never deletes automatically. Use **Clear learned patterns** in the sidebar to erase the local feedback for the connected account.

## Privacy and deployment notes

- OAuth tokens are held in server memory and never stored in the browser or written to disk. Restarting the process disconnects accounts; this simple MVP is intended for local use and a single server process.
- Use HTTPS, a strong `SECRET_KEY`, `COOKIE_SECURE=true`, a durable encrypted server-side token store, and a production WSGI server before deploying publicly. Do not expose the Flask development server to the internet.
- The app requests permission to modify email so that it can move messages to Trash/Deleted Items after you confirm. Subjects, previews, and message bodies are not saved. Keep/Delete feedback stores sender addresses and your latest action in the local `instance/feedback.sqlite3` database; this folder is excluded from source control.
- Google and Microsoft OAuth credentials are secrets. Keep them out of source control and configure production redirect URIs separately.
