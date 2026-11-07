# D1 integration testing strategy

## Current validation layers

1. **Fast unit tests** (`src/index.test.ts`): mocked D1 and fetch. These prove request handling, policy branches, and atomic SQL shape, but do not prove D1 runtime behavior.
2. **Migration compatibility**: CI applies all five SQL migrations to in-memory SQLite, checks the resulting schema, and verifies that existing managed keys receive a 90-day expiry backfill.
3. **Worker + D1 integration** (`src/d1.integration.test.ts`): Cloudflare Workers Vitest plugin runs the actual Worker module in the Workers runtime with a local Miniflare D1 binding. It uses `wrangler.test.toml`, a D1-only test config that deliberately omits the Workers AI binding because AI bindings require remote service access and cannot be simulated locally. The suite applies the real migration files and exercises persisted key creation, hash-only storage, key rotation/revocation, and concurrent rate-limit requests through HTTP handlers.
4. **Remote D1 staging**: not enabled. A separately approved staging database is required to validate Cloudflare-hosted D1 behavior, remote concurrency, operational limits, backups, and migration rollback. Do not provision a database or apply remote migrations as part of ordinary CI.

## Running locally

From this directory with Node 24+:

```sh
npm install --no-save --no-package-lock vitest@^4.1.0 @cloudflare/vitest-plugin
npx vitest run --config vitest.config.ts
```

The Vitest integration runs locally through Miniflare/workerd. It is a stronger D1 integration check than a mocked database, but it is still not a remote Cloudflare D1 test or a production load test.

## Release gate

- Keep unit tests, SQLite migration/backfill validation, Miniflare D1 integration tests, and Wrangler dry-run green.
- Before production, run a separately approved remote-D1 smoke test on a dedicated staging database after confirming plan, limits, region, and cost.
- Exercise migrations from an existing populated schema, concurrent requests, key expiry/rotation, rate-limit fail-closed behavior, circuit state, and scheduled cleanup.
- Capture a backup and a rollback/recovery procedure before any production migration.
- Never use production API keys, provider credentials, prompts, or user data in test fixtures.

## References

- [Cloudflare Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Cloudflare D1 migration testing recipe](https://developers.cloudflare.com/workers/testing/vitest-integration/recipes/)
- [Cloudflare testing overview and Miniflare security notes](https://developers.cloudflare.com/workers/testing/)
