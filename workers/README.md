# OmniCore AI — Cloudflare Worker gateway

A separate Cloudflare-native edition. The upstream Next.js/Node application and its SQLite implementation remain untouched.

## Endpoints

- `GET /health` — public health check.
- `GET /v1/models` — OpenAI-style model list; requires a bearer API key.
- `POST /v1/chat/completions` — OpenAI-compatible chat endpoint with ordered provider fallback.
- `GET /v1/keys` — list active key metadata (never plaintext keys); requires the admin bearer key.
- `GET /v1/providers/health` — admin-only configured-provider and circuit-breaker status; never returns credentials.
- `POST /v1/keys` — create a managed API key; requires the admin bearer key. Defaults to a 90-day expiry; `expires_in_days` accepts 1–365.
- `DELETE /v1/keys/{id}` — revoke a managed API key; requires the admin bearer key.
- `POST /v1/keys/{id}/rotate` — issue a replacement key and revoke the old key in one D1 batch.

## Authentication and key lifecycle

Set `OMNICORE_ADMIN_KEY` as a Cloudflare Worker secret. Use it only for key administration. A managed key is generated with 256 bits of cryptographic randomness, shown once, and stored only as a SHA-256 digest in D1. New keys default to a 90-day expiry; `expires_in_days` accepts 1–365 days. Expired and revoked keys are rejected during authentication. Rotate with `POST /v1/keys/{id}/rotate` (optional JSON `{"expires_in_days":90}`); the replacement is shown once and the previous key is revoked in the same D1 batch. Revoke immediately if exposed.

Example key creation:

```sh
curl -X POST https://YOUR-WORKER/v1/keys \
  -H "Authorization: Bearer $OMNICORE_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"my app"}'
```

Revoke by the returned ID:

```sh
curl -X DELETE https://YOUR-WORKER/v1/keys/KEY_ID \
  -H "Authorization: Bearer $OMNICORE_ADMIN_KEY"
```

The optional legacy `OMNICORE_API_KEY` secret remains as a bootstrap compatibility key. Remove it after creating and verifying managed keys. Do not use the admin key for normal inference clients.

## Request protection

- Per-key D1 fixed-window rate limits default to 60 requests per 60 seconds. Tune with `RATE_LIMIT_REQUESTS` and `RATE_LIMIT_WINDOW_SECONDS`.
- Rate limiting fails closed with HTTP 503 if D1 cannot enforce the counter.
- Managed-key authentication returns HTTP 401 only for invalid/revoked credentials; D1 lookup outages return HTTP 503 with `Retry-After`.
- Admin key listing returns HTTP 503 if its D1 query fails; it never falls back to exposing stored key hashes.
- Request body cap: 1 MiB.
- CORS is disabled by default. Set `CORS_ALLOWED_ORIGINS` to comma-separated exact origins; wildcard origins are not supported.
- Never log or store plaintext keys, provider credentials, prompts, or completions.

## Provider reliability

Providers: Workers AI, OpenAI-compatible endpoint, and Gemini OpenAI-compatible endpoint. Configure credentials only as Worker secrets. Set `FALLBACK_ORDER` to a comma-separated order.

Transient HTTP failures receive one bounded retry, honoring numeric or HTTP-date Retry-After values with a 1.5-second cap. Provider diagnostics are available through the admin-only `GET /v1/providers/health` endpoint; it reports configured providers and circuit state without exposing credentials. This is circuit-state visibility, not an active upstream health probe. Provider response bodies and exception messages are excluded from aggregate failure logs. Credential/model endpoint errors (401/403/404) may fall through to the next configured provider. Other client errors stop fallback. A D1-backed circuit breaker opens after 3 provider failures for 60 seconds by default; tune with `CIRCUIT_FAILURE_THRESHOLD` and `CIRCUIT_OPEN_SECONDS`. Successful calls reset that provider's circuit state.

The upstream fetch deadline is 25 seconds. A failure after streaming response headers have been returned cannot safely be retried through another provider. Workers AI remains non-streaming in this version.

## D1 and migrations

Apply migrations in order: `0001_init.sql`, `0002_rate_limits.sql`, `0003_identity_and_circuit_breakers.sql`, `0004_usage_key_attribution.sql`. The hourly cleanup trigger is configured in `wrangler.toml` and becomes active only after deployment. D1 stores usage metadata (including API-key attribution), hashed API keys, rate-limit counters, and circuit state. Provider secrets and admin credentials must remain Worker secrets, never D1 or Git.

An hourly Worker Cron trigger removes rate-limit windows older than 48 hours and stale, closed circuit rows older than 24 hours. Revoked key records and usage events are retained for audit; no automatic deletion is configured for those records.

## Tests and validation

From this directory with Node 24+:

```sh
node --experimental-strip-types --test src/index.test.ts
npm install --no-save --no-package-lock
npx vitest run --config vitest.config.ts
npx wrangler types
npx wrangler deploy --dry-run
```

GitHub Actions runs the mocked unit suite, the Workers Vitest integration suite against local Miniflare D1, SQLite migration/backfill validation, and Wrangler dry-run. The dry-run does not deploy. See [D1 integration testing strategy](D1_INTEGRATION_TEST_PLAN.md) and [security review](SECURITY_REVIEW.md).

## Deployment gate and limitations

No deployment, D1 creation, secrets, billing activation, or paid service has been performed. Review [deployment readiness](DEPLOYMENT_READINESS.md) and [security review](SECURITY_REVIEW.md) before any future deployment. `wrangler.toml` contains a placeholder D1 ID and must not be deployed until a real database is provisioned and migrations are applied. Confirm provider pricing/free quotas before use.

This is a hardened development build, not a production certification. Live provider tests, Workers AI streaming, per-tenant quotas/plans, live provider tests, scheduled retention behavior in a deployed environment, and deeper D1 integration/concurrency tests remain follow-up work.
