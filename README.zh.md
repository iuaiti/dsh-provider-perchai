# dsh-perchai

[English](./README.md) | 简体中文

适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Perch AI 模型提供商插件。

这是一个 DSH Web 插件。它在 provider 路由 `perchai` 下注册 DSH `LlmAdapter`，使用 **Perch AI 自己的 OAuth**（与官方 `perch login` CLI 完全相同的 Supabase PKCE 流程）登录，会话凭证存储于 DSH home 目录下，模型请求走 Perch 的 OpenAI 兼容网关。Web 设置页面完整支持中英文双语国际化（i18n）。

> Perch AI 是独立产品，拥有自己的账号与套餐。本插件只使用你在此登录的账号。

---

## 安装到 DSH Web

```sh
dsh plugin --profile web add github:iuaiti/dsh-provider-perchai
```

也可以手动复制到 Web profile：

```sh
cp -R dsh-perchai "$DSH_HOME/profiles/web/node_modules/"
```

然后在 profile 的 `cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: dsh-perchai
      name: dsh-perchai
```

重启 DSH：

```sh
dsh web
```

## 配置

| 变量 | 默认值 | 含义 |
|---|---|---|
| `PERCH_API_BASE_URL` | `https://chat.perchai.app/api/perch/v1` | OpenAI 兼容网关地址 |
| `PERCH_APP_URL` | `https://app.perchai.app` | 提供 `/api/perch-terminal/cli-auth/config` 的主机 |
| `PERCH_WEB_URL` | `https://chat.perchai.app` | Perch 网页端（浏览器登录） |
| `PERCH_CALLBACK_PORT` | `51121` | 接收 OAuth 回跳的本地端口 |

网关需要接受 Perch 会话令牌（`Authorization: Bearer <access token>`），并支持 OpenAI chat-completions 协议（`GET /models`、`POST /chat/completions`、SSE 流式）。

## 登录

打开 **设置（Settings）> Perch AI**，选择登录方式（Google / GitHub，以 Perch 实际提供的为准），点击 **登录（Sign in）**。浏览器完成 Perch 登录后，会话保存在：

```text
$DSH_HOME/storages/perchai-oauth.json
```

请勿公开该文件，其中包含 access / refresh token。

插件会监听 `http://127.0.0.1:51121/callback` 接收 OAuth 回跳，因此浏览器需与 DSH 运行在同一台机器。如果 Web 服务无法自动唤起浏览器，可在同机器终端运行命令行登录助手：

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-perchai/bin/perchai-login.mjs"
node "$DSH_HOME/profiles/web/node_modules/dsh-perchai/bin/perchai-login.mjs" --provider=github
node "$DSH_HOME/profiles/web/node_modules/dsh-perchai/bin/perchai-login.mjs" --logout
```

## 模型

模型列表来自网关（`GET {PERCH_API_BASE_URL}/models`）。在 **设置 > Perch AI > 模型选择器** 中勾选需要的模型，只有被启用的模型才会出现在 DSH 模型选择器的 **Perch AI** 提供方下。

网关不可用时，插件会回退到内置的少量模型，保证选择器不为空。

## 模型拓扑实时同步

插件独占 `perchai` 这条 provider 路由，因此它暴露的模型列表属于 harness 拓扑的一部分：

- 勾选/取消模型会重新注册路由集合，触发 harness 全局的 `llm/adapters-updated` 事件；remote bridge 转发后，DSH web 端会重新加载模型目录，模型选择器随即同步。
- 后台每分钟重新读取一次 `GET {PERCH_API_BASE_URL}/models`，有变化同样广播，Perch 网关新增/下线的模型无需重启 DSH 就能出现。
- 设置页自身也监听 client 通道上的 `llm/adapters-updated` 并刷新列表，两个界面状态始终一致。

## License

MIT
