# attest-proxy

Witnessed agent sessions. Your agent runs with no credential; this service holds
the key, relays every call, commits to the exact bytes, and signs a Merkle root
over the session — so you can prove what you spent and on what, without showing
the transcript.

Live: https://pod.dstack.soc1024.com/attest-proxy/

## Why

The claim "I spent 5M tokens of model X reviewing your contract" splits in two.
The metered half — token counts, model name, call count, a lower bound on when —
is attestable with no LLM in the loop: those figures come back inside Anthropic's
own response, over a TLS session this service terminated against a pinned root.
They are Anthropic's statement, not the holder's.

The characterisation half — *what the work was about* — needs a checker run over
the private transcript, and attestation would show the checker ran, not that its
verdict was right. Keep the two apart when presenting a receipt.

## Use

```bash
export ATTEST_CVM=https://pod.dstack.soc1024.com
export ATTEST_INVITE=$(cat ~/.claude/attest-proxy-invite-token)

./attest.py run --purpose "[research-router] Acme — contract review" \
  -- claude -p "what should I ask about the IP clause?"

./attest.py check attest-<id>.json          # recompute everything offline
./attest.py show  attest-<id>.json --calls 2 -o partial.json
./attest.py show  attest-<id>.json --none   -o stub.json    # proof, zero content
```

`attest.py` needs only the standard library and talks to the hosted service, so
it works with no hardware. The same bundles verify against the SiLabs board
build in `edge-tee/silabs-secure-vault/zktls` — the commitment and Merkle
constructions are byte-identical, and only the signature over the root differs
(a TDX quote here, a PSA IAT there).

Do not publish full bundles. A single agent turn's request carries the whole
session context, including local config files the agent read. `--none` is the
form that is safe to hand out.

## Deploy

```bash
TEE_DAEMON_TOKEN=... CVM=https://pod.dstack.soc1024.com \
  ANTHROPIC_API_KEY=sk-... bash deploy.sh
```

The key and the invite token travel only in the deploy POST's manifest, never in
committed source. Env values are redacted on the daemon's public verifier path,
so promoting the project does not expose them.

**The session endpoint is reachable from the internet and spends a real key**, so
the app refuses to open sessions at all unless `SESSION_TOKEN` is set, and caps
calls per session (`MAX_CALLS`, default 50). `deploy.sh` generates the invite
token once into `~/.claude/attest-proxy-invite-token`.

## Status

`mode: dev`, so `GetQuote` is unavailable — the broker socket is only mounted for
attested projects, and bundles carry `quote: null` with `quote_error` rather than
anything that looks attested. Promote to turn that on:

```bash
curl -X POST $CVM/_api/projects/attest-proxy/promote -H "Authorization: Bearer $TEE_DAEMON_TOKEN"
```

Promotion binds the source hash into the quote and opens the public verifier
endpoints. A counterparty should check the quote binds a CVM measurement they
accept *and* this app's source hash, then pin that hash — the operator holds
deploy rights, so pinning and re-checking is what makes a swap visible rather
than silent.
