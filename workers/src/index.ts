export interface Env {
  DB: D1Database;
  OMNICORE_API_KEY?: string;
  OMNICORE_ADMIN_KEY?: string;
  CIRCUIT_FAILURE_THRESHOLD?: string;
  CIRCUIT_OPEN_SECONDS?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  GEMINI_API_KEY?: string;
  WORKERS_AI?: Ai;
  FALLBACK_ORDER?: string;
  DEFAULT_MODEL?: string;
  RATE_LIMIT_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  CORS_ALLOWED_ORIGINS?: string;
}

type ApiPrincipal = { id: string; keyHash: string; name: string; admin: boolean };
type ChatMessage = { role: string; content: unknown };
type ChatRequest = {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_BODY_BYTES = 1_048_576;
const PROVIDER_TIMEOUT_MS = 25_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function openAIError(message: string, type = "api_error", code: string | null = null) {
  return { error: { message, type, param: null, code } };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) difference |= (left[i] || 0) ^ (right[i] || 0);
  return difference === 0;
}

async function authenticate(request: Request, env: Env): Promise<ApiPrincipal | null> {
  const header = request.headers.get("authorization") || "";
  const parts = header.trim().split(" ").filter(Boolean);
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return null;
  const suppliedHash = await sha256(parts[1]);
  if (env.OMNICORE_ADMIN_KEY && constantTimeEqual(suppliedHash, await sha256(env.OMNICORE_ADMIN_KEY))) {
    return { id: "admin", keyHash: suppliedHash, name: "admin", admin: true };
  }
  // Optional bootstrap key keeps initial migration compatible; issue managed keys before multi-user use.
  if (env.OMNICORE_API_KEY && constantTimeEqual(suppliedHash, await sha256(env.OMNICORE_API_KEY))) {
    return { id: "bootstrap", keyHash: suppliedHash, name: "bootstrap", admin: false };
  }
  try {
    const row = await env.DB.prepare(
      "SELECT id, key_hash, name FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1",
    ).bind(suppliedHash).first<{ id: string; key_hash: string; name: string }>();
    if (!row) return null;
    return { id: row.id, keyHash: row.key_hash, name: row.name, admin: false };
  } catch (error) {
    console.error("API-key lookup failed", error);
    return null;
  }
}

async function requireAdmin(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") || "";
  const parts = header.trim().split(" ").filter(Boolean);
  return Boolean(parts.length === 2 && parts[0].toLowerCase() === "bearer" && env.OMNICORE_ADMIN_KEY &&
    constantTimeEqual(await sha256(parts[1]), await sha256(env.OMNICORE_ADMIN_KEY)));
}

async function issueApiKey(request: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(request, env))) return json(openAIError("Admin authentication required", "authentication_error", "admin_required"), 401);
  let input: { name?: string };
  try { input = await request.json() as { name?: string }; } catch {
    return json(openAIError("Valid JSON body required", "invalid_request_error", "invalid_json"), 400);
  }
  const name = String(input.name || "").trim().slice(0, 80);
  if (!name) return json(openAIError("Key name is required", "invalid_request_error", "invalid_key_name"), 400);
  const id = crypto.randomUUID();
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = "oc_live_" + [...tokenBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await sha256(token);
  try {
    await env.DB.prepare("INSERT INTO api_keys (id, key_hash, name, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, hash, name, new Date().toISOString()).run();
    return json({ id, name, api_key: token, created_at: new Date().toISOString(), warning: "Store this key securely; it will not be shown again." }, 201);
  } catch (error) {
    console.error("API-key creation failed", error);
    return json(openAIError("Could not create API key", "server_error", "key_creation_failed"), 503);
  }
}

async function listApiKeys(request: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(request, env))) return json(openAIError("Admin authentication required", "authentication_error", "admin_required"), 401);
  const result = await env.DB.prepare(
    "SELECT id, name, created_at FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 500",
  ).all<{ id: string; name: string; created_at: string }>();
  return json({ object: "list", data: result.results || [] });
}

async function revokeApiKey(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await requireAdmin(request, env))) return json(openAIError("Admin authentication required", "authentication_error", "admin_required"), 401);
  const result = await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), id).run();
  if (!result.meta?.changes) return json(openAIError("API key not found or already revoked", "invalid_request_error", "key_not_found"), 404);
  return json({ id, revoked: true });
}

