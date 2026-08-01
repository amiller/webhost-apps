# PLAN — issue #72: screenshare-debug compute panel

Base: `origin/staging` (cee4c20) → branch `ready-72`. One issue, then stop.

## Scope decision (binding: box-inventory.md scope-down rule)
#72's full acceptance builds on the **change-detection foundation = issue #71**, which has an
**open, unmerged PR #100** (`ready-71`→staging). `staging` has NO diff/tile/change-detection pipeline
(it's the UCAN/consent build). So the parts of #72 that require #71 — the **tile-delta wire format**,
**delta-vs-full bandwidth**, and **reassembly error row** (acceptance bullets 3 & 4) — cannot be
verified on base=staging and would duplicate #71's detector.

Per the scope-down rule, `blocked` is ONLY for zero-verifiable-progress. A verifiable subset of #72
exists without #71 → SHIP IT, comment the rest to the issue.

## Shipped this PR (verifiable on staging, no #71 dependency)
- [x] Per-stage client CPU timing — wrap draw / encode(toBlob) / POST(fetch) with performance.now();
      EMA per stage; diff stage rendered "n/a — pending #71".
- [x] Duty-cycle % — pipeline ms / 600 ms frame interval.
- [x] Bandwidth accounting — bytes/frame (EMA), bytes/min, frame-kind split
      (full frames live; heartbeat/keyframe present but 0 until #71).
- [x] Encoding comparison — JPEG(q0.6)/WebP(q0.6)/PNG via toBlob, feature-detecting WebP; AVIF N/A.
- [x] Format toggle — full-jpeg (live) / tile-delta (disabled, "needs #71").
- [x] Metadata table — fmt + ms columns added.
- [x] window.__ssdebug headless driver extended with the new stats for bridge assertion.

## Deferred to #71 (commented on the issue + PR)
- [ ] tile-delta wire format (POST only changed tiles; sink reassembles; echo shows composite).
- [ ] delta-bytes vs full-frame-bytes per frame + cumulative savings %.
- [ ] reassembly-failure error row.

## Verify
- [x] node --check on extracted inline JS — OK.
- [x] DOM-id coverage — every $(...) id exists in markup.
- [x] deno check server.ts + ucan.ts (unchanged) — clean.
- [x] Local real-handler serve: GET / 200 + 25/25 #72 markup strings present; /health, /authority OK.
- [ ] Tier 2 live screenshot via envoy bridge — BLOCKED this iteration (bridge wsClients:0).
