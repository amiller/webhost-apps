# Pod Apps Audit — deployed vs. documented source

Reconciliation of every app deployed to the tee-daemon pods against a committed source home.
Generated 2026-07-02. **36 deployments, 33 with no re-cloneable `source`** — the visibility gap.

The gap's cause: deploys were pushed from local dirs, zed-built tarballs, or inline content, and the
daemon recorded `source: NONE`. The code mostly *exists* — it just isn't wired as the deploy source,
and several homes are plain dirs, not git repos. `source: NONE` also blocks promotion (an app can't be
attested without a pinned source), which is why almost nothing on pod.dstack is promotable.

## Deployment sprints (from `deployed_at`)
- **Foundational infra — Apr 5–30:** tunnel, feedling-web, probe, vault.
- **Mid-June — Jun 14–18:** aishley, sillyteevern, router-dashboard.
- **★ Gen-2 app sprint — Jun 24–25:** timelock, tinycloud, elaine-dossier, otterscope, listen, listen-fe, otter (7 apps / ~36h; only timelock committed).
- **★ Staging + side-channel demos — Jun 26:** otterscope, screenshare-frames, isolation-probe, rsa-timing-demo, timing-leak-demo, journeys.
- **★ Custom-domain + extension sprint — Jun 30–Jul 2:** oauth3 (pod.dstack cutover), caps-probe, timeline-peek, login-with-everything, browser-pool, feedling-web, teleport-probe, status, report.

## Per-app reconciliation
Status legend: ✅ committed+pushed · 🟡 source on disk (dir, maybe not a repo / not wired) · 🔵 zed-built (loop, not on laptop) · 🔴 daemon-only / lost · ⚪ external product (not our code)

| app | pod(s) | mode | status | source home | notes |
|---|---|---|---|---|---|
| timelock | hermes-staging | attested | ✅ | github.com/amiller/timelock | the model: attested + committed + verifier live |
| oauth3 | pod.dstack, hermes, webhost | dev | ✅ | teleport-computer/oauth3-server (public) | deploy `source` not wired → shows NONE |
| otter | hermes-staging | dev | ✅ | github.com/amiller/otter-importer (public) | |
| tunnel | hermes-staging | dev | ✅ | amiller/dstack-webhost | |
| batch21-static | webhost-staging | dev | ✅ | amiller/dstack-webhost | |
| isolation-probe | webhost-staging | dev | ✅ | tee-daemon/examples/ | already committed as a daemon example |
| rsa-timing-demo | webhost-staging | dev | ✅ | tee-daemon/examples/ | |
| timing-leak-demo | webhost-staging | dev | ✅ | tee-daemon/examples/ | |
| screenshare-frames | hermes, webhost | dev | ✅ | tee-daemon/examples/ | |
| **timeline-peek** | pod.dstack | dev | 🟡→✅ | **webhost-apps/timeline-peek/ (RESCUED 2026-07-02)** | client-side twitter-feed relying-party demo; source was zed/daemon-only, now recovered from the running pod |
| otterscope | pod.dstack, hermes, webhost | dev | 🟡 | teleport/oauth3/otterscope (dir, not a repo) | needs a repo + wired source |
| login-with-everything | webhost-staging | dev | 🟡 | teleport/oauth3/login-with-everything (dir + PRD) | |
| browser-pool | webhost-staging | dev | 🟡 | teleport/oauth3/browser-pool (dir) | see RFC 0028 (render pool) |
| feedling-web | hermes, pod.dstack | dev | 🟡 | teleport/feedling-web + Account-Link/open-feedling-web (public) | reconcile which is canonical |
| aishley | hermes-staging | attested | 🟡 | projects/aishley (verify it's the deployed one) | attested but source not wired — fragile |
| router-dashboard | hermes-staging | dev | 🟡 | webhost-apps/router-dashboard (this repo, local-only) | push this repo |
| teleport-probe | hermes, webhost | dev | 🟡 | webhost-apps/teleport-probe (this repo) | |
| status, report | webhost-staging | dev | 🔵? | likely zed-built (Jul 2) | verify on zed |
| journeys | webhost-staging | dev | 🔵? | likely zed-built | verify on zed |
| caps-probe | pod.dstack | dev | 🔴? | none found local; probe-family | verify (webhost-apps has brave-probe) |
| probe | hermes-staging | attested | 🔴 | none found | **attested + no source = worst case; rescue** |
| cadence | hermes-staging | dev | 🔴 | none found | rescue from daemon disk |
| elaine-dossier | hermes-staging | dev | 🔴 | none found (cf. teleport/onboard-elaine?) | rescue |
| listen-fe | hermes-staging | dev | 🔴 | none found (listen frontend) | rescue |
| tinycloud | hermes-staging | attested | ⚪ | external product (image) | not our source |
| listen | hermes-staging | dev | ⚪ | external (clone) | not our source |
| vault, schedule, sillyteevern | hermes-staging | dev | 🟡? | uncertain local matches (elizaos/lora-chutes) — verify | false-positive risk |

## Rescue priority (time-sensitive: 🔴 apps live only on daemon disk)
1. **timeline-peek — DONE** (rescued to this repo).
2. **probe** (🔴 **attested** with no source — highest risk) and **cadence, elaine-dossier, listen-fe, caps-probe** — pull from the daemon disk (RFC 0017 export, or fetch served content for static apps) before any volume loss.
3. **status/report/journeys** — pull from zed (loop-built) once SSH is back.
4. Give the 🟡 dir-only apps a repo home (this monorepo) + wire deploy `source` → makes them promotable.

## The monorepo
`webhost-apps/` is a local git repo (has REGISTRY.md, router-dashboard, teleport-probe, redteam-channel, brave-probe) with **no GitHub remote** — never pushed. It's the natural home for the showable apps. Give it a remote + push, fold in the rescued/dir-only apps.
