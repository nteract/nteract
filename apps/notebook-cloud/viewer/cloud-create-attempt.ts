import { BehaviorSubject } from "rxjs";
import { useSyncExternalStore } from "react";

const DEADLINE_MS = 30_000;

export interface CloudCreateSnapshot {
  state: "ready" | "creating" | "unconfirmed";
  submittedTitle: string;
  previousOutcomeUnknown: boolean;
}

interface CreateContext {
  account: string | null;
  credentialKey?: string;
  endpoint: string;
  ready: boolean;
}

export interface CloudCreateDeps {
  context: () => CreateContext;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  navigate: (url: string) => void;
  origin: string;
}

const initial = (): CloudCreateSnapshot => ({
  state: "ready",
  submittedTitle: "",
  previousOutcomeUnknown: false,
});

/** Owns one create POST and never retries an outcome the client cannot confirm. */
export class CloudCreateAttempt {
  private readonly state = new BehaviorSubject(initial());
  readonly state$ = this.state.asObservable();
  private context: CreateContext;
  private generation = 0;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deadlineAt: number | null = null;
  private disposed = false;

  constructor(private readonly deps: CloudCreateDeps) {
    this.context = { ...deps.context() };
  }

  get snapshot() {
    return this.state.value;
  }

  subscribe = (notify: () => void) => {
    const subscription = this.state$.subscribe(notify);
    return () => subscription.unsubscribe();
  };

  getSnapshot = () => this.snapshot;

  activate() {
    this.disposed = false;
  }

  resume() {
    this.syncContext();
    if (
      this.snapshot.state === "creating" &&
      this.deadlineAt !== null &&
      Date.now() >= this.deadlineAt
    ) {
      const title = this.snapshot.submittedTitle;
      this.invalidate();
      this.state.next({
        state: "unconfirmed",
        submittedTitle: title,
        previousOutcomeUnknown: true,
      });
    }
  }

  private invalidate() {
    ++this.generation;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.deadlineAt = null;
    const controller = this.controller;
    this.controller = null;
    controller?.abort();
  }

  syncContext() {
    const current = this.deps.context();
    // A stable account key adopting the same bootstrapped cookie proves renewal,
    // not an account switch, and keeps the pending request's ownership intact.
    const adoptsSameSession =
      this.context.credentialKey &&
      this.context.account === `legacy-session:${this.context.credentialKey}` &&
      current.account?.startsWith("account:") &&
      current.credentialKey === this.context.credentialKey &&
      current.endpoint === this.context.endpoint &&
      this.context.ready &&
      current.ready;
    if (adoptsSameSession) Object.assign(this.context, current);

    if (
      current.account !== this.context.account ||
      current.endpoint !== this.context.endpoint ||
      (!current.ready && !current.account)
    ) {
      const uncertainSessionRotation =
        this.snapshot.state !== "ready" &&
        current.endpoint === this.context.endpoint &&
        current.account !== null &&
        this.context.account !== null &&
        current.account.startsWith("legacy-session:") &&
        this.context.account.startsWith("legacy-session:");
      const submittedTitle = this.snapshot.submittedTitle;
      this.invalidate();
      this.context = { ...current };
      this.state.next(
        uncertainSessionRotation
          ? { state: "unconfirmed", submittedTitle, previousOutcomeUnknown: true }
          : initial(),
      );
      return !this.disposed && current.ready && current.account !== null;
    }
    this.context.credentialKey = current.credentialKey;
    this.context.ready = current.ready;
    return !this.disposed && current.ready && current.account !== null;
  }

  dismiss(freshTitle = "") {
    const shouldReset = this.snapshot.state !== "ready";
    this.invalidate();
    if (shouldReset) {
      this.state.next({
        state: "ready",
        submittedTitle: freshTitle,
        previousOutcomeUnknown: true,
      });
    }
  }

  dispose() {
    this.disposed = true;
    this.invalidate();
  }

  submit(title: string) {
    if (!this.syncContext() || this.snapshot.state !== "ready") return;
    const submittedTitle = title.trim().slice(0, 160);
    const context = this.context;
    const controller = new AbortController();
    const generation = ++this.generation;
    this.controller = controller;
    const previousOutcomeUnknown = this.snapshot.previousOutcomeUnknown;
    this.state.next({ state: "creating", submittedTitle, previousOutcomeUnknown });
    this.deadlineAt = Date.now() + DEADLINE_MS;
    const ownsRequest = () => {
      this.syncContext();
      const current = this.deps.context();
      return (
        !this.disposed &&
        generation === this.generation &&
        context.account === this.context.account &&
        context.endpoint === this.context.endpoint &&
        context.account === current.account &&
        context.endpoint === current.endpoint
      );
    };
    const unconfirmed = () => {
      if (!ownsRequest()) return;
      this.invalidate();
      this.state.next({
        state: "unconfirmed",
        submittedTitle,
        previousOutcomeUnknown: true,
      });
    };
    this.timer = setTimeout(unconfirmed, DEADLINE_MS);
    const withinDeadline = () => {
      if (!ownsRequest()) return false;
      if (this.deadlineAt !== null && Date.now() >= this.deadlineAt) {
        unconfirmed();
        return false;
      }
      return true;
    };

    void (async () => {
      try {
        const response = await this.deps.fetch(context.endpoint, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ title: submittedTitle }),
          signal: controller.signal,
        });
        if (!withinDeadline()) return;
        const body = (await response.json()) as {
          ok?: unknown;
          notebook_id?: unknown;
          viewer_url?: unknown;
        };
        if (!withinDeadline()) return;
        if (!response.ok || body.ok !== true || typeof body.viewer_url !== "string") {
          unconfirmed();
          return;
        }
        const url = validateCreateResult(body, this.deps.origin);
        if (!url) {
          unconfirmed();
          return;
        }
        this.invalidate();
        this.state.next({ state: "ready", submittedTitle, previousOutcomeUnknown: false });
        this.deps.navigate(url);
      } catch {
        unconfirmed();
      }
    })();
  }
}

function validateCreateResult(
  result: { notebook_id?: unknown; viewer_url?: unknown },
  origin: string,
): string | null {
  if (
    typeof result.notebook_id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,256}$/.test(result.notebook_id) ||
    typeof result.viewer_url !== "string"
  )
    return null;
  try {
    const url = new URL(result.viewer_url, origin);
    const segments = url.pathname.split("/");
    if (
      (segments.length !== 4 && segments.length !== 5) ||
      segments[1] !== "n" ||
      segments[2] !== result.notebook_id ||
      !segments[3] ||
      (segments.length === 5 && segments[4] !== "mode=edit")
    )
      return null;
    decodeURIComponent(segments[3]);
    return new URL(`/n/${result.notebook_id}/notebook?mode=edit`, origin).href;
  } catch {
    return null;
  }
}

export function useCloudCreateAttempt(driver: CloudCreateAttempt): CloudCreateSnapshot {
  return useSyncExternalStore(driver.subscribe, driver.getSnapshot, driver.getSnapshot);
}