function configuredProviders(env: Env): string[] {
  const available = new Set<string>();
  if (env.OPENAI_API_KEY) available.add("openai");
  if (env.GEMINI_API_KEY) available.add("gemini");
  if (env.WORKERS_AI) available.add("workers-ai");
  const requested = (env.FALLBACK_ORDER || "workers-ai,openai,gemini")
    .split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  const ordered = requested.filter((v, i) => available.has(v) && requested.indexOf(v) === i);
  return [...ordered, ...[...available].filter((v) => !ordered.includes(v))];
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = (env.CORS_ALLOWED_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return { vary: "Origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

async function enforceRateLimit(request: Request, env: Env, keyHash: string): Promise<Response | null> {
  const limit = Math.max(1, Math.min(10_000, Number.parseInt(env.RATE_LIMIT_REQUESTS || "60", 10) || 60));
  const windowSeconds = Math.max(1, Math.min(86_400, Number.parseInt(env.RATE_LIMIT_WINDOW_SECONDS || "60", 10) || 60));
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const key = keyHash;
  try {
    const row = await env.DB.prepare(
      "INSERT INTO rate_limit_windows (key_hash, window_start, request_count) VALUES (?, ?, 1) " +
      "ON CONFLICT(key_hash, window_start) DO UPDATE SET request_count = request_count + 1 " +
      "RETURNING request_count",
    ).bind(key, windowStart).first<{ request_count: number }>();
    if (!row) throw new Error("Rate-limit counter returned no row");
    if (row.request_count > limit) {
      const retryAfter = Math.max(1, windowStart + windowSeconds - now);
      return json(openAIError("Rate limit exceeded. Retry after the current window.", "rate_limit_error", "rate_limit_exceeded"), 429, {
        "retry-after": String(retryAfter),
        "x-ratelimit-limit": String(limit),
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(windowStart + windowSeconds),
      });
    }
    return null;
  } catch (error) {
    console.error("rate-limit persistence failed", error);
    return json(openAIError("Rate limiting is temporarily unavailable.", "server_error", "rate_limit_unavailable"), 503, {
      "retry-after": "5",
    });
  }
}

function modelList(env: Env) {
  const providers = configuredProviders(env);
  const models = new Set<string>([env.DEFAULT_MODEL || DEFAULT_MODEL]);
  if (providers.includes("workers-ai")) models.add("@cf/meta/llama-3.1-8b-instruct");
  if (providers.includes("openai")) models.add("gpt-4o-mini");
  if (providers.includes("gemini")) models.add("gemini-2.0-flash");
  return { object: "list", data: [...models].map((id) => ({ id, object: "model", created: 0, owned_by: "omnicore" })) };
}

async function callOpenAICompatible(
  provider: "openai" | "gemini",
  requestBody: ChatRequest,
  env: Env,
): Promise<Response> {
  const key = provider === "openai" ? env.OPENAI_API_KEY : env.GEMINI_API_KEY;
  if (!key) throw new Error(provider + " provider is not configured");
  const base = provider === "openai"
    ? (env.OPENAI_BASE_URL || "https://api.openai.com/v1")
    : "https://generativelanguage.googleapis.com/v1beta/openai";
  const model = provider === "gemini" && String(requestBody.model || "").startsWith("gemini-")
    ? requestBody.model
    : provider === "gemini" ? "gemini-2.0-flash" : (requestBody.model || "gpt-4o-mini");
  return fetch(base.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ ...requestBody, model }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
}

async function callWorkersAI(requestBody: ChatRequest, env: Env): Promise<Response> {
  if (!env.WORKERS_AI) throw new Error("Workers AI binding is not configured");
  if (requestBody.stream) throw new Error("Workers AI streaming adapter is not enabled yet");
  const requestedModel = String(requestBody.model || "");
  const model = requestedModel.startsWith("@cf/") ? requestedModel : "@cf/meta/llama-3.1-8b-instruct";
  const result = await env.WORKERS_AI.run(model as keyof AiModels, {
    messages: requestBody.messages || [],
    max_tokens: typeof requestBody.max_tokens === "number" ? requestBody.max_tokens : 1024,
    temperature: typeof requestBody.temperature === "number" ? requestBody.temperature : 0.7,
  } as never);
  const output = result as { response?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  return json({
    id: "omnicore-" + crypto.randomUUID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: output.response || "" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: output.usage?.prompt_tokens || 0,
      completion_tokens: output.usage?.completion_tokens || 0,
      total_tokens: (output.usage?.prompt_tokens || 0) + (output.usage?.completion_tokens || 0),
    },
  });
}

async function recordUsage(env: Env, provider: string, model: string, status: number, apiKeyId: string): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO usage_events (id, provider, model, status, created_at, api_key_id) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), provider, model, status, new Date().toISOString(), apiKeyId).run();
  } catch (error) {
    console.error("usage persistence failed", error);
  }
}

function isRetryable(response: Response): boolean {
  return RETRYABLE_STATUS.has(response.status);
}

function shouldFallback(status: number): boolean {
  return RETRYABLE_STATUS.has(status) || status === 401 || status === 403 || status === 404;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(1_500, retryAfter * 1_000);
  return 150 * (2 ** attempt);
}

async function attemptProvider(provider: string, body: ChatRequest, env: Env): Promise<Response> {
  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = provider === "workers-ai"
        ? await callWorkersAI(body, env)
        : await callOpenAICompatible(provider as "openai" | "gemini", body, env);
      if (!isRetryable(response) || attempt === maxAttempts - 1) return response;
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
      continue;
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * (2 ** attempt)));
  }
  throw new Error("Provider retry loop exhausted");
}

