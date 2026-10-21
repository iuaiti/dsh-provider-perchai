export function dshHomePath(...parts) {
  return ["/tmp/dsh-home", ...parts].join("/");
}
