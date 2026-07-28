# Issue 44 walked flow

Tier 2 staging walk, 2026-07-28.

1. Opened the deployed staging URL: `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/otterpilot/`.
2. Asserted `location.href` matched that exact `/otterpilot/` URL in the Envoy browser bridge.
3. Waited for the live poll and asserted the page body contained `Otter read is waiting on step-up approval` and did not contain `409`.
4. Captured the rendered page as `01-step-up-pending.png`.

Acceptance assertion: `Open https://pod.dstack.soc1024.com/otterpilot/ in the evidence rig: header shows no 409; with no live meeting running it shows a truthful 'no live meeting' state (not an error).`

Could NOT verify: the staging Otter token returned a real `409 challenge_pending` until an operator approves the step-up request, and this box has no production credentials or production jar. The deployed UI categorizes that response without exposing `409`; the final truthful `no live meeting right now` state still requires operator approval/rebinding and a subsequent walk on prod.
