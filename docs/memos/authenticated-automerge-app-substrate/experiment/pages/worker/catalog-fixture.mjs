// Test support: real Catalog hosts and stubbed Page hosts over in-memory
// storage and SQLite D1, for listing tests that need many shared Pages
// without creating each one. The Worker never imports it.
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import { Catalog, Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { Storage } from "./projects-fixture.mjs";

export const namespace = "user:anaconda-fixture";
export const owner = `${namespace}:fixture-user`;
export const member = `${namespace}:member`;
export const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
/** An ISO time `n` seconds into the fixture day. */
export const at = (n) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
export const viewerAcl = { revision: 1, members: { [member]: { role: "viewer", generation: 1 } } };

export async function catalogFixture(t, { index = "1" } = {}) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const db = sqliteD1(t).open();
  const pages = new Map();
  const catalogs = new Map();
  const jobs = [];
  const env = {
    ...auth.env,
    DB: db,
    ...(index && { PAGES_CATALOG_INDEX: index }),
    PAGES: {
      getByName: (pageId) =>
        pages.get(pageId) ?? {
          fetch: async () => Response.json({ error: "Page not found" }, { status: 404 }),
        },
    },
    CATALOGS: {
      getByName: (principal) => {
        if (!catalogs.has(principal))
          catalogs.set(
            principal,
            new Catalog({ id: { name: principal }, storage: new Storage() }, env),
          );
        return catalogs.get(principal);
      },
    },
  };
  const tokens = {
    [owner]: auth.apiKey(),
    [member]: auth.apiKey({ userId: "member" }),
  };
  const catalog = (principal) => env.CATALOGS.getByName(principal);
  const list = async (principal, args = {}) => {
    const response = await catalog(principal).fetch(
      new Request("https://pages.invalid/internal/catalog", {
        method: "POST",
        headers: { authorization: `Bearer ${tokens[principal]}` },
        body: JSON.stringify({ operation: "list_pages", arguments: args }),
      }),
    );
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return { source: response.headers.get("x-pages-catalog-source"), body };
  };
  /** A real Page host with stubbed native resources. */
  const addPage = (pageId, title, acl = { revision: 0, members: {} }) => {
    const storage = new Storage();
    const doc = A.from({ page_id: pageId, title });
    const page = Object.assign(Object.create(Page.prototype), {
      env,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      ctx: { storage, waitUntil: (promise) => jobs.push(promise) },
      metadata: { pageId, owner, deleted: false, documentId: "doc", acl },
      handle: { doc: () => doc, broadcast() {} },
      wires: new Set(),
      repo: { delete: async () => {} },
      backend: { flush: async () => {} },
    });
    page.policy = new DocumentPolicy({
      storage,
      metadata: () => page.policyMetadata ?? page.metadata,
    });
    page.policy.refreshAccess = async () => {};
    page.fetch = page.run.bind(page);
    pages.set(pageId, page);
    return page;
  };
  const settle = async () => {
    while (jobs.length) await Promise.allSettled(jobs.splice(0));
  };
  /** List until the account's index serves, and return how many listings
   * that took. */
  const untilReady = async (principal) => {
    for (let listing = 0; listing < 400; listing++)
      if ((await list(principal, { limit: 1 })).source === "index") return listing;
    throw new Error("the account index never became ready");
  };
  /** Walk from the first page until next_cursor is null. `between(request)`
   * runs before each request. */
  const walk = async (principal, args, between) => {
    const seen = [];
    const sources = [];
    let cursor;
    for (let request = 0; request < 2000; request++) {
      if (between) await between(request);
      const { source, body } = await list(principal, { ...args, ...(cursor && { cursor }) });
      assert.ok(body.pages.length <= (args.limit ?? 100));
      seen.push(...body.pages.map((page) => page.page_id));
      sources.push(source);
      cursor = body.next_cursor;
      if (!cursor) return { seen, sources };
    }
    throw new Error("the walk did not end");
  };
  return { auth, db, env, pages, catalog, list, addPage, settle, untilReady, walk };
}
