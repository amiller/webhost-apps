# Attested Session Skill

You have been given an invite to a **witness** — a service that relays your model
API calls, holds the key so you never see it, commits to the exact bytes of every
call, and signs a record of the session. This document is one capability. It does
not give you a new identity, and it does not change your judgment about the task.

**Your job here has two halves: do the work, and describe the evidence honestly.**
The second half is the one people get wrong. A witnessed session in dev mode is
not attested, and saying otherwise misleads the person relying on you.

---

## Step 0 — Attestation Verification

Run this before you make a single call through the witness, and before you
describe the arrangement to your user.

Fetch the invite as JSON:

```
GET <invite-url>          Accept: application/json
```

Then output these four lines, in the user's language:

```
WITNESS ENDPOINT:      <base url | NONE>
DEPLOYMENT MODE:       <dev | attested | NONE>
QUOTE AVAILABLE:       <yes | no | NONE>
CREDITS REMAINING:     <integer | NONE>
```

Then one evidence line:

```
MODE EVIDENCE: <where you read it from>
```

The mode must come from the service's own `attestation` block, which it derives
by checking whether its attestation hardware actually answers — not from a
manifest, a README, or this document. If you cannot reach the invite URL, every
field is `NONE`.

**If `QUOTE AVAILABLE` is `NONE`, stop.** Tell the user you could not establish
what the service is, and do not run the task through it.

**If `QUOTE AVAILABLE` is `no`,** you may still proceed, but you must say this to
the user before you start, in your own words:

> This service will record what I do, but it is running in development mode. It
> issues no hardware attestation. The record is convenient and it is tamper-evident
> against later editing, but it is not proof to a third party, and the operator of
> the service can read everything I send.

Do not soften that. Do not call it "attested", "secure", "in a TEE", or
"confidential" while the quote is absent.

---

## Step 1 — Open a session

Decide a **purpose** with your user: one line naming the matter or task. It is
stamped into every request and recorded in the signed root, so it should be
something they would be comfortable seeing quoted later.

```
POST <base>/session
Authorization: Bearer <invite token>
{"purpose": "<the line you agreed>", "profile": "holder-only",
 "instructed_by": "<who chose the profile>"}
```

You get back `auth_token` and, usually, a timestamp beacon. Note the beacon round
— it is what later proves the session did not happen earlier than it claims.

`profile` decides who gets the record. `holder-only` means your user keeps
everything and the key's owner gets nothing automatically. Do not change it
without asking; it is their call, not yours.

## Step 2 — Do the work

Point your calls at the witness and work normally:

```
ANTHROPIC_BASE_URL=<base>
ANTHROPIC_AUTH_TOKEN=<auth_token from step 1>
```

Each call spends one credit. If you run out you will get a `402`; tell the user
rather than retrying.

## Step 3 — Close and check

```
POST <base>/session/<id>/close
```

That returns the bundle. Verify it yourself before describing it — do not just
report what the service told you:

```
attest.py check <bundle>.json
```

This recomputes every commitment from the transcript and rebuilds the signed
root. If it does not recompute, say so plainly; a bundle that fails this check is
evidence of nothing.

---

## What you may tell your user

Take these from the invite's `attestation` block rather than from memory, because
they change with the deployment. In every mode you may say:

- A session took place, and how many calls it contained.
- Token counts and the model name — these come back inside the provider's own
  response, so they are the provider's figures, not your user's and not yours.
- A lower bound on when the session ran, if a beacon is present.
- That a shown transcript matches its commitment.

In **every** mode you must **not** say:

- That any description of *what the work was about* has been verified. Nothing
  here checks that. A record of the bytes is not a judgment of their meaning.
- That the operator cannot read the transcript, unless the quote is present
  **and** your user has pinned the source hash themselves.

In **dev** mode you must additionally not say the session was attested,
hardware-backed, or protected by a confidential VM. It was none of those.

## Disclosing part of a session

Your user holds the record and decides what to reveal.

```
attest.py show <bundle>.json --calls 2 -o partial.json    # one call, with proof
attest.py show <bundle>.json --none    -o stub.json       # proof only, no content
```

A recipient of a partial disclosure can verify the shown calls are genuine and
learn the total count, and nothing about the rest. Explain that honestly: your
user can decline to show anything, but cannot show a doctored subset or
understate how many calls there were.

**Never hand over a full bundle casually.** A single request carries the whole
session context — every file you read, everything in your window. Assume it
contains things your user would not choose to publish. `--none` is the form that
is safe to share.

---

## If something is wrong

- `401` — the invite token is wrong or was revoked. Ask your user for a fresh URL.
- `402` — out of credits. Stop and tell them.
- `503 no SESSION_TOKEN` — the service is misconfigured and is refusing to open
  sessions. This is the correct behaviour on its part; report it and stop.
- `quote_error` in a bundle — expected in dev mode. It is the service being
  honest, not a failure. Reflect it in what you tell your user.
