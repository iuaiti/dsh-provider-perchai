# dsh-perchai

English | [简体中文](./README.zh.md)

Perch AI model provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This is a DSH Web plugin. It registers a DSH `LlmAdapter` under provider route
`perchai`, signs the user in with **Perch AI's own OAuth** (the same Supabase
PKCE flow the official `perch login` CLI uses), stores the session under DSH
home, and talks to Perch's hosted-model gateway.

> Perch AI is a separate product with its own accounts and plans. This plugin
> only uses the account you sign in with here.

## Install into DSH Web

```sh
dsh plugin --profile web add github:iuaiti/dsh-provider-perchai
```

Or copy the package into the Web profile manually:

```sh
cp -R dsh-perchai "$DSH_HOME/profiles/web/node_modules/"
```

Then add the plugin to the profile `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-perchai
      name: dsh-perchai
```

Restart DSH:

```sh
dsh web
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PERCH_API_BASE_URL` | `https://app.perchai.app` | Perch-hosted gateway base URL (the gateway paths hang off it) |
| `PERCH_APP_URL` | `https://app.perchai.app` | Host serving `/api/perch-terminal/cli-auth/config` |
| `PERCH_WEB_URL` | `https://chat.perchai.app` | Perch web app (browser sign-in) |
| `PERCH_CALLBACK_PORT` | `51121` | Loopback port that receives the OAuth redirect |

The plugin has two model sources, chosen in **Settings > Perch AI**:

**Perch-hosted models** (the account's own models, metered by Perch)

Perch has no OpenAI-compatible `/v1` surface: hosted model access runs through
its own gateway, gated by a per-turn ticket.

- `POST {base}/api/perch-terminal/turn-ticket` — mints the turn ticket; the
  session token goes in as `Authorization: Bearer <access token>`.
- `POST {base}/api/perch-terminal/model-call` — the turn itself, with the
  ticket in `x-perch-turn-ticket` and the model option id in
  `manualModelOptionId`. The answer is an SSE stream of Perch events
  (`answer_delta`, `reasoning_delta`, `tool_call_delta`, `tool_use_end`,
  `done`); tool calls use the OpenAI function-call shape.

Perch limits hosted models to its own Web/Desktop/CLI surfaces: an account
without direct API access gets `403 perch_surface_required` here.

**Your own key** (any OpenAI-compatible endpoint)

The "bring your own key" path Perch documents: set a base URL, an API key and
pick the models. The plugin then speaks plain `POST {base}/chat/completions`
(SSE) and reads the model list from `GET {base}/models`. Both the `Authorization:
Bearer` and `api-key` headers are sent when a key is set, so OpenAI-style and
Azure-style gateways both work; a keyless local gateway works too.

## Login

Open **Settings > Perch AI**, pick a sign-in provider (Google / GitHub, whatever
Perch offers) and click **Sign in**. The browser completes the Perch sign-in and
the session lands in:

```text
$DSH_HOME/storages/perchai-oauth.json
```

Keep that file private. It contains the access and refresh tokens.

The plugin opens a loopback listener at `http://127.0.0.1:51121/callback` to
receive the OAuth redirect, so the browser must run on the same machine as DSH.
If the Web service cannot open a browser, use the terminal helper instead:

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-perchai/bin/perchai-login.mjs"
node "$DSH_HOME/profiles/web/node_modules/dsh-perchai/bin/perchai-login.mjs" --provider=github
node "$DSH_HOME/profiles/web/node_modules/dsh-perchai/bin/perchai-login.mjs" --logout
```

## Models

Perch exposes no model list, so in the hosted mode the plugin ships Perch's
model options (the ids the gateway routes on). In the own-key mode the model
list comes from `GET {base}/models`. Enable the models you want in
**Settings > Perch AI > Model Selector**; only enabled models show up in DSH's
model picker under the **Perch AI** provider.

## Realtime model topology

The plugin owns the `perchai` provider route, so the model list it exposes is
part of the harness topology:

- Enabling or disabling a model re-registers the route set, which publishes
  the harness-wide `llm/adapters-updated` event. The remote bridge forwards it
  and the DSH web client reloads its model catalog, so the model picker follows
  the settings page immediately.
- The settings page polls the plugin's own status every 30 seconds, so both
  surfaces keep showing the same state.
- The settings page itself listens for `llm/adapters-updated` on the client
  channel and refreshes its own list, so both surfaces show the same state.

## License

MIT
