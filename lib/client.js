window.__ModuleLoader__.load({
  id: "dsh-perchai",
  factory(require) {
    const React = require("react");
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const STYLE_ID = "dsh-perchai-settings-style";
    // Settings pages that want to follow the harness model topology in realtime.
    const modelTopologyListeners = new Set();
    const STATUS_POLL_MS = 30000;
    const API = "/perchai/api";
    const NS = "dsh-perchai";
    // The Perch mark (chat.perchai.app/icon), inlined so the settings page
    // needs no extra request.
    const PERCH_MARK =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAABcElEQVR4nGNgGAWjYBTgADaVwTG2lYEzCeOgiTZVQdV2lUGODPX1TAzUArYgw6uC/pOCbaoCb4MdQmUH/LOtCnqHB/9DdUjgL9vqQCfqOaAy6Cs+dVr1oWz2FaEqNpWBbTaVQb+hDrlJcXTYEukAZGBTFdgMCwmrqmATmjtAUkTgDQjD+NbVwQ4wB9QkGC+aGaRRNzNY03xVKAMzXRxgVxnkCHdAHB0cgA5sq4Ja6RoFsERoVxOkalsZ1AFPhJWBN6iXCKtIzIaVgT9BaYEiy8ktiEDZz6YywJ6BGsAW6gBwsOIpim2qAifYVgVVgi2mSVFcSXwipCqwRXPAlmRDze1Jun50d4B9ZdDXWUGapatj9Eq2Jus1090BDhWBX2cFqj+cGaRWx0BPkJtqU5eeZnsoM81u94A4YGagxsxZQRr/Zwepf50ZqD5rVoBa2IA4YFaQ+sDkgpmjDggcjQKNkZ4I/dV1Zwaqh84K0PChpUUAXKpjQMAtF/AAAAAASUVORK5CYII=";

    const zh = {
      pageDesc: "登录 Perch AI，查看可用模型并在 DSH 中启用它们。",
      currentAccount: "当前账号",
      login: "登录",
      loggingIn: "登录中...",
      refresh: "刷新",
      refreshing: "刷新中...",
      logout: "退出",
      loading: "Loading...",
      notSignedIn: "未登录",
      notSignedInDesc: "点击登录后会在浏览器中完成 Perch 登录，登录成功后即可使用模型。",
      provider: "登录方式",
      endpoint: "接口地址",
      modelSelector: "模型选择器",
      modelSelectorDesc: "勾选后会出现在 DSH 的 Perch AI 模型列表中。",
      selectAll: "全选",
      unselectAll: "全不选",
      loadingModels: "正在加载模型配置...",
      modelSelectorNote: "勾选即自动保存。重新打开模型选择器即可看到最新列表；运行中的旧会话不受影响。",
      loginFailed: "登录失败",
    };

    const en = {
      pageDesc: "Sign in to Perch AI and pick the models DSH should offer.",
      currentAccount: "Current Account",
      login: "Sign in",
      loggingIn: "Signing in...",
      refresh: "Refresh",
      refreshing: "Refreshing...",
      logout: "Sign out",
      loading: "Loading...",
      notSignedIn: "Not signed in",
      notSignedInDesc: "Click Sign in to complete Perch sign-in in your browser. Models appear here after login.",
      provider: "Sign-in provider",
      endpoint: "Endpoint",
      modelSelector: "Model Selector",
      modelSelectorDesc: "Checked models will appear in DSH's Perch AI model list.",
      selectAll: "Select all",
      unselectAll: "Deselect all",
      loadingModels: "Loading model configuration...",
      modelSelectorNote: "Changes are saved automatically. Reopen the model picker to see the updated list; running sessions are unaffected.",
      loginFailed: "Login failed",
    };

    function createTranslator(ctx) {
      const boundT = (ctx && ctx.locale && typeof ctx.locale.bind === "function")
        ? ctx.locale.bind(NS)
        : null;

      return function t(key, params) {
        if (boundT) {
          try {
            const res = boundT(key, params);
            if (res && res !== key && res !== `${NS}.${key}`) return res;
          } catch (_) {}
        }
        const active = (ctx && ctx.locale && typeof ctx.locale.getLocale === "function")
          ? ctx.locale.getLocale()?.active
          : null;
        const isZh = active ? active.startsWith("zh") : (typeof navigator !== "undefined" && navigator.language && navigator.language.startsWith("zh"));
        const dict = isZh ? zh : en;
        let text = dict[key] || en[key] || zh[key] || key;
        if (params && typeof params === "object") {
          for (const [k, v] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
          }
        }
        return text;
      };
    }

    function patchNavIcon() {
      const spans = document.querySelectorAll("span");
      for (const span of spans) {
        if (span.textContent && span.textContent.trim() === "Perch AI") {
          const btn = span.closest("button");
          if (btn) {
            if (btn.querySelector("img.dsha-nav-mark")) continue;
            const svg = btn.querySelector("svg");
            if (!svg) continue;
            const mark = document.createElement("img");
            mark.className = "dsha-nav-mark";
            mark.src = PERCH_MARK;
            mark.width = 16;
            mark.height = 16;
            mark.alt = "Perch AI";
            svg.replaceWith(mark);
          }
        }
      }
    }

    function initNavObserver() {
      patchNavIcon();
      if (window.__perchNavObserver) return;
      const observer = new MutationObserver(() => {
        patchNavIcon();
      });
      observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
      window.addEventListener("click", patchNavIcon, true);
      window.setInterval(patchNavIcon, 300);
      window.__perchNavObserver = observer;
    }

    function installStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
.dsha-wrap{box-sizing:border-box;width:100%;max-width:760px;padding:0 0 24px;color:#111827}
.dsha-page-head{display:flex;align-items:center;gap:10px}
.dsha-brand-icon{color:#111827;flex-shrink:0}
.dsha-page-title{margin:0;color:#111827;font-size:20px;font-weight:700;line-height:28px}
.dsha-page-desc{margin:8px 0 18px;color:#8b93a1;font-size:13px;line-height:20px}
.dsha-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;box-shadow:none}
.dsha-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.dsha-title{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:700;color:#111827}
.dsha-ok{width:18px;height:18px;border-radius:999px;border:2px solid #10b981;position:relative;flex:0 0 auto}
.dsha-ok:after{content:"";position:absolute;left:4px;top:2px;width:6px;height:9px;border:solid #10b981;border-width:0 2px 2px 0;transform:rotate(45deg)}
.dsha-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.dsha-btn{border:1px solid #d7dce3;background:#fff;color:#111827;border-radius:10px;padding:7px 12px;font-size:13px;line-height:18px;cursor:pointer}
.dsha-btn:hover{background:#f7f8fa}
.dsha-btn:disabled{cursor:not-allowed;opacity:.55}
.dsha-btn-primary{border-color:#111827;background:#111827;color:white}
.dsha-btn-primary:hover{background:#272d38}
.dsha-account{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;padding:12px;border:1px solid #eef1f5;border-radius:10px;background:#fafbfc;color:#4b5563}
.dsha-email{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:650;min-width:0}
.dsha-email-mark{width:16px;height:12px;border:1.8px solid #7f8a9a;border-radius:3px;position:relative;flex:0 0 auto}
.dsha-email-mark:before{content:"";position:absolute;left:1px;right:1px;top:1px;height:7px;border-bottom:1.8px solid #7f8a9a;transform:skewY(-28deg)}
.dsha-email-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsha-badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;background:#eef2ff;color:#3f46d8;border:1px solid #dfe5ff;padding:4px 9px;font-size:12px;font-weight:800;letter-spacing:.02em}
.dsha-diamond{width:8px;height:8px;border-radius:2px;background:#4f5bf6;transform:rotate(45deg)}
.dsha-group-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.dsha-group-title{font-size:13px;font-weight:700;color:#111827}
.dsha-group-desc{font-size:12px;color:#8b93a1}
.dsha-row{padding:8px 0;border-top:1px solid #edf1f5}
.dsha-row:first-of-type{border-top:0;padding-top:0}
.dsha-rowtop{display:flex;align-items:baseline;justify-content:space-between;gap:12px;color:#4b5563;font-weight:600;font-size:13px}
.dsha-metrics{display:flex;align-items:baseline;gap:10px;white-space:nowrap;color:#8b93a1;font-size:12px}
.dsha-percent{font-size:13px;font-weight:750;color:#059669}
.dsha-percent-cyan{color:#0284c7}
.dsha-bar{height:6px;margin-top:6px;border-radius:999px;background:#edf1f5;overflow:hidden}
.dsha-fill{height:100%;border-radius:999px;background:#10b981}
.dsha-fill-cyan{background:#06b6d4}
.dsha-empty{border:1px dashed #d8dee8;border-radius:10px;padding:14px;color:#747f90;background:#fafbfc;font-size:13px;line-height:20px}
.dsha-error{margin-top:12px;color:#991b1b;background:#fff5f5;border:1px solid #fecaca;border-radius:10px;padding:10px 12px;font-size:13px;white-space:pre-wrap}
.dsha-note{margin-top:12px;color:#8b93a1;font-size:12px;line-height:18px}
.dsha-model-card{margin-top:14px}
.dsha-model-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
.dsha-model-title{font-size:14px;font-weight:700;color:#111827}
.dsha-model-desc{margin-top:3px;color:#8b93a1;font-size:12px;line-height:18px}
.dsha-mini-actions{display:flex;gap:8px;white-space:nowrap}
.dsha-mini-btn{border:0;background:transparent;color:#4f5bf6;font-size:12px;line-height:18px;cursor:pointer;padding:0}
.dsha-mini-btn:hover{text-decoration:underline}
.dsha-model-list{border:1px solid #eef1f5;border-radius:10px;overflow:hidden}
.dsha-model-row{display:flex;align-items:flex-start;gap:10px;padding:11px 14px;background:#fff;border-top:1px solid #eef1f5;cursor:pointer}
.dsha-model-row:hover{background:#fafbfc}
.dsha-model-row:first-child{border-top:0}
.dsha-check{margin-top:1px;width:16px;height:16px;accent-color:#111827;flex:0 0 auto}
.dsha-model-text{min-width:0;flex:1 1 auto}
.dsha-model-name{display:block;font-size:13px;font-weight:650;color:#111827;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsha-model-sub{display:block;margin-top:3px;color:#9aa3b0;font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;
      document.head.append(style);
    }

    async function api(path, options) {
      const response = await fetch(`${API}${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          ...(options && options.headers ? options.headers : {}),
        },
      });
      const body = await response.json().catch(() => ({ ok: false, error: "invalid-json" }));
      if (!response.ok || !body.ok) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      return body.value;
    }

    function PerchIcon({ size = 20, className = "" }) {
      return React.createElement("img", {
        className,
        src: PERCH_MARK,
        width: size,
        height: size,
        alt: "Perch AI",
        style: { flexShrink: 0, objectFit: "contain" },
      });
    }

    function compareModelOptions(a, b) {
      const aEnabled = Boolean(a && a.enabled);
      const bEnabled = Boolean(b && b.enabled);
      if (aEnabled !== bEnabled) return aEnabled ? -1 : 1;
      return (a.name || a.id || "").localeCompare(b.name || b.id || "") || (a.id || "").localeCompare(b.id || "");
    }

    function modelMeta(option) {
      const parts = [];
      if (Array.isArray(option.inputModalities) && option.inputModalities.includes("image")) parts.push("image");
      if (typeof option.contextWindow === "number") parts.push(`${Math.round(option.contextWindow / 1000)}k ctx`);
      return parts.join(" · ");
    }

    function ModelOptionRow({ option, disabled, onToggle, t }) {
      return React.createElement("label", { className: "dsha-model-row" },
        React.createElement("input", {
          className: "dsha-check",
          type: "checkbox",
          checked: !!option.enabled,
          disabled,
          onChange: (event) => onToggle(option.id, event.target.checked),
        }),
        React.createElement("span", { className: "dsha-model-text" },
          React.createElement("span", { className: "dsha-model-name" }, option.name || option.id),
          React.createElement("span", { className: "dsha-model-sub" }, modelMeta(option, t) || option.id),
        ),
      );
    }

    function PerchSettings({ ctx }) {
      const [, setLocaleRev] = useState(0);
      useEffect(() => {
        if (!ctx || !ctx.locale || typeof ctx.locale.subscribe !== "function") return;
        return ctx.locale.subscribe(() => {
          setLocaleRev((r) => r + 1);
        });
      }, [ctx]);

      const tr = useMemo(() => createTranslator(ctx), [ctx]);

      const [status, setStatus] = useState({ loading: true });
      const [modelConfig, setModelConfig] = useState(undefined);
      const [provider, setProvider] = useState("");
      const [busy, setBusy] = useState(false);
      const [modelBusy, setModelBusy] = useState(false);
      const [error, setError] = useState("");
      const pollRef = useRef(undefined);

      const refreshStatus = useCallback(async () => {
        const value = await api("/status");
        setStatus({ loading: false, ...value });
        if (value.models) setModelConfig(value.models);
        return value;
      }, []);

      useEffect(() => {
        installStyle();
        initNavObserver();
        patchNavIcon();
        let cancelled = false;
        void refreshStatus().catch((err) => {
          if (!cancelled) {
            setStatus({ loading: false, authenticated: false });
            setError(err instanceof Error ? err.message : String(err));
          }
        });
        // Follow the harness model topology: the host publishes
        // `llm/adapters-updated` when the enabled model set changes, and the
        // web client forwards it here.
        const onTopology = () => {
          void refreshStatus().catch(() => {});
        };
        modelTopologyListeners.add(onTopology);
        const poll = window.setInterval(onTopology, STATUS_POLL_MS);
        return () => {
          cancelled = true;
          modelTopologyListeners.delete(onTopology);
          window.clearInterval(poll);
          if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
        };
      }, [refreshStatus]);

      const providers = useMemo(() => {
        const list = status && status.providers;
        return Array.isArray(list) && list.length ? list : [];
      }, [status]);

      const startLogin = useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const chosen = provider && providers.includes(provider) ? provider : providers[0];
          const value = await api("/login", {
            method: "POST",
            body: JSON.stringify(chosen ? { provider: chosen } : {}),
          });
          if (value.authUrl) window.open(value.authUrl, "_blank", "noopener,noreferrer");
          if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
          pollRef.current = window.setInterval(async () => {
            try {
              const next = await refreshStatus();
              if (next.login && next.login.status === "complete") {
                window.clearInterval(pollRef.current);
                pollRef.current = undefined;
              }
              if (next.login && next.login.status === "error") {
                window.clearInterval(pollRef.current);
                pollRef.current = undefined;
                setError(next.login.error || tr("loginFailed"));
              }
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }, 2000);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }, [provider, providers, refreshStatus, tr]);

      const logout = useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const value = await api("/logout", { method: "POST" });
          setStatus({ loading: false, ...value });
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }, []);

      const saveModels = useCallback(async (enabledModelIds) => {
        setModelBusy(true);
        setError("");
        try {
          const value = await api("/models", {
            method: "POST",
            body: JSON.stringify({ enabledModelIds }),
          });
          setModelConfig(value);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setModelBusy(false);
        }
      }, []);

      const toggleModel = useCallback((modelId, enabled) => {
        const current = new Set(modelConfig && Array.isArray(modelConfig.enabledModelIds) ? modelConfig.enabledModelIds : []);
        if (enabled) current.add(modelId);
        else current.delete(modelId);
        void saveModels([...current]);
      }, [modelConfig, saveModels]);

      const setAllModels = useCallback((enabled) => {
        const ids = enabled && modelConfig && Array.isArray(modelConfig.options)
          ? modelConfig.options.map((option) => option.id)
          : [];
        void saveModels(ids);
      }, [modelConfig, saveModels]);

      const modelOptions = useMemo(() => {
        const options = modelConfig && Array.isArray(modelConfig.options) ? modelConfig.options : [];
        return [...options].sort(compareModelOptions);
      }, [modelConfig]);
      const email = status.email || (status.loading ? tr("loading") : tr("notSignedIn"));
      const endpoint = status.apiBaseUrl || "";
      // The server owns the login outcome: render it whenever it is there,
      // not only when the polling happens to catch the transition.
      const loginError =
        status.login && status.login.status === "error" ? status.login.error || tr("loginFailed") : "";

      return React.createElement("div", { className: "dsha-wrap" },
        React.createElement("div", { className: "dsha-page-head" },
          React.createElement(PerchIcon, { size: 24, className: "dsha-brand-icon" }),
          React.createElement("h2", { className: "dsha-page-title" }, "Perch AI"),
        ),
        React.createElement("p", { className: "dsha-page-desc" }, tr("pageDesc")),
        React.createElement("section", { className: "dsha-card" },
          React.createElement("div", { className: "dsha-head" },
            React.createElement("div", { className: "dsha-title" },
              React.createElement(PerchIcon, { size: 18, className: "dsha-brand-icon" }),
              React.createElement("span", null, tr("currentAccount")),
            ),
            React.createElement("div", { className: "dsha-actions" },
              !status.authenticated && React.createElement("button", { className: "dsha-btn dsha-btn-primary", disabled: busy, onClick: startLogin }, busy ? tr("loggingIn") : tr("login")),
              status.authenticated && React.createElement("button", { className: "dsha-btn dsha-btn-primary", disabled: busy, onClick: refreshStatus }, busy ? tr("refreshing") : tr("refresh")),
              status.authenticated && React.createElement("button", { className: "dsha-btn", disabled: busy, onClick: logout }, tr("logout")),
            ),
          ),
          React.createElement("div", { className: "dsha-account" },
            React.createElement("div", { className: "dsha-email" },
              React.createElement("span", { className: "dsha-email-mark", "aria-hidden": "true" }),
              React.createElement("span", { className: "dsha-email-text" }, email),
            ),
          ),
          !status.authenticated && providers.length > 0 && React.createElement("div", { className: "dsha-account" },
            React.createElement("div", { className: "dsha-email" },
              React.createElement("span", { className: "dsha-email-text" }, tr("provider")),
            ),
            React.createElement("select", {
              className: "dsha-btn",
              value: provider || providers[0],
              onChange: (event) => setProvider(event.target.value),
            }, providers.map((item) => React.createElement("option", { key: item, value: item }, item === "github" ? "GitHub" : "Google"))),
          ),
          endpoint && React.createElement("div", { className: "dsha-note" },
            `${tr("endpoint")}: ${endpoint}`,
          ),
          !status.authenticated && React.createElement("div", { className: "dsha-empty" }, tr("notSignedInDesc")),
          (error || loginError) && React.createElement("div", { className: "dsha-error" }, error || loginError),
        ),
        React.createElement("section", { className: "dsha-card dsha-model-card" },
          React.createElement("div", { className: "dsha-model-head" },
            React.createElement("div", null,
              React.createElement("div", { className: "dsha-model-title" }, tr("modelSelector")),
              React.createElement("div", { className: "dsha-model-desc" }, tr("modelSelectorDesc")),
            ),
            React.createElement("div", { className: "dsha-mini-actions" },
              React.createElement("button", { className: "dsha-mini-btn", disabled: modelBusy, onClick: () => setAllModels(true) }, tr("selectAll")),
              React.createElement("button", { className: "dsha-mini-btn", disabled: modelBusy, onClick: () => setAllModels(false) }, tr("unselectAll")),
            ),
          ),
          modelOptions.length === 0
            ? React.createElement("div", { className: "dsha-empty" }, tr("loadingModels"))
            : React.createElement("div", { className: "dsha-model-list" },
                modelOptions.map((option) => React.createElement(ModelOptionRow, {
                  key: option.id,
                  option,
                  disabled: modelBusy,
                  onToggle: toggleModel,
                  t: tr,
                })),
              ),
          React.createElement("div", { className: "dsha-note" }, tr("modelSelectorNote")),
        ),
      );
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        installStyle();
        initNavObserver();
        if (ctx.locale && typeof ctx.locale.register === "function") {
          ctx.locale.register(NS, { zh, en });
        }
        // The host publishes `llm/adapters-updated`; the web client forwards
        // it on the remote channel, so this settings page follows the same
        // realtime model topology as the DSH model picker.
        const remote = ctx.remote || (typeof ctx.get === "function" ? ctx.get("remote") : undefined);
        if (remote && typeof remote.$on === "function") {
          remote.$on("llm/adapters-updated", () => {
            for (const listener of [...modelTopologyListeners]) {
              try {
                listener();
              } catch (_) {}
            }
          });
        }
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "perchai",
          order: 12,
          label: () => "Perch AI",
        }, (props) => React.createElement(PerchSettings, { ...props, ctx })));
      },
    };
  },
});
