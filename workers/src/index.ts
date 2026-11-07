export interface Env {
  DB: D1Database;
  OMNICORE_API_KEY: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  GEMINI_API_KEY?: string;
  WORKERS_AI?: Ai;
  FALLBACK_ORDER?: string;
  DEFAULT_MODEL?: string;
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

async function authorized(request: Request, env: Env): Promise<boolean> {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!supplied || !env.OMNICORE_API_KEY) return false;
  const [a, b] = await Promise.all([sha256(supplied), sha256(env.OMNICORE_API_KEY)]);
  return a === b;
}

function configuredProviders(env: Env): string[] {
  const available = new Set<string>();
  if (env.OPENAI_API_KEY) available.add("openai");
  if (env.GEMINI_API_KEY) available.add("gemini");
  if (env.WORKERS_AI) available.add("workers-ai");
  const requested = (env.FALLBACK_ORDER || "workers-ai,openai,gemini")
    .split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  return [...requested.filter((v) => available.has(v)), ...[...available].filter((v) => !requested.includes(v))];
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    return await fetch(base.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ ...requestBody, model }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function callWorkersAI(requestBody: ChatRequest, env: Env): Promise<Response> {
  if (!env.WORKERS_AI) throw new Error("Workers AI binding is not configured");
  if (requestBody.stream) throw new Error("Workers AI streaming adapter is not enabled yet");
  const model = String(requestBody.model || "@cf/meta/llama-3.1-8b-instruct");
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

async function handleChat(request: Request, env: Env): Promise<Response> {
  if (!(await authorized(request, env))) return json(openAIError("Invalid API key", "authentication_error", "invalid_api_key"), 401, { "www-authenticate": "Bearer" });
  let body: ChatRequest;
  try {
    body = await request.json() as ChatRequest;
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
      const response = provider === "workers-ai"
        ? await callWorkersAI(body, env)
        : await callOpenAICompatible(provider as "openai" | "gemini", body, env);
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 600);
        failures.push(provider + ": HTTP " + response.status + " " + detail);
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
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
      }});
    }
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "ok", service: "OmniCore AI", runtime: "cloudflare-workers" });
    }
    if (url.pathname === "/v1/models" && request.method === "GET") {
      if (!(await authorized(request, env))) return json(openAIError("Invalid API key", "authentication_error", "invalid_api_key"), 401);
      return json(modelList(env));
    }
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      return handleChat(request, env);
    }
    return json(openAIError("Not found", "invalid_request_error", "not_found"), 404);
  },
};
