import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.ts";

function makeEnv(overrides: Record<string, unknown> = {}) {
  let count = 0;
  const env = {
    OMNICORE_API_KEY: "test-secret-key",
    RATE_LIMIT_REQUESTS: "5",
    RATE_LIMIT_WINDOW_SECONDS: "60",
    FALLBACK_ORDER: "openai,gemini",
    OPENAI_API_KEY: "openai-test",
    GEMINI_API_KEY: "gemini-test",
    DB: {
      prepare(sql: string) {
        return {
          bind(..._values: unknown[]) {
            return {
              async first() {
                if (sql.includes("rate_limit_windows")) return { request_count: ++count };
                return null;
              },
              async run() { return { success: true }; },
            };
          },
        };
      },
    },
    ...overrides,
  };
  return env as never;
}

function chatRequest(key = "test-secret-key") {
  return new Request("https://omnicore.test/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] }),
  });
}


test("admin can issue a managed key and that key authenticates", async () => {
  const keys = new Map<string, { id: string; key_hash: string; name: string }>();
  const env = makeEnv({
    OMNICORE_ADMIN_KEY: "admin-secret",
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes("SELECT id, key_hash, name FROM api_keys")) {
                  return [...keys.values()].find((key) => key.key_hash === values[0] && !(key as { revoked?: boolean }).revoked) || null;
                }
                if (sql.includes("rate_limit_windows")) return { request_count: 1 };
                if (sql.includes("provider_circuits")) return null;
                return null;
              },
              async run() {
                if (sql.includes("INSERT INTO api_keys")) {
                  keys.set(String(values[0]), { id: String(values[0]), key_hash: String(values[1]), name: String(values[2]) });
                }
                if (sql.includes("UPDATE api_keys")) { const key = keys.get(String(values[1])); if (key) (key as { revoked?: boolean }).revoked = true; }
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  });
  const created = await worker.fetch(new Request("https://omnicore.test/v1/keys", {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ name: "test client" }),
  }), env);
  assert.equal(created.status, 201);
  const data = await created.json() as { api_key: string; id: string };
  assert.match(data.api_key, /^oc_live_[a-f0-9]{64}$/);
  const models = await worker.fetch(new Request("https://omnicore.test/v1/models", {
    headers: { authorization: "Bearer " + data.api_key },
  }), env);
  assert.equal(models.status, 200);
  const revoked = await worker.fetch(new Request("https://omnicore.test/v1/keys/" + data.id, { method: "DELETE", headers: { authorization: "Bearer admin-secret" } }), env);
  assert.equal(revoked.status, 200);
  const rejectedAfterRevoke = await worker.fetch(new Request("https://omnicore.test/v1/models", { headers: { authorization: "Bearer " + data.api_key } }), env);
  assert.equal(rejectedAfterRevoke.status, 401);
});

test("key management rejects non-admin credentials", async () => {
  const response = await worker.fetch(new Request("https://omnicore.test/v1/keys", {
    method: "POST",
    headers: { authorization: "Bearer test-secret-key", "content-type": "application/json" },
    body: JSON.stringify({ name: "unauthorized" }),
  }), makeEnv());
  assert.equal(response.status, 401);
});

