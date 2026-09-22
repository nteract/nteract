import { BehaviorSubject, VirtualTimeScheduler } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CloudPeopleSearchStore, type CloudPeopleSearchInputs } from "../cloud-people-search-store";
import type { CloudPrototypeAuthState } from "../collaborator-auth";

const AUTH: CloudPrototypeAuthState = {
  mode: "oidc",
  token: "session-a",
  user: "owner@example.test",
  oidcClaims: { sub: "owner-a", email: "owner@example.test", email_verified: true },
  requestedScope: "owner",
  problem: null,
};
const PERSON = {
  id: "directory-person-a",
  displayName: "Alice Example",
  avatarUrl: null,
  source: "directory",
};
const enabled = (people: unknown[] = []) => Response.json({ directoryEnabled: true, people });
const disabled = () => Response.json({ directoryEnabled: false, people: [] });
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

async function settle() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function setup(fetchPeople = vi.fn(async (_url: string, _signal: AbortSignal) => enabled())) {
  const store = new CloudPeopleSearchStore();
  const scheduler = new VirtualTimeScheduler();
  const inputs = new BehaviorSubject<CloudPeopleSearchInputs>({
    auth: AUTH,
    open: true,
    query: "",
  });
  cleanups.push(store.activate(inputs, { fetchPeople, scheduler, now: () => scheduler.frame }));
  return {
    store,
    inputs,
    fetchPeople,
    update: (changes: Partial<CloudPeopleSearchInputs>) =>
      inputs.next({ ...inputs.getValue(), ...changes }),
    advance: (ms: number) => {
      scheduler.schedule(() => {}, ms);
      scheduler.maxFrames = scheduler.frame + ms;
      scheduler.flush();
    },
  };
}

