import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
const {
  FileCredentialStore,
  FileModelSettingsStore,
  PerchAdapter,
  apply,
  loginPerch,
  summarizeErrorBody,
} = await import("../lib/index.js");

/** Fake Perch: auth config, Supabase token endpoint, OpenAI-compatible gateway. */
async function startFakePerch() {
  const state = { base: "", authUrl: "", tokenRequests: [], chatRequests: [], ticketRequests: [], openAiRequests: [] };
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/perch-terminal/cli-auth/config") {
      return json(200, {
        ok: true,
        appUrl: state.base,
        supabaseUrl: state.base,
        supabaseAnonKey: "sb_publishable_test_key",
        providers: ["google", "github"],
        redirectHost: "127.0.0.1",
      });
    }
    if (url.pathname === "/auth/v1/token") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        state.tokenRequests.push({ body, search: url.search });
        if (state.failToken) {
          return json(400, { code: 400, error_code: "invalid_credentials", msg: "unsupported_grant_type" });
        }
        json(200, {
          access_token: "perch-access-token",
          refresh_token: "perch-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: "user-1", email: "pilot@perchai.app" },
        });
      });
      return;
    }
    if (url.pathname === "/models") {
      return json(200, { object: "list", data: [{ id: "gpt-4o-mini", context_window: 128000 }] });
    }
    if (url.pathname === "/chat/completions") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        state.openAiRequests.push({ body: JSON.parse(body), headers: request.headers });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
        response.write(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\n',
        );
        response.end();
      });
      return;
    }
    if (url.pathname === "/api/perch-terminal/turn-ticket") {
      state.ticketRequests.push(request.headers["x-perch-turn-ticket"] ?? null);
      return json(200, { ok: true, ticket: "perch-turn-ticket", ticketId: "t1", runId: "r1" });
    }
    if (url.pathname === "/api/perch-terminal/model-call") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        state.chatRequests.push({ body: JSON.parse(body), ticket: request.headers["x-perch-turn-ticket"] });
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (JSON.stringify(JSON.parse(body).request.messages).includes("use the tool")) {
          response.write(
            'data: {"type":"tool_call_delta","toolCalls":[{"id":"chatcmpl-tool-1","name":"get_weather","arguments":{"city":"Paris"},"sealed":false,"argumentParseStatus":"parsed_ok"}]}\n\n',
          );
          response.write(
            'data: {"type":"tool_use_end","toolCalls":[{"id":"chatcmpl-tool-1","name":"get_weather","arguments":{"city":"Paris"},"sealed":true,"argumentParseStatus":"parsed_ok"}]}\n\n',
          );
          response.write(
            'data: {"type":"done","ok":true,"text":"","finishReason":"tool_use","usage":{"inputTokens":7,"outputTokens":2}}\n\n',
          );
          response.end();
          return;
        }
        response.write('data: {"type":"answer_delta","text":"he"}\n\n');
        response.write('data: {"type":"answer_delta","text":"llo"}\n\n');
        response.write(
          'data: {"type":"done","ok":true,"text":"hello","finishReason":"stop","usage":{"inputTokens":11,"outputTokens":3,"cacheReadInputTokens":0}}\n\n',
        );
        response.end();
      });
      return;
    }
    return json(404, { error: "not-found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.base = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((resolve) => server.close(resolve));
  return state;
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("Perch login runs the Supabase PKCE flow and stores the session", async () => {
  const perch = await startFakePerch();
  const callbackPort = await freePort();
  process.env.PERCH_APP_URL = perch.base;
  process.env.PERCH_API_BASE_URL = perch.base;
  process.env.PERCH_CALLBACK_PORT = String(callbackPort);

  const dir = await mkdtemp(join(tmpdir(), "dsh-perch-"));
  const store = new FileCredentialStore(join(dir, "perchai-oauth.json"));

  const credentials = await loginPerch(
    store,
    {
      notify(event) {
        assert.equal(event.type, "auth_url");
        const url = new URL(event.url);
        assert.equal(url.origin, perch.base);
        assert.equal(url.pathname, "/auth/v1/authorize");
        assert.equal(url.searchParams.get("provider"), "google");
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.equal(
          url.searchParams.get("redirect_to"),
          `http://127.0.0.1:${callbackPort}/callback`,
        );
        assert.ok(url.searchParams.get("code_challenge"));
        // Stand in for the browser: Supabase sends the code back to the loopback port.
        void fetch(`http://127.0.0.1:${callbackPort}/callback?code=perch-code`);
      },
    },
    "google",
  );

  assert.equal(credentials.email, "pilot@perchai.app");
  assert.equal(credentials.access, "perch-access-token");
  assert.equal(credentials.provider, "google");
  assert.equal(perch.tokenRequests.length, 1);
  // GoTrue wants the grant type in the query string and the auth code as `auth_code`.
  assert.equal(perch.tokenRequests[0].search, "?grant_type=pkce");
  const tokenRequest = JSON.parse(perch.tokenRequests[0].body);
  assert.equal(tokenRequest.auth_code, "perch-code");
  assert.equal(tokenRequest.code, undefined);
  assert.equal(tokenRequest.code_verifier.length, 43);
  assert.equal(tokenRequest.code_verifier.length, 43);

  await store.write(credentials);
  const stored = JSON.parse(await readFile(store.path(), "utf8"));
  assert.equal(stored.refresh, "perch-refresh-token");
  await perch.close();
});

test("adapter streams a Perch hosted-model turn as DSH events", async () => {
  const perch = await startFakePerch();
  process.env.PERCH_APP_URL = perch.base;
  process.env.PERCH_API_BASE_URL = perch.base;

  const dir = await mkdtemp(join(tmpdir(), "dsh-perch-"));
  const store = new FileCredentialStore(join(dir, "perchai-oauth.json"));
  await store.write({
    access: "perch-access-token",
    refresh: "perch-refresh-token",
    expires: Date.now() + 3600_000,
    email: "pilot@perchai.app",
  });
  const settings = new FileModelSettingsStore(join(dir, "perchai-settings.json"));
  await settings.write({ mode: "perch", apiBaseUrl: perch.base });
  const adapter = new PerchAdapter(store, settings);

  const events = [];
  for await (const event of adapter.stream({
    model: "azure-foundry-gpt-6-1-sol",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  })) {
    events.push(event);
  }

  assert.deepEqual(
    events.map((event) => event.type),
    ["block-start", "text-delta", "text-delta", "block-end", "usage", "finish"],
  );
  assert.equal(events[0].blockType, "text");
  assert.equal(events[1].text + events[2].text, "hello");
  assert.deepEqual(events[4].usage, { inputTokens: 11, outputTokens: 3 });
  assert.deepEqual(events[5].reason, { kind: "stop" });

  // The hosted-model gate wants a turn ticket on every call.
  assert.equal(perch.chatRequests[0].ticket, "perch-turn-ticket");
  const request = perch.chatRequests[0].body;
  assert.equal(request.manualModelOptionId, "azure-foundry-gpt-6-1-sol");
  assert.equal(request.lane, "chat");
  assert.deepEqual(request.request.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  await perch.close();
});

function fakeRequest(method, url, body) {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
}

function fakeResponse() {
  const response = { statusCode: 0, body: "", headers: {} };
  response.writeHead = (status, headers) => {
    response.statusCode = status;
    response.headers = headers;
  };
  response.end = (chunk) => {
    response.body = chunk ? String(chunk) : "";
  };
  return response;
}

/** Register the plugin against a fake Cordis + web server and return the api route. */
function mountPlugin() {
  const routes = [];
  const announcements = [];
  const webCtx = {
    effect(fn) {
      return fn();
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  const ctx = {
    llm: {
      registerAdapter(providers) {
        announcements.push(providers);
        const handle = () => {};
        handle.replace = (next) => announcements.push(next);
        return handle;
      },
    },
    inject(_names, fn) {
      fn(webCtx);
    },
    emit() {},
  };
  apply(ctx);
  return { route: routes.find((route) => route.path === "/perchai/api"), announcements };
}

test("a failed token exchange surfaces in the settings status payload", async () => {
  const perch = await startFakePerch();
  const callbackPort = await freePort();
  process.env.PERCH_APP_URL = perch.base;
  process.env.PERCH_API_BASE_URL = perch.base;
  process.env.PERCH_CALLBACK_PORT = String(callbackPort);

  // Supabase rejects a bogus code, exactly like the live project does.
  perch.failToken = true;

  const { route } = mountPlugin();
  assert.ok(route, "the plugin must register its web api route");

  const loginResponse = fakeResponse();
  await route.handler(fakeRequest("POST", "/perchai/api/login", '{"provider":"google"}'), loginResponse);
  assert.equal(loginResponse.statusCode, 200);
  const login = JSON.parse(loginResponse.body).value;
  assert.equal(login.status, "pending");
  assert.match(login.authUrl, /\/auth\/v1\/authorize/);

  // The browser comes back with a code; the exchange then fails. The tab the
  // user is looking at must show that failure, not a bare "callback received".
  const callbackResponse = await fetch(`http://127.0.0.1:${callbackPort}/callback?code=perch-code`);
  const callbackBody = await callbackResponse.text();
  assert.equal(callbackResponse.status, 400);
  assert.match(callbackBody, /Perch sign-in failed/);
  assert.match(callbackBody, /token request failed/);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const statusResponse = fakeResponse();
  await route.handler(fakeRequest("GET", "/perchai/api/status"), statusResponse);
  assert.equal(statusResponse.statusCode, 200);
  const status = JSON.parse(statusResponse.body).value;
  assert.equal(status.login.status, "error");
  assert.match(status.login.error, /token request failed/);
  assert.equal(status.authenticated, false);
  await perch.close();
});

test("enabling a model announces the new topology to the harness", async () => {
  const perch = await startFakePerch();
  process.env.PERCH_APP_URL = perch.base;
  process.env.PERCH_API_BASE_URL = perch.base;

  const { route, announcements } = mountPlugin();
  assert.deepEqual(announcements[0], ["perchai"]);

  const response = fakeResponse();
  await route.handler(
    fakeRequest("POST", "/perchai/api/models", '{"enabledModelIds":["perch-test-model"]}'),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).value.enabledModelIds, ["perch-test-model"]);

  // The route set is re-registered so the harness publishes
  // `llm/adapters-updated` and the DSH web model picker reloads.
  assert.deepEqual(announcements[announcements.length - 1], ["perchai"]);
  await perch.close();
});

test("the gateway endpoint is settable and an HTML reply reads as a wrong endpoint", async () => {
  const perch = await startFakePerch();
  process.env.PERCH_APP_URL = perch.base;
  process.env.PERCH_API_BASE_URL = perch.base;

  const { route } = mountPlugin();
  const response = fakeResponse();
  await route.handler(
    fakeRequest("POST", "/perchai/api/endpoint", JSON.stringify({ apiBaseUrl: `${perch.base}/gateway/v1` })),
    response,
  );
  assert.equal(response.statusCode, 200);
  const value = JSON.parse(response.body).value;
  assert.equal(value.apiBaseUrl, `${perch.base}/gateway/v1`);

  const invalid = fakeResponse();
  await route.handler(fakeRequest("POST", "/perchai/api/endpoint", '{"apiBaseUrl":"ftp://x"}'), invalid);
  assert.equal(invalid.statusCode, 500);

  // The web app answers unknown paths with its HTML shell; that must not be
  // dumped into the chat as markup.
  const summary = summarizeErrorBody("<!DOCTYPE html><html lang=\"en\"><head></head></html>");
  assert.match(summary, /HTML/);
  await perch.close();
});

test("a Perch tool call reaches the harness as a tool-call block", async () => {
  const perch = await startFakePerch();
  process.env.PERCH_APP_URL = perch.base;
  process.env.PERCH_API_BASE_URL = perch.base;

  const dir = await mkdtemp(join(tmpdir(), "dsh-perch-"));
  const store = new FileCredentialStore(join(dir, "perchai-oauth.json"));
  await store.write({
    access: "perch-access-token",
    refresh: "perch-refresh-token",
    expires: Date.now() + 3600_000,
    email: "pilot@perchai.app",
  });
  const settings = new FileModelSettingsStore(join(dir, "perchai-settings.json"));
  await settings.write({ mode: "perch", apiBaseUrl: perch.base });
  const adapter = new PerchAdapter(store, settings);

  const events = [];
  for await (const event of adapter.stream({
    model: "azure-foundry-gpt-6-1-sol",
    messages: [{ role: "user", content: [{ type: "text", text: "use the tool" }] }],
  })) {
    events.push(event);
  }

  const toolCall = events.find((event) => event.type === "tool-call-delta");
  assert.ok(toolCall, "expected a tool-call-delta chunk");
  assert.equal(toolCall.name, "get_weather");
  assert.match(toolCall.argumentsDelta, /Paris/);
  const finish = events.find((event) => event.type === "finish");
  assert.equal(finish.reason.kind, "tool-calls");
  await perch.close();
});

test("the OpenAI-compatible mode talks to the user's own endpoint", async () => {
  const perch = await startFakePerch();
  process.env.PERCH_APP_URL = perch.base;

  const dir = await mkdtemp(join(tmpdir(), "dsh-perch-"));
  const store = new FileCredentialStore(join(dir, "perchai-oauth.json"));
  await store.write({
    access: "perch-access-token",
    refresh: "perch-refresh-token",
    expires: Date.now() + 3600_000,
    email: "pilot@perchai.app",
  });
  const settings = new FileModelSettingsStore(join(dir, "perchai-settings.json"));
  await settings.write({ mode: "openai", apiBaseUrl: perch.base, apiKey: "sk-user-key" });
  const adapter = new PerchAdapter(store, settings);

  const events = [];
  for await (const event of adapter.stream({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  })) {
    events.push(event);
  }

  assert.equal(events[1].text + events[2].text, "hello");
  assert.deepEqual(perch.openAiRequests[0].headers.authorization, "Bearer sk-user-key");
  assert.equal(perch.openAiRequests[0].body.model, "gpt-4o-mini");
  await perch.close();
});
