import { test } from "node:test";
import assert from "node:assert/strict";
import { PagesStore, ToolError } from "../viewer/store.ts";
import { resolvePageLink } from "../viewer/links.ts";

test("background refresh respects a user selection still loading", async (t) => {
  const pending: { id: string; resolve: (value: Response) => void }[] = [];
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location"),
    oldHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "" } });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: { replaceState() {} },
  });
  t.after(() => {
    if (oldLocation) Object.defineProperty(globalThis, "location", oldLocation);
    else Reflect.deleteProperty(globalThis, "location");
    if (oldHistory) Object.defineProperty(globalThis, "history", oldHistory);
    else Reflect.deleteProperty(globalThis, "history");
  });
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    if (url === "/api/auth/session")
      return Response.json({ session: { account_key: "account", display_name: "Name" } });
    const { operation, arguments: args } = JSON.parse(String(options?.body));
    if (operation === "list_pages")
      return Response.json({ pages: [{ page_id: "a" }, { page_id: "b" }] });
    return new Promise<Response>((resolve) => pending.push({ id: args.page_id, resolve }));
  });
  async function until(count: number) {
    for (let i = 0; i < 10 && pending.length < count; i++) await new Promise(setImmediate);
    assert.equal(pending.length, count);
  }
  const store = new PagesStore({ realtime: false }),
    initial = store.refresh();
  await until(1);
  pending.shift()!.resolve(Response.json({ content: { page_id: "a" } }));
  await initial;
  const navigation = store.open("b"),
    refresh = store.refresh();
  await until(2);
  assert.deepEqual(
    pending.map((p) => p.id),
    ["b", "b"],
  );
  for (const p of pending) p.resolve(Response.json({ content: { page_id: p.id } }));
  await Promise.all([navigation, refresh]);
  assert.equal(store.getSnapshot().page?.page_id, "b");
});

test("tool errors retain certainty so conflicts and unknown outcomes have different recovery", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: { message: "Changed", commit_status: "not_committed" } },
      { status: 409 },
    ),
  );
  await assert.rejects(
    new PagesStore().tool("edit_page"),
    (error: unknown) =>
      error instanceof ToolError && error.status === 409 && error.commitStatus === "not_committed",
  );
});

test("evidence links resolve safely, including relative links and anchors", () => {
  const base = "https://pages.example/?page=one";
  assert.equal(
    resolvePageLink("https://example.com/evidence", base),
    "https://example.com/evidence",
  );
  assert.equal(
    resolvePageLink("/api/capabilities", base),
    "https://pages.example/api/capabilities",
  );
  assert.equal(resolvePageLink("#heading", base), `${base}#heading`);
  assert.equal(resolvePageLink("javascript:alert(1)", base), null);
  assert.equal(resolvePageLink("data:text/html,hello", base), null);
});

test("returning to the current Page cancels an in-flight navigation", async (t) => {
  const oldHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: { replaceState() {} },
  });
  t.after(() => {
    if (oldHistory) Object.defineProperty(globalThis, "history", oldHistory);
    else Reflect.deleteProperty(globalThis, "history");
  });
  let resolve!: (value: Response) => void;
  let wait = false;
  t.mock.method(globalThis, "fetch", async (_url: string, options?: RequestInit) => {
    const { arguments: args } = JSON.parse(String(options?.body));
    if (wait)
      return new Promise<Response>((r) => {
        resolve = r;
      });
    return Response.json({ content: { page_id: args.page_id } });
  });
  const store = new PagesStore({ realtime: false });
  await store.open("a");
  let disposed = false;
  store.replica = {
    pageId: "a",
    dispose() {
      disposed = true;
    },
  } as unknown as NonNullable<typeof store.replica>;
  wait = true;
  const navigation = store.open("b");
  await store.open("a");
  resolve(Response.json({ content: { page_id: "b" } }));
  await navigation;
  assert.equal(store.getSnapshot().page?.page_id, "a");
  assert.equal(disposed, false);
});

test("a delayed catalog cannot dispose a newly selected Page absent from that snapshot", async (t) => {
  const previous = new Map(
    ["location", "history"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "" } });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: { replaceState() {} },
  });
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  let resolveCatalog!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    if (url === "/api/auth/session") return Response.json({ session: { account_key: "account" } });
    const { operation, arguments: args } = JSON.parse(String(options?.body));
    if (operation === "list_pages")
      return new Promise<Response>((r) => {
        resolveCatalog = r;
      });
    return Response.json({ content: { page_id: args.page_id } });
  });
  const store = new PagesStore({ realtime: false });
  await store.open("a");
  const refresh = store.refresh();
  while (!resolveCatalog) await new Promise(setImmediate);
  await store.open("c");
  resolveCatalog(Response.json({ pages: [{ page_id: "a" }] }));
  await refresh;
  assert.equal(store.getSnapshot().page?.page_id, "c");
});
