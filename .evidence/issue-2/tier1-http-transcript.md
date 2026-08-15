# Tier 1 — HTTP transcript (otterscope #2, PR #143)

Added by the rework lane after the auto-merge gate verdict
`automerge-verdict:48d02359e998` ("FAIL Tier1 required (api change): need an HTTP transcript
with /_api/version pinned"). The gate classifies `otterscope/server.ts` (`.ts`) as an API-surface
change; this transcript satisfies Tier 1 on top of the Tier-2 walk already in this directory.

- **Deployed:** webhost-staging `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/otterscope/`
- **Deployed at:** `2026-08-15T17:51:55Z` (after the 17:25Z gate verdict), from git `c0d6fc3`
  (branch `ready-2`, PR #143 head at time of transcript), files `otterscope/{server.ts,project.json}`.
- **Method:** raw `curl` only (no browser, no CDP) against the deployed staging URL.

## 1. `GET /_api/version` (the Constitution's pin endpoint — pasted verbatim)

```
$ curl -sS $S/_api/version
{"version": "dev", "commit": "39c54cc8"}
```

**Caveat, stated plainly:** on this daemon `/_api/version` reports the *daemon's own* commit
(`39c54cc8`, not an object in this repo), not the deployed app's — the same endpoint limitation
#124's transcript documented (there it 500'd). The app pin is therefore carried by the daemon's
deploy record + a reproducible rebuild + behavior pins unique to this branch, below.

## 2. Deploy record — `GET /_api/projects` (authed), `otterscope` entry

```
$ curl -sS -H "Authorization: Bearer $TEE_DAEMON_TOKEN" $S/_api/projects
{
 "name": "otterscope",
 "runtime": "deno",
 "entry": "server.ts",
 "mode": "dev",
 "deployed_at": "2026-08-15T17:51:55.608377+00:00",
 "tree_hash": "757e05469af0be18…58f059c"
}
```

Rebuild from the PR head reproduces this record:

```
tar czf app.tgz --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C otterscope server.ts project.json
curl -fsS -X POST $S/_api/projects -H "Authorization: Bearer $TEE_DAEMON_TOKEN" \
  -F 'manifest={"name":"otterscope","runtime":"deno","entry":"server.ts","mode":"dev","listen":{"port":8080,"protocol":"http"}};type=application/json' \
  -F files=@app.tgz
```

## 3. The served behavior, over HTTP (`GET /otterscope/`)

```
$ curl -sS -D - -o otterscope.live.html $S/otterscope/
HTTP/1.1 200 OK
Content-Type: text/html
Content-Length: 11811

$ grep -c "window\.oauth3" otterscope.live.html   # direct dead-end call — must be 0
0
$ grep -c "api/connect" otterscope.live.html      # SDK web-approve handshake — the new path
3
$ grep -o "build b8" otterscope.live.html         # build string pinned in this branch only
build b8
```

Verbatim from the live response body (the code this PR adds; absent from `staging` base):

```
const prov=globalThis.oauth3 ?? globalThis.window?.oauth3
const cr=await fetch(opts.node+"/api/connect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({plugin:opts.plugin,subject:opts.subject,app:opts.app})});
const s=await (await fetch(opts.node+"/api/connect/"+cb.requestId)).json().catch(()=>({}));
"Open your pod room to approve Otter access"
```

## 4. The new handshake exercised end-to-end over HTTP (no browser)

The exact requests the web fallback makes, driven raw against deployed staging:

```
$ curl -sS -X POST $S/oauth3/api/connect -H 'content-type: application/json' \
    -d '{"plugin":"otter","app":"otterscope"}}'
{"requestId":"req-beb2d431b9ae4c1c8a8490279cdf0db2","approveUrl":"https://…-8080.dstack-pha-prod7.phala.network/oauth3/approve/req-beb2d431b9ae4c1c8a8490279cdf0db2"}
[HTTP 200]

$ curl -sS $S/oauth3/api/connect/req-beb2d431b9ae4c1c8a8490279cdf0db2   # what the page polls
{"status":"pending"}
[HTTP 200]
```

The approve→token leg of this same request flow was walked signed-in (Tier 2, frames 03–05 of
`flow.md`: room approve → `status:"approved"` → token persisted). The request above expires
unapproved — left pending on purpose, no side effects.

## Pin summary
`/_api/version` pasted (daemon commit, caveat above) · daemon record `tree_hash 757e0546…` +
`deployed_at 2026-08-15T17:51:55Z` from a deploy out of `c0d6fc3` · served-content pins
(`window.oauth3`=0, `api/connect`=3, `build b8`, approve-link string) that exist only on this
branch.
