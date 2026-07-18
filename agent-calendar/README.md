# agent-calendar

A server-to-server Google Calendar v3 demo owned by a Google service account. The app signs a short-lived JWT with the service-account private key, exchanges it at Google’s documented token endpoint, and uses the resulting access token to list and create events.

The key is injected only as `GOOGLE_SERVICE_ACCOUNT_JSON` (or `GOOGLE_SERVICE_ACCOUNT_KEY_B64`) in the staging daemon environment. It is never included in the tarball, browser, logs, or repository. `GOOGLE_CALENDAR_ID` defaults to `primary`.

The app also exposes `POST /api/readonly-token`, which mints a separate Google access token with only `calendar.readonly`. A teammate app can use that bearer token to read the agent calendar but cannot create events with it. Errors from Google are returned as errors; there is no fixture or fallback path.

## Endpoints

- `GET /api/events` — live upcoming events from the service account calendar.
- `POST /api/events` — create an event with `summary`, `start`, and `end` ISO strings.
- `POST /api/readonly-token` — mint the read-only teammate capability.
- `GET /api/version` — deployment commit stamp used by evidence.

Deploy to staging with `GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}' bash deploy.sh`. Do not put the key in a file tracked by git or in screenshots.
