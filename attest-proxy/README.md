# attest-proxy — moved

This app graduated to its own repo:

**<https://github.com/amiller/attest-proxy>**

It earned an independent release lifecycle: it has a client (`attest.py`), an
agent-facing skill that outside agents fetch by URL, and a deploy that is
promoted to attested — none of which want to be versioned alongside the rest of
the monorepo.

Deploy it from source instead of a tarball:

```bash
curl -X POST $CVM/_api/projects \
  -H "Authorization: Bearer $TEE_DAEMON_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"attest-proxy","source":"https://github.com/amiller/attest-proxy","ref":"main"}'
```

Note that a redeploy resets the project to `dev` and must be re-promoted.