describe("CloudPeopleSearchStore", () => {
  it("keeps the self-only reverification flag with no people until credentials change", async () => {
    let requiresReverification = true;
    const fetchPeople = vi.fn(async () =>
      Response.json({
        directoryEnabled: false,
        ...(requiresReverification ? { requiresReverification: true } : {}),
        people: [],
      }),
    );
    const app = setup(fetchPeople);
    await settle();
    expect(app.store.snapshot.requiresReverification).toBe(true);
    app.update({ query: "Ali" });
    app.advance(250);
    await settle();
    expect(fetchPeople).toHaveBeenCalledTimes(1);
    expect(app.store.snapshot.people).toEqual([]);
    requiresReverification = false;
    app.update({ auth: { ...AUTH, token: "renewed-session" } });
    expect(app.store.snapshot.requiresReverification).toBeUndefined();
    app.advance(250);
    await settle();
    expect(fetchPeople).toHaveBeenCalledTimes(2);
    expect(app.store.snapshot.requiresReverification).toBeUndefined();
  });

  it("probes disabled policy once and never searches on typing or reopen", async () => {
    const fetchPeople = vi.fn(async (_url: string) => disabled());
    const app = setup(fetchPeople);
    await settle();
    expect(app.store.snapshot.directoryEnabled).toBe(false);
    for (const query of ["Al", "Alice", "alice@example.test"]) {
      app.update({ query });
      app.advance(300);
      await settle();
    }
    app.update({ open: false });
    app.update({ open: true });
    await settle();
    expect(fetchPeople).toHaveBeenCalledTimes(1);
    expect(fetchPeople.mock.calls[0]?.[0]).toBe("/api/people?q=");
  });

  it("debounces names, caches bounded results, and skips short queries and email", async () => {
    const fetchPeople = vi.fn(async (url: string) => enabled(url.endsWith("=") ? [] : [PERSON]));
    const app = setup(fetchPeople);
    await settle();
    app.update({ query: "A" });
    app.advance(300);
    await settle();
    expect(fetchPeople).toHaveBeenCalledTimes(1);
    app.update({ query: "Al" });
    app.update({ query: "Ali" });
    app.advance(249);
    await settle();
    expect(fetchPeople).toHaveBeenCalledTimes(1);
    app.advance(1);
    await settle();
    expect(fetchPeople).toHaveBeenCalledTimes(2);
    expect(fetchPeople.mock.calls[1]?.[0]).toBe("/api/people?q=ali");
    expect(app.store.snapshot.people).toEqual([PERSON]);
    app.update({ query: "alice@example.test" });
    await settle();
    app.update({ query: "Ali" });
    await settle();
    expect(fetchPeople).toHaveBeenCalledTimes(2);
    expect(app.store.snapshot.people).toEqual([PERSON]);
    app.update({ query: "x".repeat(81) });
    app.advance(300);
    await settle();
    expect(fetchPeople).toHaveBeenCalledTimes(2);
    expect(app.store.snapshot.people).toEqual([]);
  });

  it("aborts old queries and drops their body even when transport ignores abort", async () => {
    let finishBody!: (value: unknown) => void;
    const body = new Promise<unknown>((resolve) => {
      finishBody = resolve;
    });
    const fetchPeople = vi.fn(async (url: string, _signal: AbortSignal) => {
      if (url.endsWith("=alice")) return { ok: true, json: () => body } as Response;
      return enabled();
    });
    const app = setup(fetchPeople);
    await settle();
    app.update({ query: "Alice" });
    app.advance(250);
    await settle();
    const oldSignal = fetchPeople.mock.calls[1]![1];
    app.update({ query: "Bea" });
    expect(oldSignal.aborted).toBe(true);
    app.advance(250);
    await settle();
    finishBody({ directoryEnabled: true, people: [PERSON] });
    await settle();
    expect(app.store.snapshot.query).toBe("bea");
    expect(app.store.snapshot.people).toEqual([]);
    app.update({ query: "Alice" });
    app.advance(250);
    await settle();
    expect(fetchPeople).toHaveBeenCalledTimes(4);
  });

  it("invalidates cached authorization and in-flight work on account or token changes", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchPeople = vi.fn(async (url: string, _signal: AbortSignal) =>
      url.endsWith("=al") ? pending : enabled(),
    );
    const app = setup(fetchPeople);
    await settle();
    app.update({ query: "Al" });
    app.advance(250);
    await settle();
    const previousSignal = fetchPeople.mock.calls[1]![1];
    const nextAuth = { ...AUTH, token: "session-b", user: "other@example.test" };
    app.store.syncAuth(nextAuth);
    expect(previousSignal.aborted).toBe(true);
    expect(app.store.snapshot.people).toEqual([]);
    finish(enabled([PERSON]));
    await settle();
    app.update({ auth: nextAuth, query: "" });
    await settle();
    expect(fetchPeople).toHaveBeenCalledTimes(3);
    app.update({ auth: { ...nextAuth, token: "session-b-renewed" } });
    await settle();
    expect(fetchPeople).toHaveBeenCalledTimes(4);
    expect(app.store.snapshot.people).toEqual([]);
  });

  it("clears stale results on failure and on a server policy disable", async () => {
    let fail = false;
    let disable = false;
    const fetchPeople = vi.fn(async (url: string) => {
      if (disable) return disabled();
      if (fail) throw new Error("offline");
      return enabled(url.endsWith("=") ? [] : [PERSON]);
    });
    const app = setup(fetchPeople);
    await settle();
    app.update({ query: "Al" });
    app.advance(250);
    await settle();
    expect(app.store.snapshot.people).toHaveLength(1);
    fail = true;
    app.update({ query: "Bea" });
    app.advance(250);
    await settle();
    expect(app.store.snapshot.status).toBe("error");
    expect(app.store.snapshot.people).toEqual([]);
    app.update({ query: "Al" });
    app.advance(250);
    await settle();
    expect(app.store.snapshot.people).toEqual([]);
    fail = false;
    disable = true;
    app.update({ query: "Carl" });
    app.advance(250);
    await settle();
    expect(app.store.snapshot.directoryEnabled).toBe(false);
    const count = fetchPeople.mock.calls.length;
    app.update({ query: "Al" });
    app.advance(250);
    await settle();
    expect(fetchPeople).toHaveBeenCalledTimes(count);
    expect(app.store.snapshot.people).toEqual([]);
  });

  it("does not query while closed or signed out and aborts when closed", async () => {
    const fetchPeople = vi.fn(
      async (_url: string, _signal: AbortSignal) => new Promise<Response>(() => {}),
    );
    const app = setup(fetchPeople);
    app.update({ open: false });
    expect(fetchPeople.mock.calls[0]![1].aborted).toBe(true);
    app.update({ open: true, auth: { ...AUTH, mode: "anonymous", token: null } });
    app.advance(1000);
    await settle();
    expect(fetchPeople).toHaveBeenCalledTimes(1);
    expect(app.store.snapshot.directoryEnabled).toBe(false);
  });
});
