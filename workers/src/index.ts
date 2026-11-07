export interface Env {
  DB: D1Database;
  OMNICORE_API_KEY: string;
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

async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match || !env.OMNICORE_API_KEY) return false;
  const [supplied, expected] = await Promise.all([sha256(match[1]), sha256(env.OMNICORE_API_KEY)]);
  return constantTimeEqual(supplied, expected);
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

function corsHeaders(request: Request, env: Env): HeadersInit {
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

async function enforceRateLimit(request: Request, env: Env): Promise<Response | null> {
  const limit = Math.max(1, Math.min(10_000, Number.parseInt(env.RATE_LIMIT_REQUESTS || "60", 10) || 60));
  const windowSeconds = Math.max(1, Math.min(86_400, Number.parseInt(env.RATE_LIMIT_WINDOW_SECONDS || "60", 10) || 60));
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const key = await sha256(env.OMNICORE_API_KEY);
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

async function recordUsage(env: Env, provider: string, model: string, status: number): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO usage_events (id, provider, model, status, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), provider, model, status, new Date().toISOString()).run();
  } catch (error) {
    console.error("usage persistence failed", error);
  }
}

function isRetryable(response: Response): boolean {
  return RETRYABLE_STATUS.has(response.status);
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
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * (2 ** attempt)));
  }
  throw new Error("Provider retry loop exhausted");
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  if (!(await authorized(request, env))) return json(openAIError("Invalid API key", "authentication_error", "invalid_api_key"), 401, { "www-authenticate": "Bearer" });
  const limited = await enforceRateLimit(request, env);
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
    try {
      const response = await attemptProvider(provider, body, env);
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        failures.push(provider + ": HTTP " + response.status + " " + detail);
        if (!isRetryable(new Response(null, { status: response.status }))) {
          return json(openAIError("Provider rejected the request (" + provider + ").", "invalid_request_error", "provider_request_rejected"), response.status);
        }
        continue;
      }
      await recordUsage(env, provider, String(body.model || env.DEFAULT_MODEL || DEFAULT_MODEL), response.status);
      const headers = new Headers(response.headers);
      headers.set("x-omnicore-provider", provider);
      headers.set("cache-control", "no-store");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      failures.push(provider + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  console.error("all providers failed", failures);
  return json(openAIError("All configured providers failed. Check provider configuration and quotas.", "server_error", "all_providers_failed"), 502);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "ok", service: "OmniCore AI", runtime: "cloudflare-workers" }, 200, cors);
    }
    if (url.pathname === "/v1/models" && request.method === "GET") {
      if (!(await authorized(request, env))) return json(openAIError("Invalid API key", "authentication_error", "invalid_api_key"), 401, { ...cors, "www-authenticate": "Bearer" });
      return json(modelList(env), 200, cors);
    }
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      const response = await handleChat(request, env);
      const headers = new Headers(response.headers);
      new Headers(cors).forEach((value, key) => headers.set(key, value));
      return new Response(response.body, { status: response.status, headers });
    }
    return json(openAIError("Not found", "invalid_request_error", "not_found"), 404, cors);
  },
};