test("health endpoint is public", async () => {
  const response = await worker.fetch(new Request("https://omnicore.test/health"), makeEnv());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("models endpoint rejects missing and malformed bearer credentials", async () => {
  const env = makeEnv();
  const missing = await worker.fetch(new Request("https://omnicore.test/v1/models"), env);
  const malformed = await worker.fetch(new Request("https://omnicore.test/v1/models", {
    headers: { authorization: "test-secret-key" },
  }), env);
  assert.equal(missing.status, 401);
  assert.equal(malformed.status, 401);
});

test("chat endpoint rejects invalid credentials before provider calls", async () => {
  const response = await worker.fetch(chatRequest("wrong-key"), makeEnv());
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
});

test("provider fallback proceeds after retryable upstream failures", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls <= 2) return new Response("temporarily unavailable", { status: 503 });
    return Response.json({ id: "ok", choices: [] });
  };
  try {
    const response = await worker.fetch(chatRequest(), makeEnv());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-omnicore-provider"), "gemini");
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("provider authentication failure falls through to the next configured provider", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response("invalid provider credential", { status: 401 });
    return Response.json({ id: "fallback-ok", choices: [] });
  };
  try {
    const response = await worker.fetch(chatRequest(), makeEnv());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-omnicore-provider"), "gemini");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider 400 is not retried or sent to another provider", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("bad request", { status: 400 });
  };
  try {
    const response = await worker.fetch(chatRequest(), makeEnv());
    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rate limit returns 429 with retry metadata", async () => {
  const env = makeEnv({
    RATE_LIMIT_REQUESTS: "1",
    DB: {
      prepare() {
        return { bind() { return { async first() { return { request_count: 2 }; }, async run() { return { success: true }; } }; } };
      },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [] });
  try {
    const response = await worker.fetch(chatRequest(), env);
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) >= 1);
    assert.equal(response.headers.get("x-ratelimit-remaining"), "0");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("open provider circuit skips an unavailable provider", async () => {
  let upstreamCalls = 0;
  const env = makeEnv({
    FALLBACK_ORDER: "openai",
    DB: {
      prepare(sql: string) {
        return { bind(..._values: unknown[]) { return {
          async first() {
            if (sql.includes("rate_limit_windows")) return { request_count: 1 };
            if (sql.includes("provider_circuits")) return { opened_until: Math.floor(Date.now() / 1000) + 120 };
            return null;
          },
          async run() { return { success: true }; },
        }; } };
      },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls++; return Response.json({ choices: [] }); };
  try {
    const response = await worker.fetch(chatRequest(), env);
    assert.equal(response.status, 502);
    assert.equal(upstreamCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("unapproved browser origins receive no allow-origin header", async () => {
  const response = await worker.fetch(new Request("https://omnicore.test/health", {
    headers: { origin: "https://evil.example" },
  }), makeEnv());
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("approved browser origins receive scoped CORS headers", async () => {
  const response = await worker.fetch(new Request("https://omnicore.test/health", {
    headers: { origin: "https://app.example" },
  }), makeEnv({ CORS_ALLOWED_ORIGINS: "https://app.example" }));
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example");
});

test("admin key listing returns active metadata only and never exposes key material", async () => {
  const rows = [
    { id: "active-1", name: "production client", created_at: "2026-11-07T08:00:00.000Z" },
    { id: "active-2", name: "staging client", created_at: "2026-11-06T08:00:00.000Z" },
  ];
  const env = makeEnv({
    OMNICORE_ADMIN_KEY: "admin-secret",
    DB: {
      prepare(sql: string) {
        return {
          bind(..._values: unknown[]) {
            return {
              async first() {
                if (sql.includes("rate_limit_windows")) return { request_count: 1 };
                return null;
              },
              async all() {
                assert.match(sql, /SELECT id, name, created_at FROM api_keys/);
                assert.match(sql, /revoked_at IS NULL/);
                return { results: rows };
              },
              async run() { return { success: true, meta: { changes: 0 } }; },
            };
          },
        };
      },
    },
  });
  const response = await worker.fetch(new Request("https://omnicore.test/v1/keys", {
    method: "GET",
    headers: { authorization: "Bearer admin-secret" },
  }), env);
  assert.equal(response.status, 200);
  const body = await response.json() as { object: string; data: Array<Record<string, unknown>> };
  assert.equal(body.object, "list");
  assert.deepEqual(body.data, rows);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("key_hash"), false);
  assert.equal(serialized.includes("api_key"), false);
  assert.equal(serialized.includes("oc_live_"), false);
  assert.equal(serialized.includes("admin-secret"), false);
});

test("API key listing rejects non-admin credentials", async () => {
  const response = await worker.fetch(new Request("https://omnicore.test/v1/keys", {
    method: "GET",
    headers: { authorization: "Bearer test-secret-key" },
  }), makeEnv());
  assert.equal(response.status, 401);
});

test("API-key database outage returns 503 instead of invalid-key 401", async () => {
  const env = makeEnv({
    OMNICORE_API_KEY: undefined,
    DB: {
      prepare() {
        return { bind() { return { async first() { throw new Error("D1 unavailable"); } }; } };
      },
    },
  });
  const response = await worker.fetch(new Request("https://omnicore.test/v1/models", {
    headers: { authorization: "Bearer oc_live_test-key" },
  }), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "authentication_unavailable");
});

test("chat endpoint returns 503 when managed-key lookup database is unavailable", async () => {
  const env = makeEnv({
    OMNICORE_API_KEY: undefined,
    DB: {
      prepare() {
        return { bind() { return { async first() { throw new Error("D1 unavailable"); } }; } };
      },
    },
  });
  const response = await worker.fetch(chatRequest("oc_live_test-key"), env);
  assert.equal(response.status, 503);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "authentication_unavailable");
});

test("admin key listing returns 503 when D1 is unavailable", async () => {
  const env = makeEnv({
    OMNICORE_ADMIN_KEY: "admin-secret",
    DB: {
      prepare() {
        return { bind() { return {
          async first() { return { request_count: 1 }; },
          async all() { throw new Error("D1 unavailable"); },
        }; } };
      },
    },
  });
  const response = await worker.fetch(new Request("https://omnicore.test/v1/keys", {
    headers: { authorization: "Bearer admin-secret" },
  }), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "key_listing_unavailable");
});
