# dsh-perchai

English | [简体中文](./README.zh.md)

Perch AI model provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This is a DSH Web plugin. It registers a DSH `LlmAdapter` under provider route
`perchai`, signs the user in with **Perch AI's own OAuth** (the same Supabase
PKCE flow the official `perch login` CLI uses), stores the session under DSH
home, and talks to the Perch OpenAI-compatible gateway.

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
| `PERCH_API_BASE_URL` | `https://chat.perchai.app/api/perch/v1` | OpenAI-compatible gateway base URL |
| `PERCH_APP_URL` | `https://app.perchai.app` | Host serving `/api/perch-terminal/cli-auth/config` |
| `PERCH_WEB_URL` | `https://chat.perchai.app` | Perch web app (browser sign-in) |
| `PERCH_CALLBACK_PORT` | `51121` | Loopback port that receives the OAuth redirect |

The gateway must accept the Perch session token as `Authorization: Bearer <access token>`
and speak the OpenAI chat-completions protocol (`GET /models`, `POST /chat/completions`,
SSE streaming).

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

The model list comes from the gateway (`GET {PERCH_API_BASE_URL}/models`).
Enable the models you want in **Settings > Perch AI > Model Selector**; only
enabled models show up in DSH's model picker under the **Perch AI** provider.

If the gateway cannot be reached, the plugin falls back to a small built-in
list so the picker is never empty.

## Realtime model topology

The plugin owns the `perchai` provider route, so the model list it exposes is
part of the harness topology:

- Enabling or disabling a model re-registers the route set, which publishes
  the harness-wide `llm/adapters-updated` event. The remote bridge forwards it
  and the DSH web client reloads its model catalog, so the model picker follows
  the settings page immediately.
- A background poll re-reads `GET {PERCH_API_BASE_URL}/models` every minute and
  announces the change the same way, so models added or removed on the Perch
  gateway appear in DSH without a restart.
- The settings page itself listens for `llm/adapters-updated` on the client
  channel and refreshes its own list, so both surfaces show the same state.

## License

MIT
