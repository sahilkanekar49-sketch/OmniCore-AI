# OmniCore AI — Cloudflare Worker gateway

This is a separate Cloudflare-native edition. The upstream Next.js/Node application and its SQLite implementation remain untouched.

## Included endpoints

- `GET /health` — unauthenticated health check.
- `GET /v1/models` — OpenAI-style model list; requires a bearer API key.
- `POST /v1/chat/completions` — OpenAI-compatible chat request with ordered provider fallback.

## Providers

- Cloudflare Workers AI binding (`WORKERS_AI`).
- OpenAI-compatible endpoint (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`).
- Gemini OpenAI-compatible endpoint (`GEMINI_API_KEY`).

Set `FALLBACK_ORDER` to a comma-separated order, for example `workers-ai,openai,gemini`. A provider is skipped if its credential/binding is absent. Provider model compatibility varies; validate the selected model with each provider.

## Persistence and secrets

D1 stores request usage metadata only. Never put provider credentials or the gateway API key in D1, source files, GitHub Actions variables, or committed Wrangler configuration. Configure `OMNICORE_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY` with Cloudflare Worker secrets when deployment is approved. Configure the D1 database ID in a private deployment environment; the placeholder in wrangler.toml must be replaced before deploy.

## Local development / validation

From this directory:

```sh
npx wrangler types
npx wrangler deploy --dry-run
```

No deploy command should be run until the owner has reviewed the configuration, confirmed provider pricing/free quotas, and explicitly approved deployment.

## Current limitations

- Workers AI adapter is non-streaming; OpenAI-compatible providers pass through their response stream.
- Usage persistence records provider/model/status, not token counts or prompt/response content.
- The current API key authentication uses one configured gateway key. Per-user key management, quotas, rate limiting, encrypted provider credential storage, retries with exponential backoff, and D1-managed routing policies are planned follow-ups.
- A free gateway does not make paid provider inference free. Verify each provider's current eligibility and quotas before use.
