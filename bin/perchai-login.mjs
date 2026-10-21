#!/usr/bin/env node
import {
  FileCredentialStore,
  credentialPath,
  loginAndSave,
  terminalInteraction,
} from "../lib/index.js";

const controller = new AbortController();
const args = process.argv.slice(2);
const logout = args.includes("--logout");
const provider = args.find((arg) => arg.startsWith("--provider="))?.split("=")[1];

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.once(signalName, () => {
    controller.abort(new Error(`${signalName} received`));
  });
}

try {
  const store = new FileCredentialStore(credentialPath());
  if (logout) {
    await store.delete();
    console.log(`Removed Perch credentials from ${store.path()}`);
    process.exit(0);
  }
  const credentials = await loginAndSave(store, terminalInteraction(controller.signal), provider);
  const suffix = credentials.email ? ` for ${credentials.email}` : "";
  console.log(`Perch login complete${suffix}.`);
  console.log(`Credentials saved to ${store.path()}`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Perch login failed: ${detail}`);
  process.exitCode = 1;
}
