# OmniCore AI — Cloudflare Worker gateway

This is a separate Cloudflare-native edition. The upstream Next.js/Node application and its SQLite implementation remain untouched.

## Included endpoints

- `GET /health` — unauthenticated health check.
- `GET /v1/models` — OpenAI-style model list; requires a bearer API key.
- `POST /v1/chat/completions` — OpenAI-compatible chat request with ordered provider fallback.

## Security and request controls

- Gateway requests require one configured bearer key; malformed or absent bearer credentials are rejected.
- API key comparison uses SHA-256 digests and a constant-time byte comparison.
- Chat request bodies are capped at 1 MiB.
- D1-backed fixed-window rate limiting defaults to 60 requests per 60 seconds. Set `RATE_LIMIT_REQUESTS` and `RATE_LIMIT_WINDOW_SECONDS` to tune it.
- Rate limiting fails closed with HTTP 503 if D1 cannot atomically update the counter.
- CORS is disabled by default. Set `CORS_ALLOWED_ORIGINS` to a comma-separated exact-origin allowlist; wildcard origins are not supported.
- Do not log or store API keys, provider credentials, prompts, or completions.

## Providers and fallback

- Cloudflare Workers AI binding (`WORKERS_AI`).
- OpenAI-compatible endpoint (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`).
- Gemini OpenAI-compatible endpoint (`GEMINI_API_KEY`).

Set `FALLBACK_ORDER` to a comma-separated order, for example `workers-ai,openai,gemini`. A provider is skipped if its credential/binding is absent. Transient failures (408, 425, 429, and selected 5xx responses) receive one bounded retry before the next provider is attempted. Non-retryable 4xx responses stop fallback because they usually indicate an invalid request or provider configuration. Provider model compatibility varies; validate selected models with each provider.

The OpenAI-compatible fetch uses a 25-second abort deadline that remains active while the response body is consumed. A response stream that fails after headers have been returned cannot safely be retried through another provider.

## Persistence and secrets

D1 stores usage metadata and fixed-window rate-limit counters. Never put provider credentials or the gateway API key in D1, source files, GitHub Actions variables, or committed Wrangler configuration. Configure `OMNICORE_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY` with Cloudflare Worker secrets only after deployment is explicitly approved. Configure the D1 database ID in a private deployment environment; the placeholder in wrangler.toml must be replaced before deploy.

Old rate-limit windows are not automatically pruned yet; add a scheduled cleanup only after reviewing the required Worker cron/resource configuration.

## Tests and validation

From this directory, with Node 24 or newer:

```sh
node --experimental-strip-types --test src/index.test.ts
npx wrangler types
npx wrangler deploy --dry-run
```

GitHub Actions runs the Worker test suite and Wrangler dry-run on changes to this directory. The dry-run does not deploy.

No deploy command should be run until the owner has reviewed the configuration, confirmed provider pricing/free quotas, and explicitly approved deployment.

## Known limitations

- Workers AI adapter is non-streaming; OpenAI-compatible providers pass through their response stream.
- Authentication currently supports one shared gateway key, not independently revocable user keys.
- Rate limits currently apply to that shared key and use fixed windows; distributed abuse controls and per-customer quotas require a stronger identity and policy layer.
- Usage persistence records provider/model/status, not token counts or prompt/response content.
- A free gateway does not make paid provider inference free. Verify each provider's current eligibility and quotas before use.
