/**
 * Perch AI adapter for DeepSeek Harness.
 *
 * Authentication is Perch AI's own: the plugin reads the public auth config
 * from Perch, runs the same Supabase PKCE OAuth flow as the official
 * `perch login` CLI, and stores the resulting session under DSH home. Model
 * calls go to the Perch OpenAI-compatible gateway.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ToolCallId,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";

export const PROVIDER = "perchai";
export const PROVIDER_NAME = "Perch AI";
export const name = "dsh-perchai";
export const inject = ["llm"];

const STREAM_IDLE_TIMEOUT_MS = 300000;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_APP_URL = "https://app.perchai.app";
const DEFAULT_API_BASE_URL = "https://chat.perchai.app/api/perch/v1";
const CALLBACK_PATH = "/callback";
const DEFAULT_CALLBACK_PORT = 51121;
const DEFAULT_CONTEXT_WINDOW = 128000;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

// Used only when the gateway cannot be reached; the live catalog always wins.
const FALLBACK_MODELS = [
  { id: "claude-opus-5-5", contextWindow: 200000 },
  { id: "claude-sonnet-5-5", contextWindow: 200000 },
  { id: "claude-haiku-5-5", contextWindow: 200000 },
  { id: "gpt-6-1-sol", contextWindow: 105000 },
  { id: "gpt-6-1-luna", contextWindow: 105000 },
  { id: "gemini-4-argon", contextWindow: 1000000 },
  { id: "deepseek-v4-1-flash", contextWindow: 128000 },
  { id: "minimax-m3-1-flash", contextWindow: 128000 },
  { id: "grok-4-7", contextWindow: 128000 },
];

const diagnostics = {
  apiBaseUrl: "",
  status: undefined,
  model: "",
  availableModels: "",
  error: "",
};

let webLoginFlow = undefined;
let modelCache = undefined;

export function credentialPath() {
  return dshHomePath("storages", "perchai-oauth.json");
}

export function modelSettingsPath() {
  return dshHomePath("storages", "perchai-settings.json");
}

function perchEnv(namePart) {
  return process.env[`PERCH_${namePart}`]?.trim() || undefined;
}

function appUrl() {
  return perchEnv("APP_URL") || DEFAULT_APP_URL;
}

function apiBaseUrl() {
  return (perchEnv("API_BASE_URL") || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

function callbackPort() {
  const raw = perchEnv("CALLBACK_PORT");
  if (!raw) return DEFAULT_CALLBACK_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PERCH_CALLBACK_PORT: ${raw}`);
  }
  return parsed;
}

function callbackUri() {
  return `http://127.0.0.1:${callbackPort()}${CALLBACK_PATH}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeText(text) {
  return String(text ?? "").replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function redactSecrets(text) {
  return String(text)
    .replace(/\bsb_publishable_[A-Za-z0-9_-]+/g, "[redacted-publishable-key]")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, "[redacted-jwt]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /("?(?:access_token|refresh_token|client_secret|code_verifier|authorization)"?\s*[:=]\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(
      /("?(?:access_token|refresh_token|client_secret|code_verifier|authorization)"?\s*[:=]\s*)[^\s&,}]+/gi,
      "$1[redacted]",
    );
}

function safeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw);
}

function setLastError(error) {
  diagnostics.error = safeError(error || "");
}

export function getPerchDiagnostics() {
  return { ...diagnostics };
}

// ---------------------------------------------------------------- Perch auth

async function fetchPerchAuthConfig() {
  const response = await fetch(`${appUrl()}/api/perch-terminal/cli-auth/config`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Perch auth config failed (HTTP ${response.status})`);
  }
  const data = await response.json();
  if (!isRecord(data) || data.ok === false || !data.supabaseUrl || !data.supabaseAnonKey) {
    throw new Error("Perch auth config is incomplete");
  }
  return data;
}

function perchProviders(config) {
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  return providers.filter((provider) => typeof provider === "string" && provider.length > 0);
}

function perchAuthorizeUrl(config, provider, challenge, redirectUri = callbackUri()) {
  const url = new URL(`${config.supabaseUrl}/auth/v1/authorize`);
  url.search = new URLSearchParams({
    client_id: config.supabaseAnonKey,
    provider,
    redirect_to: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return url.toString();
}

async function postSupabaseToken(config, grantType, body) {
  // GoTrue reads the grant type from the query string, not from the JSON body.
  const url = new URL(`${config.supabaseUrl}/auth/v1/token`);
  url.searchParams.set("grant_type", grantType);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: config.supabaseAnonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Perch token request failed (HTTP ${response.status}): ${redactSecrets(text).slice(0, 200)}`);
  }
  return response.json();
}

async function exchangePerchCode(config, code, verifier) {
  // GoTrue reads the auth code from `auth_code` in a JSON body.
  const data = await postSupabaseToken(config, "pkce", {
    auth_code: code,
    code_verifier: verifier,
  });
  if (!data?.access_token) throw new Error("Perch token response has no access token");
  return sessionFromToken(data);
}

async function refreshPerchSession(config, refreshToken) {
  const data = await postSupabaseToken(config, "refresh_token", {
    refresh_token: refreshToken,
  });
  if (!data?.access_token) throw new Error("Perch refresh response has no access token");
  return sessionFromToken(data);
}

function sessionFromToken(data) {
  return {
    access: data.access_token,
    refresh: data.refresh_token || undefined,
    expires: Number(data.expires_at ?? Math.floor(Date.now() / 1000)) * 1000,
    userId: asString(data.user?.id),
    email: asString(data.user?.email),
  };
}

function base64Url(buffer) {
  return buffer.toString("base64url");
}

function generatePKCE() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function callbackHeaders(contentType = "text/html; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
  };
}

/**
 * Loopback listener for the Perch OAuth redirect. Supabase sends the PKCE
 * code back to it; the code is useless without our verifier, so an unrelated
 * request to this port cannot hijack the login. `onCode` finishes the sign-in
 * (token exchange + credential write) so the browser tab can report the real
 * outcome instead of a bare "callback received".
 */
