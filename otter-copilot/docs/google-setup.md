# Connect Google Calendar

Two ways to connect, mirroring how Otter works (owner reuses an existing session; other users
onboard fresh).

## A. Owner — reuse your existing authorized token (no re-consent)

If you already have an authorized-user token file (e.g. the one the standalone calendar tool
created, `…/scripts/calendar_token.json`), just point the app at it. The app reads and refreshes
it **in place** — nothing is copied, no consent screen, no new OAuth client.

```bash
cd otter-integration/otter_web
export NEAR_KEY=dummy                                 # calendar path doesn't use NEAR
export GOOGLE_TOKEN_FILE=/abs/path/to/calendar_token.json
# (optional) export OWNER_TOKEN=...  — omit for local dev: everyone is treated as owner
python3 server.py
```

Open `http://localhost:8137/` → the **Google** card shows **✓ <your email>** and your next
meetings. Identity is read from your primary calendar id, so only `calendar.readonly` is needed
(your existing token already has it). Errors surface verbatim (e.g. `403` = Calendar API disabled).

The token file must be the standard google authorized-user json (keys: `client_id`,
`client_secret`, `refresh_token`, optional `token_uri`). The app never writes to it.

## B. Other users — per-user OAuth web flow

For visitors who aren't the owner, supply an OAuth **web client** so they can connect their own
Google in-browser:

```bash
export GOOGLE_CLIENT_ID=...        # Google Cloud Console → Credentials → OAuth client (Web)
export GOOGLE_CLIENT_SECRET=...
export GOOGLE_REDIRECT_URI=http://localhost:8137/google/callback   # add this exact URI to the client
```

Then the Google card shows **connect Google →** → consent → connected. (Unverified test app:
*Advanced → Continue*; add yourself as a test user on the consent screen.)
