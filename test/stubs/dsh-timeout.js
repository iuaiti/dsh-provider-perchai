export function idleWatchdog(signal) {
  return {
    signal,
    async next(iterator) {
      return iterator.next();
    },
    [Symbol.dispose]() {},
  };
}

export function timeoutOf() {
  return undefined;
}
