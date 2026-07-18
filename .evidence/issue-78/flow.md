# Issue 78 verification

## Acceptance

- With a real service-account key seeded, the agent-calendar app shows live events from the service account's own calendar at the app URL on staging.
- Creating an event via the app makes it appear in the actual Google calendar (verifiable by the human owner subscribing to it).
- No service-account key is ever committed; errors propagate (no fallbacks).

## What was verified

- `deno check agent-calendar/server.ts` passed.
- `project.json` parsed successfully.
- `git ls-files` found no service-account or Google key file.
- With a generated non-Google test key, `GET /api/events` reached Google's JWT exchange and surfaced Google's real `400 Invalid grant: account not found` response. No fixture data was rendered.

## Could not verify

- Staging deployment and the signed-in staging walk could not be completed because this box has no real service-account key seeded for `GOOGLE_SERVICE_ACCOUNT_JSON`; the deploy script refuses to run without it.
- Therefore live event listing, event creation, and read-only capability use remain unverified. This PR does not claim Tier 2 green evidence or `ready-to-merge`.
