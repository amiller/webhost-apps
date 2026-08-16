# Flow — issue #146: NEAR enclave key verification, no TOFU, honest degrade

Asserts issue #146's `## Acceptance`, one clause at a time. Change is **Tier 2** (user-visible
header note in `public/index.html`) **+ Tier 1** (`/events`, `/diag` carry `attestation`).

Walked **2026-08-16 ~15:38–15:41 UTC** on the deployed staging goodpoint-box
`https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/goodpoint-box/`
(deployed from this branch, tree `025b230d27cf`, 2026-08-16T15:36:03Z), driven through the
**real browser** (envoy/neko rig — real pointer events, no CDP/Playwright). `location.href`
asserted before every frame. **Identity note:** goodpoint-box has no login surface — there is no
identity wall between the staging host and this UI; nothing to sign into (named, not decorated).

Pins for the deployed run were derived live via `attest-verify --derive-pins deepseek-ai/DeepSeek-V4-Flash`
(2026-08-16T15:19Z, TCB `UpToDate` at derive time) and deployed through `deploy.sh` with all four
pin vars. NEAR_API_KEY/CHUTES_API_KEY/OAUTH3_CORE recovered from the running project's env via the
staging `_api` (deploy credential); never printed.

## Clause 1 — pinned verify works and never guesses

Sidecar run from this branch, live NEAR API, pins from `--derive-pins` (2026-08-16T15:23:17Z) —
**all ten checks pass**, exit 0, and the returned pubkey's keccak address equals the attested
signing address:

```json
{"verified": true, "model": "deepseek-ai/DeepSeek-V4-Flash",
 "signing_public_key": "34ba223c…3b84",
 "attested_addresses": ["0xc5f6bf2f1bc666569157ec1bb4066cdaf48d026c"],
 "checks": {"gpu_nras_pass": true, "dcap_quote_valid": true, "report_data_binds_key_and_nonce": true,
   "compose_matches_mr_config": true, "policy_accepts": true, "debug_disabled": true,
   "event_log_rtmr_ok": true, "base_measurements_match": true,
   "tcb_status": "UpToDate", "tcb_level_acceptable": true}}
```

On failure the verdict names the exact failing check (see clause 2) — the JSON above/below is the
sidecar's own stdout; nothing is summarized away.

## Clause 2 — honest degrade, live on staging

During the walk, NEAR served the **staging egress** nodes with `tcb_status: "OutOfDate"`
(six consecutive attempts, 15:29–15:36Z); the same request from this workstation's vantage
verified `UpToDate` 4/4 times at 15:33Z — third-party fleet state, not our code. The box did
exactly what the issue demands — kept running, e2ee on, said so:

- **`01-degrade-note.png`** — the running app header; amber **“e2ee: unverified key”** note
  PAINTED (pixel-checked: 203 px of the `#f0b429` family inside the note's bounding box
  (1334,7)–(1473,47), matching DOM `attNote` rect x=1342.5 y=19.4 w=123 h=16.2, `hidden:false`).
  DOM in the same frame: `attNote.title` carries the full sidecar verdict JSON.
- **`02-events-attestation.png`** — `/events` (the payload the header renders from) in-browser:
  `"running":true`, `"attestation":{"verified":false,…,"note":"enclave key UNVERIFIED ({…tcb_status:
  \"OutOfDate\", tcb_level_acceptable:false…})"}`.
- **`03-diag-attestation.png`** — `/diag` in-browser: `attestation.verified:false`, note containing
  the full checks object — nine checks true, exactly `tcb_status:"OutOfDate"` +
  `tcb_level_acceptable:false` failing.

Live `/events` at 2026-08-16T15:41:14Z (unchanged through the walk): `verified=false`,
`at=1786894577320` (15:36:17Z), note as above. When a verify passes, `attNote.hidden` is set true
(`an.hidden = j.attestation.verified !== false`) — the note is absent in the verified state by
construction, and the verified transcript in clause 1 shows that state is reachable.

**Hover limitation, named:** the reason-on-hover is a native `title` tooltip; neko's capture does
not paint native chrome tooltips, so the hover shot could not show it. The reason is asserted via
the element's `title` attribute (read in-frame, full JSON) and is visible in `/diag` + `/events`
(shots 02/03). Not fabricated into the page.

## Clause 3 — no unpinned TOFU

```
$ env -u NEAR_WORKLOAD_IDS -u NEAR_IMAGE_DIGESTS -u NEAR_KMS_ROOTS -u NEAR_BASE_MEASUREMENTS \
    ./attest-verify deepseek-ai/DeepSeek-V4-Flash
Error: EmptyPolicy                      # sidecar refuses; policy has no unpinned constructor

$ env -u NEAR_KMS_ROOTS -u NEAR_BASE_MEASUREMENTS bash deploy.sh
deploy.sh: line 18: NEAR_KMS_ROOTS: set NEAR_KMS_ROOTS (see --derive-pins)   # hard fail, no deploy
```

## What I could NOT verify

- `verified:true` **on the staging box** at walk time: NEAR's serving fleet presented
  OutOfDate-TCB nodes to the staging egress all six attempts (this is the degrade path working as
  designed, not a gap in it). The passing ten-check transcript (clause 1) is from the same live
  API and pins, different egress vantage, 13 minutes earlier.
- Native tooltip paint in screenshots (above).
- The Chutes half and pubkey-cache expiry are explicitly out of scope (#105).

## Repro

- Deploy: `brainrot-box/deploy.sh` with `NEAR_{WORKLOAD_IDS,IMAGE_DIGESTS,KMS_ROOTS,BASE_MEASUREMENTS}` (derive: `attest-verify --derive-pins <model>`).
- Degrade: deploy against NEAR fleet state that fails any pin (live TCB drift above), or pin values from an older image.
- State: `GET /goodpoint-box/events` and `GET /goodpoint-box/diag` → `attestation`.
