# OmniCore Worker security review

Review scope: Cloudflare Worker adaptation on the `cloudflare-adaptation` branch. This is an engineering review of the repository state, not an independent penetration test or production certification.

## Controls implemented

- Managed API keys use 256 bits of cryptographic randomness; only SHA-256 digests are stored in D1. Plaintext is returned once at issuance/rotation.
- Managed keys default to a 90-day expiry, support a 1–365 day range, and are rejected when expired or revoked. Migration 0005 backfills existing managed keys to a 90-day lifetime.
- Rotation uses a D1 batch to insert a replacement only while the old key remains active, then revoke the old key.
- Admin credentials are separate from managed inference credentials. The admin secret is accepted only on administrative endpoints, not models/chat inference.
- D1 authentication failures return 503; rate-limit persistence failures fail closed with 503.
- Chat bodies are bounded while streaming reads (1 MiB); key-management JSON bodies are bounded to 4 KiB.
- Per-key fixed-window rate limits use one atomic D1 upsert. Responses include 429 and Retry-After metadata.
- CORS uses an exact-origin allowlist; wildcard origins are not supported.
- Provider retry is bounded; Retry-After numeric/date values are capped. Provider response bodies and exception messages are excluded from aggregate failure logs.
- Provider credentials/admin secrets are intended for Worker secrets, not Git or D1. Prompts and completions are not persisted.
- Provider health diagnostics are admin-only and return circuit metadata, not credentials.

## Residual risks and required controls

| Area | Current state | Required before production |
|---|---|---|
| Bootstrap credential | Optional legacy `OMNICORE_API_KEY` bypasses managed-key expiry and D1 lookup until removed | Create and verify managed keys, then remove bootstrap secret |
| Admin secret | Static Worker secret, no in-product admin-key rotation | Generate high-entropy value; document controlled secret rotation and emergency recovery |
| Rate limiting | Per-key fixed window only | Add abuse/budget controls appropriate to expected exposure; consider IP/tenant limits |
| Circuit breaker | D1 circuit lookup failure is fail-open to preserve availability; half-open probes are not single-flight | Validate behavior under remote D1 outage and decide whether stricter fail-closed policy is required |
| Streaming | Upstream streaming response is passed through; failures after headers cannot be retried or reliably recorded | Add streaming interruption tests and document client retry behavior |
| Provider validation | Provider credentials/models/quotas are not live-tested | Validate each provider, model mapping, quota and terms in a separately approved staging setup |
| CORS | Exact allowlist is implemented; admin key routes are intended for backend use and do not provide browser CORS headers | Keep admin operations server-side; only add browser admin UI with a separate threat review |
| Retention | Usage metadata and revoked-key audit records are retained indefinitely; no prompts/completions are stored | Set and document a retention period before real customer usage |
| Operational recovery | No remote D1 backup/restore or rollback rehearsal | Rehearse backups, migration rollback/recovery, and scheduled cleanup in staging |

## Verification evidence

- Unit tests cover auth separation, malformed/invalid keys, expiry query behavior, key issuance/rotation, revocation, body-size limits, provider fallback/circuits, D1 failure semantics, and rate-limit concurrency logic.
- Migration checks apply the ordered SQL files to SQLite and validate schema/backfill behavior.
- Cloudflare Workers Vitest + Miniflare D1 integration tests are being added to exercise real Worker handlers against a local D1 runtime.
- Wrangler dry-run builds the Worker bundle only; it does not deploy.
- Remote D1, live providers, production traffic, security scanning, penetration testing, and production security certification have not been performed.

## Release decision

**Not production-approved yet.** Keep deployment blocked until the D1 integration suite and CI pass, remote staging checks are separately approved, provider pricing/quotas are verified, and the residual controls above are reviewed. The D1 UUID in `wrangler.toml` remains a placeholder. No Cloudflare database, secrets, billing, or deployment has been created or changed by this review.
