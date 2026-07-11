# PLAN — issue #64 (reddit-karma: render real reddit data via /items)

## Acceptance (from issue #64)
On staging reddit-karma, signed in as `u-swarm`, after Connect, the page shows the
account's REAL reddit content (recent saved posts with subreddits/titles + a count)
fetched via `GET /api/reddit/items` with the scoped token — NOT an error. No mock, no
fallback — a failed read renders the real error.

## Interface contract (issue #64, verified against staging)
`GET /oauth3/api/reddit/items` `Authorization: Bearer <scoped token>`
-> `{plugin:"reddit", data:[{id,title,date,meta:{subreddit,...}}]}` (key is `data`, not `items`).
`GET /oauth3/api/reddit/account` -> 404 "not found" (the bug). `/items` -> 200 with data
when a reddit jar is synced; 409 `{"error":"no jar synced for reddit"}` when not.

## Probes done
- /account → 404 not found (confirms the bug).
- /items → 409 "no jar synced for reddit" (endpoint live; rig subject u-eaf13541… has
  links:[] — no reddit jar). Jar sync needs a real reddit_session cookie (operator cred).

## Checklist
- [x] Read AGENTS/README, confirm contract against staging.
- [x] index.html: fetchKarma→fetchItems, endpoint /api/reddit/items, parse body.data[].
- [x] renderItems: count + list of saved posts (subreddit + title + date), no mock.
- [x] Failure renders the REAL error (renderError unchanged, no fallback).
- [x] Copy/evidence/README reflect saved-posts + /items; BUILD bump.
- [x] node/parse check the changed HTML.
- [ ] Deploy reddit-karma to staging daemon.
- [ ] Tier 2: drive real browser signed-in as u-swarm → Connect → screenshot the real
      rendered state (items if jar present, else the real 409 error — both honest).
- [ ] Commit .evidence/issue-64/*, PR body embeds screenshots, comment jar-sync back.

## Verification reality (honest)
The code change is fully verifiable. Live REAL saved posts require the operator to sync
a reddit session jar (POST /api/cookies with a real reddit_session cookie) for the rig
subject — an operator credential I cannot fabricate. I verify: (a) the app now calls
/items not /account, (b) the failure path renders the real 409 error (no fallback),
(c) the render-items code matches the documented contract shape. The "real content"
step is commented back to the issue as operator-run.