async function circuitIsOpen(env: Env, provider: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare("SELECT opened_until FROM provider_circuits WHERE provider = ?")
      .bind(provider).first<{ opened_until: number }>();
    return Boolean(row && row.opened_until > Math.floor(Date.now() / 1000));
  } catch (error) {
    console.error("circuit state lookup failed", error);
    return false; // availability wins; bounded provider timeout/retry still applies
  }
}

async function recordProviderResult(env: Env, provider: string, success: boolean): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const threshold = Math.max(2, Math.min(20, Number.parseInt(env.CIRCUIT_FAILURE_THRESHOLD || "3", 10) || 3));
  const openSeconds = Math.max(10, Math.min(3600, Number.parseInt(env.CIRCUIT_OPEN_SECONDS || "60", 10) || 60));
  try {
    if (success) {
      await env.DB.prepare("DELETE FROM provider_circuits WHERE provider = ?").bind(provider).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO provider_circuits (provider, failure_count, opened_until, last_failure_at, updated_at) VALUES (?, 1, 0, ?, ?) " +
        "ON CONFLICT(provider) DO UPDATE SET failure_count = failure_count + 1, " +
        "opened_until = CASE WHEN failure_count + 1 >= ? THEN ? ELSE opened_until END, " +
        "last_failure_at = excluded.last_failure_at, updated_at = excluded.updated_at",
      ).bind(provider, now, now, threshold, now + openSeconds).run();
    }
  } catch (error) {
    console.error("circuit state update failed", error);
  }
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const principal = await authenticate(request, env);
  if (!principal) return json(openAIError("Invalid API key", "authentication_error", "invalid_api_key"), 401, { "www-authenticate": "Bearer" });
  const limited = await enforceRateLimit(request, env, principal.keyHash);
  if (limited) return limited;

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return json(openAIError("Request body exceeds 1 MiB", "invalid_request_error", "body_too_large"), 413);
  let body: ChatRequest;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json(openAIError("Request body exceeds 1 MiB", "invalid_request_error", "body_too_large"), 413);
    }
    body = JSON.parse(raw) as ChatRequest;
  } catch {
    return json(openAIError("Request body must be valid JSON", "invalid_request_error", "invalid_json"), 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json(openAIError("messages must be a non-empty array", "invalid_request_error", "invalid_messages"), 400);
  }
  const providers = configuredProviders(env);
  if (!providers.length) return json(openAIError("No inference providers are configured", "server_error", "no_providers"), 503);

  const failures: string[] = [];
  for (const provider of providers) {
    if (await circuitIsOpen(env, provider)) { failures.push(provider + ": circuit open"); continue; }
    try {
      const response = await attemptProvider(provider, body, env);
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        failures.push(provider + ": HTTP " + response.status + " " + detail);
        if (!shouldFallback(response.status)) {
          return json(openAIError("Provider rejected the request (" + provider + ").", "invalid_request_error", "provider_request_rejected"), response.status);
        }
        await recordProviderResult(env, provider, false);
        continue;
      }
      await recordProviderResult(env, provider, true);
      await recordUsage(env, provider, String(body.model || env.DEFAULT_MODEL || DEFAULT_MODEL), response.status, principal.id);
      const headers = new Headers(response.headers);
      headers.set("x-omnicore-provider", provider);
      headers.set("cache-control", "no-store");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      await recordProviderResult(env, provider, false);
      failures.push(provider + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  console.error("all providers failed", failures);
  return json(openAIError("All configured providers failed. Check provider configuration and quotas.", "server_error", "all_providers_failed"), 502);
}

export default {

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const now = Math.floor(Date.now() / 1000);
      const results = await Promise.all([
        env.DB.prepare("DELETE FROM rate_limit_windows WHERE window_start < ?").bind(now - 172800).run(),
        env.DB.prepare("DELETE FROM provider_circuits WHERE updated_at < ? AND opened_until < ?").bind(now - 86400, now).run(),
      ]);
      console.log("OmniCore scheduled cleanup completed", {
        rateLimitWindowsDeleted: results[0].meta?.changes || 0,
        circuitRowsDeleted: results[1].meta?.changes || 0,
      });
    })());
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "ok", service: "OmniCore AI", runtime: "cloudflare-workers" }, 200, cors);
    }
    if (url.pathname === "/v1/models" && request.method === "GET") {
      if (!(await authenticate(request, env))) return json(openAIError("Invalid API key", "authentication_error", "invalid_api_key"), 401, { ...cors, "www-authenticate": "Bearer" });
      return json(modelList(env), 200, cors);
    }
    if (url.pathname === "/v1/keys" && request.method === "POST") return issueApiKey(request, env);
    if (url.pathname === "/v1/keys" && request.method === "GET") return listApiKeys(request, env);
    const revokeMatch = url.pathname.match(new RegExp("^/v1/keys/([0-9a-f-]+)$"));
    if (revokeMatch && request.method === "DELETE") return revokeApiKey(request, env, revokeMatch[1]);
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      const response = await handleChat(request, env);
      const headers = new Headers(response.headers);
      new Headers(cors).forEach((value, key) => headers.set(key, value));
      return new Response(response.body, { status: response.status, headers });
    }
    return json(openAIError("Not found", "invalid_request_error", "not_found"), 404, cors);
  },
};
