# OmniCore AI — Cloudflare Worker gateway

A separate Cloudflare-native edition. The upstream Next.js/Node application and its SQLite implementation remain untouched.

## Endpoints

- `GET /health` — public health check.
- `GET /v1/models` — OpenAI-style model list; requires a bearer API key.
- `POST /v1/chat/completions` — OpenAI-compatible chat endpoint with ordered provider fallback.
- `GET /v1/keys` — list active key metadata (never plaintext keys); requires the admin bearer key.
- `POST /v1/keys` — create a managed API key; requires the admin bearer key.
- `DELETE /v1/keys/{id}` — revoke a managed API key; requires the admin bearer key.

## Authentication and key lifecycle

Set `OMNICORE_ADMIN_KEY` as a Cloudflare Worker secret. Use it only for key administration. A managed key is generated with 256 bits of cryptographic randomness, shown once, and stored only as a SHA-256 digest in D1. Revoke it immediately if exposed.

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
- Request body cap: 1 MiB.
- CORS is disabled by default. Set `CORS_ALLOWED_ORIGINS` to comma-separated exact origins; wildcard origins are not supported.
- Never log or store plaintext keys, provider credentials, prompts, or completions.

## Provider reliability

Providers: Workers AI, OpenAI-compatible endpoint, and Gemini OpenAI-compatible endpoint. Configure credentials only as Worker secrets. Set `FALLBACK_ORDER` to a comma-separated order.

Transient HTTP failures receive one bounded retry, honoring a capped Retry-After delay. Credential/model endpoint errors (401/403/404) may fall through to the next configured provider. Other client errors stop fallback. A D1-backed circuit breaker opens after 3 provider failures for 60 seconds by default; tune with `CIRCUIT_FAILURE_THRESHOLD` and `CIRCUIT_OPEN_SECONDS`. Successful calls reset that provider's circuit state.

The upstream fetch deadline is 25 seconds. A failure after streaming response headers have been returned cannot safely be retried through another provider. Workers AI remains non-streaming in this version.

## D1 and migrations

Apply migrations in order: `0001_init.sql`, `0002_rate_limits.sql`, `0003_identity_and_circuit_breakers.sql`, `0004_usage_key_attribution.sql`. D1 stores usage metadata (including API-key attribution), hashed API keys, rate-limit counters, and circuit state. Provider secrets and admin credentials must remain Worker secrets, never D1 or Git.

Old rate-limit windows and revoked key records are retained for audit and storage control; scheduled retention cleanup is not enabled yet.

## Tests and validation

From this directory with Node 24+:

```sh
node --experimental-strip-types --test src/index.test.ts
npx wrangler types
npx wrangler deploy --dry-run
```

GitHub Actions runs the Worker test suite and Wrangler dry-run. The dry-run does not deploy.

## Deployment gate and limitations

No deployment, D1 creation, secrets, billing activation, or paid service has been performed. `wrangler.toml` contains a placeholder D1 ID and must not be deployed until a real database is provisioned and migrations are applied. Confirm provider pricing/free quotas before use.

This is a hardened development build, not a production certification. Live provider tests, Workers AI streaming, per-tenant quotas/plans, managed key listing/rotation, scheduled retention cleanup, and deeper D1 integration tests remain follow-up work.