function startCallbackServer(onCode) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };
    const server = createServer(async (request, response) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, callbackHeaders("text/plain; charset=utf-8"));
        response.end("Method Not Allowed");
        return;
      }
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404, callbackHeaders());
        response.end("Perch OAuth callback route not found.");
        return;
      }
      const providerError = url.searchParams.get("error_description") || url.searchParams.get("error");
      if (providerError) {
        response.writeHead(400, callbackHeaders());
        response.end(`Perch authentication failed: ${escapeHtml(providerError.slice(0, 200))}`);
        finish(() => rejectCode(new Error(`Perch sign-in failed: ${providerError.slice(0, 200)}`)));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response.writeHead(400, callbackHeaders());
        response.end("Perch authentication failed: missing code.");
        finish(() => rejectCode(new Error("Missing code in Perch OAuth callback")));
        return;
      }
      let result;
      try {
        result = await onCode(code);
      } catch (error) {
        response.writeHead(400, callbackHeaders());
        response.end(
          `Perch sign-in failed: ${escapeHtml(safeError(error).slice(0, 300))}`,
        );
        finish(() => rejectCode(error));
        return;
      }
      response.writeHead(200, callbackHeaders());
      response.end("Perch authentication complete. You can close this window and return to DSH.");
      finish(() => resolveCode(result));
    });
    server.on("error", reject);
    server.listen(callbackPort(), "127.0.0.1", () => {
      timeout = setTimeout(() => {
        finish(() => rejectCode(new Error("OAuth callback timed out waiting for browser login")));
        server.close();
      }, OAUTH_CALLBACK_TIMEOUT_MS);
      timeout.unref?.();
      resolve({ server, waitForCode: () => codePromise });
    });
  });
}

export function openBrowser(url) {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true });
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    }
  } catch {
    // Best effort only.
  }
}

export function browserInteraction(signal) {
  return {
    signal,
    notify(event) {
      if (event.type === "auth_url") openBrowser(event.url);
    },
  };
}

export function terminalInteraction(signal) {
  return {
    signal,
    notify(event) {
      if (event.type !== "auth_url") return;
      console.log(event.instructions || "Open the following URL to sign in:");
      console.log(event.url);
      openBrowser(event.url);
    },
  };
}

