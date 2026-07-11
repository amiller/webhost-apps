# Evidence — issue #64 · reddit-karma: render saved posts via /items

**Tier 2 (user-visible).** Driven through the **envoy bridge real browser** (Brave + the
oauth3 extension) against the **deployed staging** app at
`https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/reddit-karma/`
(build `b3`, committed on `ready-64` and POSTed to the staging daemon).

## Asserted acceptance (from issue #64)
> On the staging reddit-karma page, after connecting as the rig identity, the page shows the
> account's REAL reddit content (recent saved posts with subreddits/titles + a count) fetched
> via `GET /api/reddit/items` … No mock, no fallback — a failed read renders the real error.

## What was verified LIVE (real flow, real staging)
| step | screenshot | asserted at capture via `evaluate()` |
|---|---|---|
| 1. Open `/reddit-karma/` | `01-initial.png` | `document.title`="Reddit Saved" · `BUILD`=b3 · diag="build b3 · instance: reachable · reddit plugin registered · extension present" |
| 2. Click **Connect with OAuth3** | `02-consent-dialog.png` | extension consent dialog present; approve button text="Connect" |
| 3. Approve → app reads `/api/reddit/items` | `03-read-result.png` | card stamp="error", title="No saved posts to show", evidence block: `endpoint GET …/oauth3/api/reddit/items · status 409 · token tok-reddit-1… · reason read failed: no jar synced for reddit` |
| 4. Render-correctness check (labeled, NOT live data) | `04-render-check.png` | the app's OWN `renderItems()` fed the documented contract shape → title="Saved posts", "3 saved · reddit:saved", stamp="live", 3 rows, first="r/movies The Batman review — a noir reinvention · Jun 10, 2024" |

## What this proves
1. **The endpoint switch landed and is live**: the evidence block names
   `GET …/oauth3/api/reddit/items` (was `/account`, which 404s).
2. **No mock / no fallback**: the real `409 {"error":"no jar synced for reddit"}` is rendered
   verbatim in the card + evidence block — no fake posts, no empty "0 saved".
3. **The success-render path is correct**: `renderItems()` renders the documented
   `{id,title,date,meta:{subreddit}}` shape as subreddit + title + date + a count (step 4).

## What I could NOT verify (operator-run, commented back to the issue)
Showing the rig identity's **REAL saved posts** (step 3 = `live` + populated list) requires a
synced reddit session jar (`reddit_session` cookie) in the TEE for the connecting subject.
Today **no reddit jar is synced for any subject reachable from this box**:
`GET /oauth3/api/reddit/items` with a freshly minted scoped token returns
`409 {"error":"no jar synced for reddit"}` for every subject I can log in as (the shared
`swarm-userkey` → `u-eaf13541…`; the extension self-provisions `u-d0e71e03…`). Jars are synced
owner-side via `POST /oauth3/api/cookies {plugin:"reddit", cookies:{reddit_session:…}}` and need
a real logged-in reddit account's cookies — an operator credential I cannot fabricate and will
not mock. So the **live** flow honestly renders the real 409 (which is itself acceptance
behavior — "a failed read renders the real error"); the populated-list state is demonstrated
only via the labeled render-correctness check (step 4).

## Probes (curl against staging, before coding)
- `GET /oauth3/api/reddit/account` → `404 not found` (the bug; route never shipped).
- `GET /oauth3/api/reddit/items` (Bearer scoped token) → `409 {"error":"no jar synced for reddit"}`
  (endpoint live; contract `{plugin,data:[…]}` per oauth3-server#83).
- `GET /oauth3/api/me` → `links:[]` (no reddit jar for the rig subject).

## Parse check
`node --check` on the inlined `<script>` → rc 0. No `/account` reference remains in the
active code (only in the explanatory top-of-file comment).
