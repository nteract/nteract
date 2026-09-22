import { BehaviorSubject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CloudHiddenPeopleStore } from "../cloud-hidden-people-store";
import type { CloudPrototypeAuthState } from "../collaborator-auth";

const AUTH: CloudPrototypeAuthState = {
  mode: "oidc",
  token: "session-a",
  user: "owner@example.test",
  oidcClaims: { sub: "owner-a" },
  requestedScope: "owner",
  problem: null,
};
const PERSON = {
  id: "person-a",
  displayName: "Alice Example",
  avatarUrl: null,
  source: "collaborator" as const,
};
const HIDDEN = {
  id: "hidden-a",
  personId: PERSON.id,
  displayName: PERSON.displayName,
  avatarUrl: null,
};
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));
async function settle() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}
function setup(request: (url: string, init: RequestInit) => Promise<Response>) {
  const store = new CloudHiddenPeopleStore();
  const inputs = new BehaviorSubject({ auth: AUTH, open: false });
  const beginMutation = vi.fn(() => Symbol());
  const endMutation = vi.fn();
  cleanup.push(store.activate(inputs, { request, beginMutation, endMutation }));
  return { store, inputs, beginMutation, endMutation };
}

describe("CloudHiddenPeopleStore", () => {
  it("loads only on demand and keeps one bounded page, using opaque cursors", async () => {
    const request = vi.fn(async (url: string) =>
      Response.json({
        hidden: url.includes("after=")
          ? [{ ...HIDDEN, displayName: "Hidden person" }]
          : Array.from({ length: 25 }, (_, i) => ({ ...HIDDEN, id: `hidden-${i}` })),
        nextCursor: url.includes("after=") ? null : "opaque/next",
      }),
    );
    const { store, inputs } = setup(request);
    expect(request).not.toHaveBeenCalled();
    inputs.next({ auth: AUTH, open: true });
    await settle();
    expect(store.snapshot.hidden).toHaveLength(20);
    store.loadPage(store.snapshot.nextCursor);
    await settle();
    expect(request.mock.calls[1]?.[0]).toBe("/api/people/hidden?after=opaque%2Fnext");
    expect(store.snapshot.hidden).toEqual([{ ...HIDDEN, displayName: "Hidden person" }]);
    const nextAuth = { ...AUTH, token: "other-session" };
    store.syncAuth(nextAuth);
    inputs.next({ auth: nextAuth, open: true });
    await settle();
    expect(request.mock.calls[2]?.[0]).toBe("/api/people/hidden");
    inputs.next({ auth: AUTH, open: false });
    inputs.next({ auth: AUTH, open: true });
    await settle();
    expect(request.mock.calls[3]?.[0]).toBe("/api/people/hidden");
  });

  it("stores hide confirmation and undoes only the caller's suppression, with search invalidation", async () => {
    const request = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === "POST"
        ? Response.json({ id: HIDDEN.id })
        : new Response(null, { status: 204 }),
    );
    const { store, beginMutation, endMutation } = setup(request);
    await store.hide(PERSON);
    expect(request.mock.calls[0]?.[1].body).toBe(JSON.stringify({ personId: PERSON.id }));
    expect(store.snapshot.lastHidden).toEqual(HIDDEN);
    await store.undo(HIDDEN.id);
    expect(request.mock.calls[1]?.[0]).toBe("/api/people/hidden/hidden-a");
    expect(request.mock.calls[1]?.[1].method).toBe("DELETE");
    expect(store.snapshot.lastHidden).toBeNull();
    expect(beginMutation).toHaveBeenCalledTimes(2);
    expect(endMutation).toHaveBeenCalledTimes(2);
  });

  it("drops an old account's hidden body and aborts a pending mutation on token change", async () => {
    let finishBody!: (value: unknown) => void;
    let finishHide!: (value: Response) => void;
    const body = new Promise((resolve) => {
      finishBody = resolve;
    });
    const hide = new Promise<Response>((resolve) => {
      finishHide = resolve;
    });
    const request = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === "POST" ? hide : ({ ok: true, json: () => body } as Response),
    );
    const { store, inputs } = setup(request);
    inputs.next({ auth: AUTH, open: true });
    await settle();
    const mutation = store.hide(PERSON);
    const oldSignal = request.mock.calls[1]![1].signal!;
    const nextAuth = { ...AUTH, token: "session-b", user: "other@example.test" };
    store.syncAuth(nextAuth);
    expect(oldSignal.aborted).toBe(true);
    finishBody({ hidden: [HIDDEN], nextCursor: null });
    finishHide(Response.json({ id: HIDDEN.id }));
    await mutation;
    await settle();
    expect(store.snapshot.hidden).toEqual([]);
    expect(store.snapshot.lastHidden).toBeNull();
  });

  it("does not show success after a rejected hide and re-enables search", async () => {
    const request = vi.fn(async () => Response.json({ error: "unavailable" }, { status: 404 }));
    const { store, endMutation } = setup(request);
    await store.hide(PERSON);
    expect(store.snapshot.lastHidden).toBeNull();
    expect(store.snapshot.error).toBe("Unable to change this suggestion. Try again.");
    expect(store.snapshot.busyId).toBeNull();
    expect(endMutation).toHaveBeenCalledTimes(1);
  });

  it("keeps a rejected undo error visible after refreshing an open hidden list", async () => {
    const request = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === "DELETE"
        ? Response.json({ error: "unavailable" }, { status: 404 })
        : Response.json({ hidden: [HIDDEN], nextCursor: null }),
    );
    const { store, inputs } = setup(request);
    inputs.next({ auth: AUTH, open: true });
    await settle();
    await store.undo(HIDDEN.id);
    await settle();
    expect(store.snapshot.status).toBe("ready");
    expect(store.snapshot.hidden).toEqual([HIDDEN]);
    expect(store.snapshot.error).toBe("Unable to change this suggestion. Try again.");
  });
});