export async function loginPerch(store, interaction = browserInteraction(), provider) {
  const config = await fetchPerchAuthConfig();
  const providers = perchProviders(config);
  const chosen = providers.includes(provider) ? provider : providers[0];
  if (!chosen) throw new Error("Perch has no sign-in provider available");

  const { verifier, challenge } = generatePKCE();
  const { server, waitForCode } = await startCallbackServer(async (code) => {
    const session = await exchangePerchCode(config, code, verifier);
    await store.write({ ...session, appUrl: appUrl(), provider: chosen });
    return session;
  });
  try {
    const authUrl = perchAuthorizeUrl(config, chosen, challenge);
    interaction.notify?.({
      type: "auth_url",
      url: authUrl,
      instructions: `Complete the Perch ${chosen} sign-in. DSH will capture the local callback.`,
    });

    const session = await waitForCode();
    if (interaction.signal?.aborted) throw new Error("Perch login aborted");
    return { ...session, appUrl: appUrl(), provider: chosen };
  } finally {
    server.close();
  }
}

export async function loginAndSave(store, interaction = browserInteraction(), provider) {
  return loginPerch(store, interaction, provider);
}

export async function beginWebLogin(store, provider) {
  if (webLoginFlow?.status === "pending") {
    return {
      status: webLoginFlow.status,
      authUrl: webLoginFlow.authUrl,
      startedAt: webLoginFlow.startedAt,
      providers: webLoginFlow.providers,
    };
  }

  const config = await fetchPerchAuthConfig();
  const providers = perchProviders(config);
  const chosen = providers.includes(provider) ? provider : providers[0];
  if (!chosen) throw new Error("Perch has no sign-in provider available");

  const { verifier, challenge } = generatePKCE();
  let session;
  const { server, waitForCode } = await startCallbackServer(async (code) => {
    session = await exchangePerchCode(config, code, verifier);
    await store.write({ ...session, appUrl: appUrl(), provider: chosen });
    return session;
  });
  const flow = {
    status: "pending",
    authUrl: perchAuthorizeUrl(config, chosen, challenge),
    startedAt: Date.now(),
    error: "",
    providers,
  };
  webLoginFlow = flow;

  void (async () => {
    try {
      await waitForCode();
      flow.status = "complete";
      flow.email = session?.email;
      flow.completedAt = Date.now();
      modelCache = undefined;
    } catch (error) {
      flow.status = "error";
      flow.error = safeError(error);
      flow.completedAt = Date.now();
    } finally {
      server.close();
    }
  })();

  return { status: flow.status, authUrl: flow.authUrl, startedAt: flow.startedAt, providers };
}

export function getWebLoginStatus() {
  if (!webLoginFlow) return { status: "idle" };
  return {
    status: webLoginFlow.status,
    startedAt: webLoginFlow.startedAt,
    completedAt: webLoginFlow.completedAt,
    email: webLoginFlow.email,
    error: webLoginFlow.error,
    providers: webLoginFlow.providers,
  };
}

export function getPerchProviders() {
  return fetchPerchAuthConfig()
    .then(perchProviders)
    .catch(() => []);
}

const PROVIDER_CACHE_TTL_MS = 10 * 60 * 1000;
let providerCache = undefined;

async function perchProviderList() {
  const cached = providerCache;
  if (cached && Date.now() - cached.at < PROVIDER_CACHE_TTL_MS) return cached.providers;
  const providers = await getPerchProviders();
  providerCache = { at: Date.now(), providers };
  return providers;
}

function credentialEmail(credentials) {
  return asString(credentials?.email);
}

function needsRefresh(credentials) {
  return !credentials?.access || !credentials.expires || credentials.expires <= Date.now() + 60000;
}

export async function refreshPerchToken(credentials) {
  if (!credentials?.refresh) {
    throw new Error("Missing Perch refresh token. Sign in again from Settings > Perch AI.");
  }
  const config = await fetchPerchAuthConfig();
  const session = await refreshPerchSession(config, credentials.refresh);
  return {
    ...credentials,
    ...session,
    refresh: session.refresh || credentials.refresh,
  };
}

// ------------------------------------------------------------------- storage

export class FileCredentialStore {
  #file;
  #chain = Promise.resolve();

  constructor(file = credentialPath()) {
    this.#file = file;
  }

