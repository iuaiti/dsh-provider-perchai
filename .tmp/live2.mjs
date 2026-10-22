import { PerchAdapter, FileCredentialStore, FileModelSettingsStore } from "../lib/index.js";
const settings = new FileModelSettingsStore("/tmp/perchai-settings-test.json");
await settings.write({
  mode: "openai",
  apiBaseUrl: "https://text.pollinations.ai/openai",
  apiKey: "",
  enabledModelIds: ["openai-fast"],
});
const adapter = new PerchAdapter(
  new FileCredentialStore("/home/test/.dsh/storages/perchai-oauth.json"),
  settings,
);
console.log("catalog:", (await adapter.listModels("perchai")).map((m) => m.id));
let text = "";
for await (const event of adapter.stream({
  model: "openai-fast",
  messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: byok works" }] }],
})) {
  if (event.type === "text-delta") text += event.text;
}
console.log("TEXT:", text.slice(0, 120));
