# Clearspace

Clearspace is a local web app for reviewing Gmail or Outlook inbox messages. It explains suggestions, learns from explicit Keep/Delete choices, and can optionally move likely promotions to a recoverable review folder. It never permanently deletes email.

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
   $env:PUBLIC_BASE_URL="http://localhost:5000"
   ```

   Configure only the provider(s) you intend to use. For Microsoft local sign-in, keep `PUBLIC_BASE_URL` set to `http://localhost:5000` and use `localhost` throughout the sign-in flow. `localhost` and `127.0.0.1` are different browser origins, so switching between them can prevent OAuth state cookies from being sent. If using Gmail only, set `PUBLIC_BASE_URL` to the origin matching the Google callback URI you registered (the default is `http://127.0.0.1:5000`). If using both providers with `localhost`, register the matching localhost callback URI in Google too. For a public deployment, set it to the app's HTTPS origin.
5. Start the server and open the same origin configured in `PUBLIC_BASE_URL` (for Microsoft local sign-in, `http://localhost:5000`):

   ```powershell
   .\.venv\Scripts\python.exe app.py
   ```

### Sanity checks

- In a second PowerShell window, run `.\.venv\Scripts\python.exe -m unittest discover -s tests` to run the local tests.
- Open `<PUBLIC_BASE_URL>/api/account`. Before connecting, it should return `{"connected":false}`. After OAuth sign-in, the page should show the connected email account.
- After connecting an account, check that the dashboard's inbox count matches the number of messages Clearspace loaded. The count can take longer to appear for large inboxes.

### OAuth setup

- **Google:** Create an OAuth client in Google Cloud, enable the Gmail API, and add the callback URI above to the authorized redirect URIs. The app requests `openid`, `email`, `profile`, and `gmail.modify`. Google may require test-user configuration while the OAuth consent screen is in testing.
- **Microsoft:** Register a web app in Microsoft Entra, add the callback URI, and grant delegated `User.Read` and `Mail.ReadWrite` permissions. `MICROSOFT_TENANT` can be set to `common` (default), `consumers`, or a tenant ID, depending on the account and app registration.

## How suggestions work

The app paginates through the entire inbox in batches of 100. Each batch appears as soon as it loads, while later batches continue in the background so you can review messages during the scan. It suggests messages with a mailing-list unsubscribe header, a promotions/newsletter category, that are read and more than six months old, or from a sender you previously chose to delete. These are review hints, not a judgment about importance. You can browse all inbox messages, keep suggestions, search within the active Suggested, All inbox, or Review tab, select multiple messages in the inbox or Review folder, or delete individual and selected messages. Delete immediately moves mail to recoverable Trash/Deleted Items without a confirmation popup. Bulk deletes are sent one at a time, and provider throttling is retried with backoff. Large inboxes may take longer to finish loading.

Use the **Theme** control in the top bar to choose **Light**, **Dark**, or **Auto**. Auto uses your device's local time: Light from 7:00 AM through 6:59 PM and Dark from 7:00 PM through 6:59 AM. Your choice is saved in this browser.

## Learning and safe automation

Keep and Delete choices update the learned action for that exact sender address and email account. Keep suppresses future suggestions from that sender; Delete makes future messages from that sender suggestions, with the reason shown. Use **Clear learned patterns** in the sidebar to erase the local feedback for the connected account.

### Optional automatic sorting

- Choose **Enable auto-sort** in the app to create/use a provider folder named **Clearspace Review** and scan the existing inbox. Matching messages are moved there; the review screen groups them by sender, with the largest groups listed first. Each sender checkbox selects all visible messages in that group. Use **Keep selected** to return that group's selected messages to the inbox, or **Delete selected** to move them to Trash/Deleted Items; the toolbar can delete selections across groups. The move is recoverable. Keeping messages teaches Clearspace to suppress future suggestions from that sender; deleting records the sender preference.
- While the app page is open, it checks for new inbox messages about once a minute. It does not monitor mail while the app or browser page is closed. **Pause auto-sort** stops future checks; it does not move messages already in the review folder back to the inbox.
- Classification uses local, explainable signals: Gmail/Outlook promotion categories, mailing-list unsubscribe headers, sender feedback, and promotional phrases in the subject, preview, or full body (for example, sale, discount, coupon, and special offer). A message that matches only the existing “read for more than six months” suggestion is not auto-moved.
- Receipt, invoice, payment, appointment, meeting, reservation, delivery, password-reset, verification, and security-alert language blocks automatic movement where detected. A sender you marked **Keep** is also excluded. Personal intent cannot be inferred reliably; only messages with a positive promotional signal are auto-moved. Review the folder and correct mistakes with **Keep**.
- Full message bodies are fetched from the connected provider and analyzed in memory on this computer. Clearspace does not send them to an AI service or save them to its local database. The provider continues to store the mail in the review folder.
- Auto-sort is off until you enable it. The enabled preference is stored locally per connected account in `instance/feedback.sqlite3`.

## Privacy and deployment notes

- OAuth tokens are held in server memory and never stored in the browser or written to disk. Restarting the process disconnects accounts; this simple MVP is intended for local use and a single server process.
- Use HTTPS, a strong `SECRET_KEY`, `COOKIE_SECURE=true`, a durable encrypted server-side token store, and a production WSGI server before deploying publicly. Do not expose the Flask development server to the internet.
- The app requests permission to modify email so that Delete can immediately move selected messages to recoverable Trash/Deleted Items or, if enabled, move likely promotions into Clearspace Review. Email text is not stored locally. Keep/Delete feedback, auto-sort preferences, and the provider review-folder identifier are stored in the local `instance/feedback.sqlite3` database; this folder is excluded from source control.
- Google and Microsoft OAuth credentials are secrets. Keep them out of source control and configure production redirect URIs separately.