  path() {
    return this.#file;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      return isRecord(parsed) ? parsed : undefined;
    } catch (error) {
      if (error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(credentials) {
    await mkdir(dirname(this.#file), { recursive: true });
    const tempFile = `${this.#file}.tmp`;
    await writeFile(tempFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    await rename(tempFile, this.#file);
  }

  modify(fn) {
    const next = (async () => {
      await this.#chain.catch(() => {});
      const current = await this.read();
      const updated = await fn(current);
      if (updated !== undefined) await this.write(updated);
      return updated ?? current;
    })();
    this.#chain = next.catch(() => {});
    return next;
  }

  async delete() {
    await this.#chain.catch(() => {});
    try {
      await unlink(this.#file);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
}

function normalizeModelSettings(raw) {
  const enabledModelIds = Array.isArray(raw?.enabledModelIds)
    ? raw.enabledModelIds.filter((id) => typeof id === "string" && id.length > 0 && !/\s/.test(id))
    : [];
  return {
    enabledModelIds: [...new Set(enabledModelIds)],
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

export class FileModelSettingsStore {
  #file;
  #chain = Promise.resolve();

  constructor(file = modelSettingsPath()) {
    this.#file = file;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      return normalizeModelSettings(isRecord(parsed) ? parsed : undefined);
    } catch (error) {
      if (error && error.code === "ENOENT") return normalizeModelSettings(undefined);
      throw error;
    }
  }

  async write(settings) {
    const normalized = normalizeModelSettings(settings);
    await mkdir(dirname(this.#file), { recursive: true });
    const tempFile = `${this.#file}.tmp`;
    await writeFile(tempFile, JSON.stringify({ ...normalized, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
    await rename(tempFile, this.#file);
    return this.read();
  }

  modify(fn) {
    const next = (async () => {
      await this.#chain.catch(() => {});
      const current = await this.read();
      const updated = await fn(current);
      if (updated !== undefined) await this.write(updated);
      return updated ?? current;
    })();
    this.#chain = next.catch(() => {});
    return next;
  }

  setEnabledModelIds(enabledModelIds) {
    return this.modify((current) => ({ ...current, enabledModelIds }));
  }
}

// -------------------------------------------------------------------- models

function contextWindowOf(entry) {
  const candidates = [
    entry?.context_window,
    entry?.contextWindow,
    entry?.context_length,
    entry?.max_context_length,
    entry?.max_input_tokens,
    entry?.context?.contextWindow,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return DEFAULT_CONTEXT_WINDOW;
}

function parseModelCatalog(data) {
  const list = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.models)
      ? data.models
      : Array.isArray(data)
        ? data
        : [];
  const models = [];
  for (const entry of list) {
    const id = asString(isRecord(entry) ? entry.id ?? entry.model ?? entry.name : undefined);
    if (!id) continue;
    models.push({
      id,
      name: asString(isRecord(entry) ? entry.display_name ?? entry.label : undefined) || id,
      contextWindow: contextWindowOf(isRecord(entry) ? entry : {}),
    });
  }
  return models;
}

export async function fetchPerchModels(accessToken) {
  const base = apiBaseUrl();
  diagnostics.apiBaseUrl = base;
  const response = await fetch(`${base}/models`, {
    headers: {
      Accept: "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Perch model list failed (HTTP ${response.status})`);
  }
  const models = parseModelCatalog(await response.json());
  if (!models.length) throw new Error("Perch model list is empty");
  return models;
}

async function modelCatalog(store) {
  const cached = modelCache;
  if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) return cached.models;
  let models;
  try {
    const credentials = await store.read();
    models = await fetchPerchModels(credentials?.access);
  } catch (error) {
    setLastError(error);
    models = undefined;
  }
  if (!models) {
    models = FALLBACK_MODELS.map((model) => ({ ...model, name: model.id }));
  }
  modelCache = { at: Date.now(), models };
  diagnostics.availableModels = models.map((model) => model.id).join(",");
  return models;
}

function enabledModelSet(settings) {
  return new Set(normalizeModelSettings(settings).enabledModelIds);
}

function configuredModels(settings, catalog) {
  const enabled = enabledModelSet(settings);
  if (!enabled.size) return [];
  return catalog.filter((model) => enabled.has(model.id));
}

function modelFromSettings(settings, catalog, modelId) {
  const enabled = enabledModelSet(settings);
  if (enabled.size && !enabled.has(modelId)) {
    throw new LlmError(`Perch model "${modelId}" is not enabled. Enable it in Settings > Perch AI.`, "MODEL");
  }
  return catalog.find((model) => model.id === modelId) || { id: modelId, name: modelId, contextWindow: DEFAULT_CONTEXT_WINDOW };
}

// ------------------------------------------------------------------- request

function openAiUserContent(content) {
  if (typeof content === "string") return sanitizeText(content);
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text") {
      parts.push({ type: "text", text: sanitizeText(block.text) });
    }
  }
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

function toolResultText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text") return sanitizeText(block.text);
      if (block.type === "tool-result") return toolResultText(block.content);
      return "";
    })
    .join("");
}

function convertMessages(options) {
  const messages = [];
  if (options.system) messages.push({ role: "system", content: sanitizeText(options.system) });

  for (const message of options.messages) {
    const content = Array.isArray(message.content) ? message.content : [];
    if (message.role === "assistant") {
      const text = content
        .filter((block) => isRecord(block) && block.type === "text")
        .map((block) => sanitizeText(block.text))
        .join("");
      const toolCalls = content
        .filter((block) => isRecord(block) && block.type === "tool-call")
        .map((block) => ({
          id: String(block.id || `call_${randomBytes(6).toString("hex")}`),
          type: "function",
          function: {
            name: String(block.name || ""),
            arguments:
              typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}),
          },
        }));
      if (text || toolCalls.length) {
        messages.push({
          role: "assistant",
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
      }
      continue;
    }

    if (message.role === "system") {
      const text = content
        .filter((block) => isRecord(block) && block.type === "text")
        .map((block) => sanitizeText(block.text))
        .join("");
      if (text) messages.push({ role: "system", content: text });
      continue;
    }

    const results = content.filter((block) => isRecord(block) && block.type === "tool-result");
    const rest = content.filter((block) => !isRecord(block) || block.type !== "tool-result");
    const body = openAiUserContent(rest);
    if (body !== "" && !(Array.isArray(body) && body.length === 0)) {
      messages.push({ role: "user", content: body });
    }
    for (const result of results) {
      messages.push({
        role: "tool",
        tool_call_id: String(result.toolCallId || ""),
        content: toolResultText(result.content) || (result.isError ? "Tool failed" : ""),
      });
    }
  }
  return messages;
}

function convertTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

function buildRequest(options, model) {
  const request = {
    model: model.id,
    messages: convertMessages(options),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.temperature !== undefined) request.temperature = options.temperature;
  if (options.maxTokens !== undefined) request.max_tokens = options.maxTokens;
  const tools = convertTools(options.tools);
  if (tools) request.tools = tools;
  if (options.toolChoice === "none") request.tool_choice = "none";
  else if (options.toolChoice === "any" || options.toolChoice === "required") {
    request.tool_choice = "required";
  }
  return request;
}

// -------------------------------------------------------------------- stream

function createStreamState() {
  return {
    blocks: [],
    replayBlocks: [],
    currentBlock: undefined,
    finishReason: undefined,
    usage: undefined,
    hasContent: false,
    hasToolCall: false,
    toolCalls: new Map(),
  };
}

function closeCurrentBlock(out, state) {
  if (!state.currentBlock) return;
  const index = state.blocks.length - 1;
  out.push({
    type: "block-end",
    index,
    block: { type: state.currentBlock.type, text: state.currentBlock.text },
  });
  state.currentBlock = undefined;
}

function openTextBlock(out, state, type) {
  if (state.currentBlock && state.currentBlock.type === type) return state.blocks.length - 1;
  closeCurrentBlock(out, state);
  state.currentBlock = { type, text: "" };
  state.blocks.push(state.currentBlock);
  state.replayBlocks.push({ type });
  out.push({ type: "block-start", index: state.blocks.length - 1, blockType: type });
  return state.blocks.length - 1;
}

function processStreamLine(line, state) {
  const out = [];
  if (!line.startsWith("data:")) return out;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return out;
  const chunk = safeJsonParse(payload);
  if (!isRecord(chunk)) return out;
  if (isRecord(chunk.error)) {
    const message = String(chunk.error.message || JSON.stringify(chunk.error));
    throw new LlmError(message, classifyPerchError(message));
  }

  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
  const delta = isRecord(choice?.delta) ? choice.delta : {};

  const reasoning = asString(delta.reasoning_content) || asString(delta.reasoning);
  if (reasoning) {
    const index = openTextBlock(out, state, "reasoning");
    state.currentBlock.text += sanitizeText(reasoning);
    state.hasContent = true;
    out.push({ type: "reasoning-delta", index, text: sanitizeText(reasoning) });
  }

  const text = asString(delta.content);
  if (text) {
    const index = openTextBlock(out, state, "text");
    state.currentBlock.text += sanitizeText(text);
    state.hasContent = true;
    out.push({ type: "text-delta", index, text: sanitizeText(text) });
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const call of delta.tool_calls) {
      if (!isRecord(call)) continue;
      const key = Number(call.index ?? 0);
      const entry = state.toolCalls.get(key) ?? { id: "", name: "", arguments: "" };
      if (asString(call.id)) entry.id = call.id;
      const fn = isRecord(call.function) ? call.function : undefined;
      if (asString(fn?.name)) entry.name = fn.name;
      if (typeof fn?.arguments === "string") entry.arguments += fn.arguments;
      state.toolCalls.set(key, entry);
    }
  }

  if (isRecord(chunk.usage)) state.usage = chunk.usage;
  if (asString(choice?.finish_reason)) state.finishReason = choice.finish_reason;
  return out;
}

function flushToolCalls(out, state) {
  if (!state.toolCalls.size) return;
  closeCurrentBlock(out, state);
  for (const entry of state.toolCalls.values()) {
    if (!entry.name) continue;
    const index = state.blocks.length;
    const id = entry.id || `call_${randomBytes(6).toString("hex")}`;
    const argumentsText = entry.arguments || "{}";
    const block = {
      type: "tool-call",
      id: ToolCallId(id),
      name: entry.name,
      arguments: argumentsText,
    };
    state.blocks.push(block);
    state.replayBlocks.push({ type: "tool-call" });
    state.hasContent = true;
    state.hasToolCall = true;
    out.push({ type: "block-start", index, blockType: "tool-call" });
    out.push({ type: "tool-call-delta", index, id: ToolCallId(id), name: entry.name, argumentsDelta: argumentsText });
    out.push({ type: "block-end", index, block });
  }
  state.toolCalls.clear();
}

async function* streamResponseToChunks(response, model, state) {
  if (!response.body) throw new LlmError("Perch response has no body", "TRANSPORT");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitLine = (line) => processStreamLine(line.replace(/\r$/, ""), state);
  const emitBufferedLines = function* () {
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      yield* emitLine(line);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* emitBufferedLines();
    }
    buffer += decoder.decode();
    yield* emitBufferedLines();
    if (buffer.trim()) yield* emitLine(buffer.trim());

    const out = [];
    flushToolCalls(out, state);
    closeCurrentBlock(out, state);
    yield* out;

    if (state.usage) {
      yield { type: "usage", usage: mapUsage(state.usage) };
    }
    yield {
      type: "finish",
      reason: finishReasonOf(state.finishReason, state.hasToolCall, state.hasContent),
      replayState: replayStateOf(model, state.replayBlocks),
    };
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore upstream cleanup failure.
    }
  }
}

function mapUsage(usage) {
  const inputTokens = Math.max(0, Number(usage.prompt_tokens ?? usage.input_tokens ?? 0));
  const outputTokens = Math.max(0, Number(usage.completion_tokens ?? usage.output_tokens ?? 0));
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  };
}

function finishReasonOf(rawReason, hasToolCall, hasContent) {
  if (!hasContent) {
    return {
      kind: "error",
      failure: { message: "Perch returned a completed response with no content", code: EMPTY_RESPONSE_CODE },
    };
  }
  if (hasToolCall) return { kind: "tool-calls" };
  if (rawReason === "length") return { kind: "max-tokens" };
  if (!rawReason || rawReason === "stop") return { kind: "stop" };
  return {
    kind: "error",
    failure: { message: `Perch finished with reason ${rawReason}`, code: "PERCH_FINISH_REASON" },
  };
}

function replayStateOf(model, replayBlocks) {
  return {
    response: {
      kind: "perch",
      version: 1,
      provider: PROVIDER,
      model: model.id,
      runtimeModel: model.id,
    },
    blocks: replayBlocks,
  };
}

function classifyPerchError(message) {
  if (isContextWindowExceededError(message)) return CONTEXT_WINDOW_EXCEEDED_CODE;
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
  if (/context length|context window|too many tokens/i.test(message)) return CONTEXT_WINDOW_EXCEEDED_CODE;
  if (/quota|rate limit|too many requests/i.test(message)) return QUOTA_EXCEEDED_CODE;
  if (/unauthorized|invalid token|401|403/i.test(message)) return "AUTH";
  return "API";
}

async function ensureAccessToken(store) {
  const credentials = await store.read();
  if (!credentials?.access) {
    throw new LlmError("No Perch credentials. Sign in from Settings > Perch AI.", "AUTH");
  }
  if (!needsRefresh(credentials)) return credentials;
  const refreshed = await store.modify(async (current) => {
    if (!current) throw new LlmError("No Perch credentials. Sign in from Settings > Perch AI.", "AUTH");
    if (!needsRefresh(current)) return current;
    return refreshPerchToken(current);
  });
  return refreshed;
}

async function* requestPerchChunks(options, model, signal, store) {
  if (hasImages(options.messages)) {
    // ponytail: image input needs the durable attachment service; text only for now.
    throw new LlmError(
      `Perch model "${model.id}" accepts text only: image input is not wired to the attachment service yet`,
      "UNSUPPORTED_CONTENT",
    );
  }

  const credentials = await ensureAccessToken(store);
  const base = apiBaseUrl();
  diagnostics.apiBaseUrl = base;
  diagnostics.model = model.id;

  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${credentials.access}`,
    },
    body: JSON.stringify(buildRequest(options, model)),
    signal,
  });
  diagnostics.status = response.status;
  if (!response.ok) {
    const text = await response.text();
    const message = text.slice(0, 300) || response.statusText;
    throw new LlmError(
      `Perch API error (${response.status}, endpoint=${base}): ${redactSecrets(message)}`,
      classifyPerchError(message),
    );
  }

  const state = createStreamState();
  yield* streamResponseToChunks(response, model, state);
  if (!state.hasContent) {
    throw new LlmError("Perch API returned an empty response", EMPTY_RESPONSE_CODE);
  }
}

function hasImages(messages) {
  return messages.some((message) => {
    try {
      return contentHasImage(message.content);
    } catch {
      return false;
    }
  });
}

// ------------------------------------------------------------------- adapter

export class PerchAdapter extends LlmAdapter {
  #store;
  #modelSettings;

  constructor(store = new FileCredentialStore(), modelSettings = new FileModelSettingsStore()) {
    super();
    this.#store = store;
    this.#modelSettings = modelSettings;
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME };
  }

  async listModels(provider) {
    const settings = await this.#modelSettings.read();
    const catalog = await modelCatalog(this.#store);
    return configuredModels(settings, catalog).map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ["text"],
      context: { contextWindow: model.contextWindow },
    }));
  }

  async resolveModel(provider, modelId, signal) {
    if (signal?.aborted) throw new LlmError("perch model resolution aborted", "ABORTED");
    const settings = await this.#modelSettings.read();
    const catalog = await modelCatalog(this.#store);
    const model = modelFromSettings(settings, catalog, modelId);
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ["text"],
      context: { contextWindow: model.contextWindow },
    };
  }

  async *stream(options) {
    const settings = await this.#modelSettings.read();
    const catalog = await modelCatalog(this.#store);
    const model = modelFromSettings(settings, catalog, options.model);

    const consumer = new AbortController();
    const upstream =
      options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
    const watchdog = idleWatchdog(upstream, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE);
    const iterator = requestPerchChunks(options, model, watchdog.signal, this.#store)[Symbol.asyncIterator]();

    let exhausted = false;
    try {
      while (true) {
        const result = await watchdog.next(iterator);
        if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
          throw new LlmError(`perch stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`, "TIMEOUT");
        }
        if (result.done) {
          exhausted = true;
          return;
        }
        yield result.value;
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`perch stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`, "TIMEOUT", { cause: error });
      }
      if (options.signal?.aborted) throw new LlmError("perch request aborted by caller", "ABORTED", { cause: error });
      throw error;
    } finally {
      consumer.abort("perch stream consumer stopped");
      if (!exhausted) {
        try {
          await iterator.return(undefined);
        } catch {
          // Ignore upstream cleanup failure after consumer cancellation.
        }
      }
      watchdog[Symbol.dispose]();
    }
  }
}

// ------------------------------------------------------------------- web api

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function sendMethodNotAllowed(response) {
  sendJson(response, 405, { ok: false, error: "method-not-allowed" });
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const parsed = safeJsonParse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(parsed)) throw new Error("invalid JSON request body");
  return parsed;
}

function modelOptionsPayload(settings, catalog) {
  const enabled = enabledModelSet(settings);
  return {
    enabledModelIds: [...enabled],
    options: catalog.map((model) => ({
      id: model.id,
      name: model.name,
      inputModalities: ["text"],
      contextWindow: model.contextWindow,
      enabled: enabled.has(model.id),
    })),
  };
}

async function webStatus(store, modelSettings) {
  const credentials = await store.read();
  const catalog = await modelCatalog(store);
  return {
    authenticated: Boolean(credentials?.access),
    email: credentialEmail(credentials),
    expires: credentials?.expires,
    apiBaseUrl: apiBaseUrl(),
    providers: await perchProviderList(),
    login: getWebLoginStatus(),
    models: modelOptionsPayload(await modelSettings.read(), catalog),
  };
}

function emitLlmAdaptersUpdated(ctx) {
  try {
    ctx.emit("llm/adapters-updated");
  } catch (error) {
    setLastError(error);
  }
}

function registerWebApi(ctx, store, modelSettings) {
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "prefix",
          path: "/perchai/api",
          handler: async (request, response) => {
            const url = new URL(request.url || "/", "http://dsh.local");
            const path = url.pathname.replace(/^\/perchai\/api\/?/, "");
            try {
              if (path === "status" || path === "") {
                if (request.method !== "GET") return sendMethodNotAllowed(response);
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings) });
              }
              if (path === "login") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                const value = await beginWebLogin(store, asString(body.provider));
                return sendJson(response, 200, { ok: true, value });
              }
              if (path === "providers") {
                if (request.method !== "GET") return sendMethodNotAllowed(response);
                return sendJson(response, 200, { ok: true, value: { providers: await getPerchProviders() } });
              }
              if (path === "models") {
                if (request.method === "GET") {
                  const catalog = await modelCatalog(store);
                  return sendJson(response, 200, {
                    ok: true,
                    value: modelOptionsPayload(await modelSettings.read(), catalog),
                  });
                }
                if (request.method === "POST") {
                  const body = await readRequestJson(request);
                  if (!Array.isArray(body.enabledModelIds)) {
                    return sendJson(response, 400, { ok: false, error: "enabledModelIds must be an array" });
                  }
                  const settings = await modelSettings.setEnabledModelIds(body.enabledModelIds);
                  emitLlmAdaptersUpdated(ctx);
                  const catalog = await modelCatalog(store);
                  return sendJson(response, 200, {
                    ok: true,
                    value: modelOptionsPayload(settings, catalog),
                  });
                }
                return sendMethodNotAllowed(response);
              }
              if (path === "logout") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                await store.delete();
                modelCache = undefined;
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings) });
              }
              return sendJson(response, 404, { ok: false, error: "not-found" });
            } catch (error) {
              setLastError(error);
              return sendJson(response, 500, { ok: false, error: safeError(error) });
            }
          },
        }),
      "dsh-perchai: web api",
    );
  });
}

export function apply(ctx) {
  const store = new FileCredentialStore(credentialPath());
  const modelSettings = new FileModelSettingsStore(modelSettingsPath());
  const adapter = new PerchAdapter(store, modelSettings);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  registerWebApi(ctx, store, modelSettings);
}

apply.inject = ["llm"];

export default apply;
