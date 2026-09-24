import { Observable, Subscription, retry, timer, type SchedulerLike } from "rxjs";
import {
  cloudSyncAuthFromAppSessionCookie,
  cloudSyncAuthFromPrototypeAuthState,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { NOTEBOOK_HOME_PING, NOTEBOOK_HOME_PONG } from "../src/notebook-home-protocol";

export function notebookHomeEventsUrl(
  endpoint: string,
  auth: CloudPrototypeAuthState,
  hasAppSession: boolean,
): { url: string; protocols: string[] } {
  const credentials = hasAppSession
    ? cloudSyncAuthFromAppSessionCookie({ sessionId: "notebook-home", requestedScope: "viewer" })
    : cloudSyncAuthFromPrototypeAuthState(auth);
  const url = new URL(endpoint);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (credentials.user) url.searchParams.set("user", credentials.user);
  url.searchParams.set("scope", "viewer");
  return { url: url.href, protocols: credentials.protocols };
}

export type NotebookHomeSocket = Pick<
  WebSocket,
  "addEventListener" | "removeEventListener" | "send" | "close"
>;

/** A ready event also invalidates: reconnect always obtains a current snapshot. */
export function notebookHomeEvents(
  createSocket: () => NotebookHomeSocket,
  scheduler: SchedulerLike,
): Observable<void> {
  return new Observable<void>((subscriber) => {
    const socket = createSocket();
    const timers = new Subscription();
    const fail = () => subscriber.error(new Error("Notebook home connection interrupted"));
    let deadline = scheduler.schedule(fail, 15_000);
    timers.add(deadline);
    let heartbeat: Subscription | undefined;
    const message = (event: Event) => {
      const data: unknown = (event as MessageEvent).data;
      if (data === NOTEBOOK_HOME_PONG) {
        deadline.unsubscribe();
        return;
      }
      if (typeof data !== "string") return;
      let parsed: { event?: string };
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (parsed?.event !== "ready" && parsed?.event !== "changed") return;
      if (parsed.event === "ready") {
        deadline.unsubscribe();
        if (!heartbeat) {
          heartbeat = timer(25_000, 25_000, scheduler).subscribe(() => {
            try {
              socket.send(NOTEBOOK_HOME_PING);
            } catch {
              fail();
              return;
            }
            deadline = scheduler.schedule(fail, 10_000);
            timers.add(deadline);
          });
          timers.add(heartbeat);
        }
      }
      subscriber.next();
    };
    socket.addEventListener("message", message);
    socket.addEventListener("close", fail);
    socket.addEventListener("error", fail);
    return () => {
      timers.unsubscribe();
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", fail);
      socket.removeEventListener("error", fail);
      socket.close();
    };
  }).pipe(
    retry({
      resetOnSuccess: true,
      delay: (_error, attempt) =>
        timer(Math.min(1_000 * 2 ** Math.min(attempt - 1, 5), 30_000), scheduler),
    }),
  );
}
