// The server owns refresh tokens. This browser only renews its same-origin cookie.
//
// Interprets session-refresh-machine.mjs. One session request is in flight at
// a time. `refresh()` and the tab becoming visible ask for an answer that
// starts after they asked: mid-request, they queue one fresh request and every
// waiter gets its answer. The renewal timer joins the request in flight.
import { sessionRefreshMachine } from "./session-refresh-machine.mjs";
import { Store } from "./store.mjs";

const SIGNED_OUT = Object.freeze({ identity: null, canWrite: false });

function outcomeOf(answer) {
  if (!("error" in answer)) return answer.value?.identity ? "signedIn" : "signedOut";
  const status = answer.error?.status;
  return status === 401 || status === 403 ? "refused" : "failed";
}

export function maintainBrowserSession({
  request,
  onSession,
  onError,
  document = globalThis.document,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  const store = new Store(sessionRefreshMachine.initial);
  // The waiters for the current answer, kept across a superseded request.
  let round;
  // The latest request's answer: { value } or { error }.
  let settled;
  let timer;

  function dispatch(event) {
    const result = sessionRefreshMachine.step(store.snapshot(), event);
    if (result.rejected) return;
    store.update(() => result.state);
    for (const effect of result.effects) run(effect);
  }

  function run(effect) {
    switch (effect.type) {
      case "request":
        round ??= deferred();
        start();
        return;
      case "cancelTimer":
        clearTimeout(timer);
        timer = undefined;
        return;
      case "schedule":
        timer = setTimeout(() => ask("renew").catch(() => {}), effect.delayMs);
        return;
      case "answer": {
        const waiters = round;
        round = undefined;
        if ("error" in settled) waiters?.reject(settled.error);
        else waiters?.resolve(settled.value);
        return;
      }
      case "apply":
        if (effect.outcome === "failed") onError(settled.error);
        else onSession(effect.outcome === "refused" ? SIGNED_OUT : settled.value);
        return;
    }
    throw new Error(`unknown effect ${effect.type}`);
  }

  function start() {
    new Promise((resolve) => resolve(request())).then(
      (value) => finish({ value }),
      (error) => finish({ error }),
    );
  }

  function finish(answer) {
    settled = answer;
    dispatch({ type: "settled", outcome: outcomeOf(answer) });
  }

  function ask(reason) {
    dispatch({ type: "refresh", reason });
    if (store.snapshot().name === "stopped") return Promise.resolve();
    return round?.promise ?? Promise.resolve();
  }

  const resume = () => {
    if (document?.visibilityState === "visible") void ask("visible").catch(() => {});
  };
  document?.addEventListener("visibilitychange", resume);
  return {
    store,
    /** Resolves with a session answer from a request that started after this
     * call, or rejects with its error. */
    refresh: () => ask("retry"),
    stop() {
      dispatch({ type: "stop" });
      document?.removeEventListener("visibilitychange", resume);
    },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}
