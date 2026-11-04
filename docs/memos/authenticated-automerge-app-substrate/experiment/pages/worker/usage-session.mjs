import { from, lastValueFrom, takeUntil, tap, timer } from "rxjs";
import { flushUsage } from "./usage-store.mjs";
import { logUsage } from "./usage.mjs";

const DAY = 86_400_000;
export const READER_MS = 30_000;
const dayStart = (at) => Math.floor(at / DAY) * DAY;

/** An admitted session qualifies separately in each UTC day it spans.
 * A closed session is terminal. Clock regressions never emit a second visit. */
export function usageSessionStep(state, event) {
  if (state.name === "closed") return { state, visits: [] };
  if (state.name === "waiting") {
    if (event.type === "close") return { state: { name: "closed" }, visits: [] };
    if (event.type !== "admit") return { state, visits: [] };
    return {
      state: { name: "open", openedAt: event.now, nextDay: dayStart(event.now) },
      visits: [],
    };
  }
  if (!["tick", "close"].includes(event.type)) return { state, visits: [] };
  const visits = [];
  let nextDay = Math.max(state.nextDay, dayStart(event.now) - 90 * DAY);
  while (nextDay <= dayStart(event.now)) {
    const qualifiesAt = Math.max(nextDay, state.openedAt) + READER_MS;
    if (qualifiesAt > event.now) break;
    if (qualifiesAt <= nextDay + DAY)
      visits.push(qualifiesAt - (qualifiesAt === nextDay + DAY ? 1 : 0));
    nextDay += DAY;
  }
  return {
    state: event.type === "close" ? { name: "closed" } : { ...state, nextDay },
    visits,
  };
}

/** The principal and Page are fixed by authenticated admission, never wire data. */
export class UsageSession {
  state = { name: "waiting" };
  constructor({ identity, pageId, owner, env, ctx, now = Date.now, scheduler, emit = logUsage }) {
    Object.assign(this, { identity, pageId, owner, env, ctx, now, scheduler, emit });
  }
  event(type) {
    const result = usageSessionStep(this.state, { type, now: this.now() });
    this.state = result.state;
    if (this.identity.driver !== "Browser") return;
    for (const at of result.visits)
      this.emit(
        {
          action: this.identity.principal === this.owner ? "page.visit" : "page.read",
          identity: this.identity,
          surface: "browser-sync",
          pageId: this.pageId,
          outcome: "ok",
          now: new Date(at),
        },
        this.env,
      );
  }
  /** Run in the resident socket's held request, not the Repo scheduler context. */
  serve(disconnected) {
    return lastValueFrom(
      timer(0, 1_000, this.scheduler).pipe(
        takeUntil(from(disconnected)),
        tap(() => {
          this.event("tick");
          flushUsage(this.env, this.ctx);
        }),
      ),
      { defaultValue: undefined },
    ).finally(() => {
      this.event("close");
      flushUsage(this.env, this.ctx);
    });
  }
}

/** One signal per action and UTC day of an admitted browser session.
 * Weak keys release dedupe state with the connection; daily SQL unions reconnects. */
export class BrowserWrites {
  sessions = new WeakMap();
  constructor({ now = Date.now, emit = logUsage } = {}) {
    Object.assign(this, { now, emit });
  }
  admitted(session, identity, kind, pageId, env) {
    if (!session || identity?.driver !== "Browser" || !["page", "comments"].includes(kind)) return;
    const now = new Date(this.now());
    const day = now.toISOString().slice(0, 10);
    const previous = this.sessions.get(session);
    const actions = previous?.day === day ? previous.actions : [];
    const action = kind === "comments" ? "comment.write" : "page.write";
    if (actions.includes(action)) return;
    this.sessions.set(session, { day, actions: [...actions, action] });
    this.emit({ action, surface: "browser-sync", identity, pageId, outcome: "ok", now }, env);
  }
}
