# wiki-read-adapter (Lexi / Janice / TVP / Academy intake)

A production-ready, **read-only**, **role-scoped** Hermes extension that lets the
`lexi` profile fetch pinned-revision canonical Wiki pages through a private
backend API. This is a **new capability** approved by Jon via Deed — not a
repair of an existing service.

## Boundary

- READ-ONLY. The adapter never calls any write endpoint. There is no
  `wiki-write-service` invocation, no Atlas write, no ticket creation, no
  gateway control, no public access, and no broad corporate browsing.
- Restricted to **Lexi's** authorized profile and the canonical Wiki paths
  needed to form a complete Janice campaign intake (Janice / TVP / Academy /
  Atlas-Hermes contract pages).
- Caller profile authorization is enforced against
  `HERMES_GOVERNED_WIKI_ASSIGNMENT_MANIFEST_V1.json` (source-controlled).
- Every retrieval **must** pin a revision before calling. Responses must
  include `canonical_url`, `revision_id`, `revision_sha256`. A missing or
  mismatched revision is a fail-closed error.
- Credential resolution is **central-only**: from Infisical via the
  `WIKI_READ_ADAPTER_BASE_URL` and `WIKI_READ_ADAPTER_API_TOKEN` env keys.
  No secret is read from the local worktree, the prompt, the audit log, or
  the response payload.
- The audit receipt contains `(caller, path, pinned_revision, revision_id,
  revision_sha256, status, observed_at)` and **never** contains source
  content, secrets, tokens, or credentials.

## Architecture

| File | Role |
|---|---|
| `src/manifest.js` | Loads + validates the assignment manifest |
| `src/credential.js` | Resolves the private backend URL/token from env (no fallbacks) |
| `src/authorize.js` | Verifies caller is `lexi` and the requested path is in the allow-list |
| `src/pinned-revision.js` | Computes / verifies the pinned revision and SHA-256 against the live response |
| `src/fetch.js` | Calls the private backend with the required auth + revision header |
| `src/audit.js` | Emits the no-leakage audit receipt |
| `src/cli.js` | Hermes service-gated CLI entry point |
| `test/*.test.mjs` | `node --test` focused unit tests |

## Run

```bash
WIKI_READ_ADAPTER_BASE_URL=https://wiki.tantaholdings.com \
WIKI_READ_ADAPTER_API_TOKEN=$(infisical secrets get WIKI_READ_ADAPTER_API_TOKEN --projectId 585b5bee-a123-4323-bd32-4d924d98b950 --env prod --plain) \
node src/cli.js --caller lexi --path /agents/lexi --pinned-revision da9336f6d3ad456f5b8065e6b8fc53ce7a6ba989
```

## Tests

```bash
node --test test/*.test.mjs
```
