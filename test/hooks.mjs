export async function resolve(specifier, context, nextResolve) {
  const stubs = new URL("./stubs/", import.meta.url);
  const target = {
    "@deepseek-ai/dsh-llm": new URL("dsh-llm.js", stubs).href,
    "@deepseek-ai/dsh-home-paths": new URL("dsh-home-paths.js", stubs).href,
    "@deepseek-ai/dsh-timeout": new URL("dsh-timeout.js", stubs).href,
  }[specifier];
  if (target) return { url: target, shortCircuit: true };
  return nextResolve(specifier, context);
}
