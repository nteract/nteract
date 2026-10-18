// The server owns refresh tokens. This browser only renews its same-origin cookie.
export function maintainBrowserSession({
  request,
  onSession,
  onError,
  document = globalThis.document,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  let stopped = false,
    pending,
    timer,
    keepAlive = true;
  function refresh() {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    clearTimeout(timer);
    pending = (async () => {
      try {
        const result = await request();
        if (!stopped) {
          keepAlive = !!result.identity;
          onSession(result);
        }
        return result;
      } catch (error) {
        if (!stopped) {
          if (error.status === 401 || error.status === 403) {
            keepAlive = false;
            onSession({ identity: null, canWrite: false });
          } else onError(error);
        }
        throw error;
      } finally {
        pending = undefined;
        if (!stopped && keepAlive) timer = setTimeout(() => refresh().catch(() => {}), 60_000);
      }
    })();
    return pending;
  }
  const resume = () => {
    if (document?.visibilityState === "visible") void refresh().catch(() => {});
  };
  document?.addEventListener("visibilitychange", resume);
  return {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      document?.removeEventListener("visibilitychange", resume);
    },
  };
}
