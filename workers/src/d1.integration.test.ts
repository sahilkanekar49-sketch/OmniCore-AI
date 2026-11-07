import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function createManagedKey(name: string): Promise<{ id: string; api_key: string; expires_at: string }> {
  const response = await exports.default.fetch(new Request("https://omnicore.integration/v1/keys", {
    method: "POST",
    headers: { authorization: "Bearer local-integration-admin", "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }));
  expect(response.status).toBe(201);
  return await response.json() as { id: string; api_key: string; expires_at: string };
}

async function modelRequest(key: string): Promise<Response> {
  return exports.default.fetch(new Request("https://omnicore.integration/v1/models", {
    headers: { authorization: "Bearer " + key },
  }));
}

describe("OmniCore Worker with Miniflare D1 integration", () => {
  it("persists managed API keys and default expiry in D1", async () => {
    const created = await createManagedKey("d1-integration-persist");
    expect(created.api_key).toMatch(/^oc_live_[a-f0-9]{64}$/);
    expect(Date.parse(created.expires_at)).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    expect(Date.parse(created.expires_at)).toBeLessThan(Date.now() + 91 * 86_400_000);
    const row = await env.DB.prepare("SELECT id, key_hash, expires_at FROM api_keys WHERE id = ?")
      .bind(created.id).first<{ id: string; key_hash: string; expires_at: string }>();
    expect(row?.id).toBe(created.id);
    expect(row?.key_hash).not.toBe(created.api_key);
    expect(row?.expires_at).toBe(created.expires_at);
  });

  it("rotates keys in D1 and rejects the old credential", async () => {
    const oldKey = await createManagedKey("d1-integration-rotation");
    const rotated = await exports.default.fetch(new Request("https://omnicore.integration/v1/keys/" + oldKey.id + "/rotate", {
      method: "POST",
      headers: { authorization: "Bearer local-integration-admin", "content-type": "application/json" },
      body: JSON.stringify({ expires_in_days: 30 }),
    }));
    expect(rotated.status).toBe(201);
    const replacement = await rotated.json() as { id: string; api_key: string; expires_at: string };
    expect(replacement.api_key).toMatch(/^oc_live_[a-f0-9]{64}$/);
    expect(Date.parse(replacement.expires_at)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect((await modelRequest(oldKey.api_key)).status).toBe(401);
    expect((await modelRequest(replacement.api_key)).status).toBe(200);
    const oldRow = await env.DB.prepare("SELECT revoked_at FROM api_keys WHERE id = ?")
      .bind(oldKey.id).first<{ revoked_at: string | null }>();
    expect(oldRow?.revoked_at).toBeTruthy();
  });

  it("enforces the shared D1 rate counter across concurrent requests", async () => {
    const key = await createManagedKey("d1-integration-concurrency");
    const responses = await Promise.all(Array.from({ length: 5 }, () => modelRequest(key.api_key)));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(3);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(2);
  });
});
