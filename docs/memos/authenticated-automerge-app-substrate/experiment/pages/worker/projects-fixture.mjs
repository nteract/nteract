// Test support for the Catalog, Project and Page hosts over in-memory
// storage. projects.test.mjs and move-page.test.mjs share it; the Worker
// never imports it.
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import worker, { Catalog, Page, Space } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { locationEntries } from "./catalog-location.mjs";
import { LOCATION_SHAPE_KEY, shapeState } from "./location-shape.mjs";

export class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key)) await this.put(name, entry);
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async sync() {}
  async list({ prefix = "", startAfter, limit = Infinity } = {}) {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit),
    );
  }
}

/** Real Catalog, Project and Page hosts over in-memory storage. Page hosts stub
 * only native sync: documents load from the bytes the Page records. */
/** `storage(principal)` builds a Catalog's storage; the default has no
 * transactions, as the lightest storage above does. */
export async function world(t, { index = "1", storage: newStorage = () => new Storage() } = {}) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const owner = `user:anaconda-fixture:${auth.subject}`;
  const member = "user:anaconda-fixture:member-user";
  const tokens = {
    owner: auth.apiKey(),
    member: auth.apiKey({ userId: "member-user" }),
    stranger: auth.apiKey({ userId: "stranger-user" }),
    reader: auth.apiKey({ scopes: ["cloud:read"] }),
  };
  const db = sqliteD1(t).open();
  const pages = new Map();
  const projects = new Map();
  const catalogs = new Map();
  const jobs = [];
  // Inject a failure into the next request to one object: "before" fails
  // without reaching it, "lost" drops the response after it ran.
  const faults = new Map();
  // Runs before every lifecycle-state read; a test can delay or stall it.
  const hooks = { lifecycle: null };
  // A hook may return a Response to answer in the Page's place.
  const faulty = (id, target) => ({
    fetch: async (request, init) => {
      if (hooks.lifecycle && new URL(request.url).pathname === "/internal/lifecycle-state") {
        const replaced = await hooks.lifecycle(id, init?.signal);
        if (replaced instanceof Response) return replaced;
      }
      const fault = faults.get(id);
      if (fault === "before") {
        faults.delete(id);
        return Response.json({ error: "Injected outage" }, { status: 500 });
      }
      const response = await target().fetch(request);
      if (fault === "lost") {
        faults.delete(id);
        return Response.json({ error: "Lost response" }, { status: 500 });
      }
      return response;
    },
  });
  const env = {
    ...auth.env,
    DB: db,
    ...(index && { PAGES_CATALOG_INDEX: index }),
    PAGES: { getByName: (id) => faulty(id, () => pageHost(id)) },
    PROJECTS: {
      getByName: (id) =>
        faulty(id, () => {
          if (!projects.has(id))
            projects.set(id, new Space({ id: { name: id }, storage: new Storage() }, env));
          return projects.get(id);
        }),
    },
    CATALOGS: {
      getByName(principal) {
        if (!catalogs.has(principal))
          catalogs.set(
            principal,
            new Catalog({ id: { name: principal }, storage: newStorage(principal) }, env),
          );
        return catalogs.get(principal);
      },
    },
  };
  function pageHost(id) {
    if (pages.has(id)) return pages.get(id);
    const storage = new Storage();
    let doc;
    const handle = { doc: () => doc, broadcast() {}, on() {}, off() {} };
    const page = Object.assign(Object.create(Page.prototype), {
      env,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      ctx: { id: { name: id }, storage, waitUntil: (promise) => jobs.push(promise) },
      wires: new Set(),
      serverKey: "f".repeat(64),
      serverSenderId: "server-sender",
      repo: {
        async import(bytes) {
          doc = A.load(bytes);
          return handle;
        },
        async flush() {},
        async delete() {},
      },
      backend: { async flush() {} },
    });
    page.policy = new DocumentPolicy({
      storage,
      metadata: () => page.policyMetadata ?? page.metadata,
      serverKey: "f".repeat(64),
    });
    pages.set(id, page);
    return page;
  }
  const request = (who, path, body) =>
    new Request(`https://pages.invalid${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens[who]}`, "x-pages-driver": "Projects test" },
      body: JSON.stringify(body),
    });
  /** The public HTTP tool route, through the gateway. */
  const call = async (who, operation, args = {}) => {
    const response = await worker.fetch(
      request(who, "/api/tools", { operation, arguments: args }),
      env,
    );
    return { status: response.status, body: await response.json() };
  };
  /** A call as the 3548b9750 gateway sent it: Space names, straight to the
   * caller's Catalog, without the Project API. */
  const oldGateway = async (who, operation, args = {}) => {
    const response = await env.CATALOGS.getByName(who === "owner" ? owner : member).fetch(
      request(who, "/internal/catalog", { operation, arguments: args }),
    );
    return { status: response.status, body: await response.json() };
  };
  /** One MCP tools/call through the gateway. */
  const mcp = async (who, name, args = {}) => {
    const response = await worker.fetch(
      new Request("https://pages.invalid/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens[who]}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      // MCP results carry links, so the gateway needs its public origin.
      { ...env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.invalid" },
    );
    const { result } = await response.json();
    return {
      isError: result.isError === true,
      body: JSON.parse(result.content[0].text),
      structured: result.structuredContent,
    };
  };
  let keys = 0;
  const key = () => `projects-test-${++keys}-${crypto.randomUUID()}`;
  const createProject = async (title = "Launch", description) => {
    const created = await call("owner", "create_project", {
      title,
      ...(description !== undefined && { description }),
      idempotency_key: key(),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body;
  };
  const createPage = async (args, who = "owner") => {
    const created = await call(who, "create_page", {
      title: "Untitled",
      idempotency_key: key(),
      ...args,
    });
    return created;
  };
  const heads = (pageId) => A.getHeads(pages.get(pageId).handle.doc());
  const catalogStorage = (principal = owner) => env.CATALOGS.getByName(principal).ctx.storage;
  return {
    auth,
    owner,
    member,
    env,
    db,
    pages,
    projects,
    faults,
    hooks,
    jobs,
    call,
    oldGateway,
    mcp,
    key,
    createProject,
    createPage,
    heads,
    catalogStorage,
    page: (id) => pages.get(id),
    catalog: (principal = owner) => env.CATALOGS.getByName(principal),
  };
}

export const ids = (listing) => listing.body.pages.map((page) => page.page_id).sort();
/** A Catalog entry's location fields. */
export const locationOf = (entry) =>
  Object.fromEntries(
    ["parent_id", "position", "space_id", "home", "restore_space_id"]
      .filter((field) => Object.hasOwn(entry, field))
      .map((field) => [field, entry[field]]),
  );

/** Rewrite a live Catalog into the shape builds before this one wrote: every
 * Project top-level Page a root with space_id, and no shape record. */
export async function unmigrate(storage) {
  const entries = await locationEntries(storage);
  for (const [prefix, state] of [
    ["page/", "active"],
    ["trash/", "trashed"],
  ])
    for (const entry of (await storage.list({ prefix })).values()) {
      if (!entry?.page_id || entry.reservation) continue;
      const location = entries.get(entry.page_id);
      const home = location?.parent_id && entries.get(location.parent_id);
      if (!home?.home || location.state !== state) continue;
      const { restore_space_id: _restore, ...rest } = entry;
      await storage.put(`${prefix}${entry.page_id}`, {
        ...rest,
        parent_id: null,
        space_id: home.space_id,
      });
    }
  await storage.delete(LOCATION_SHAPE_KEY);
}

export const shapeOf = async (storage) => shapeState(await storage.get(LOCATION_SHAPE_KEY));
