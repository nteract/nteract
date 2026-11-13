// Test support for the Catalog, Project and Page hosts over in-memory
// storage. projects.test.mjs and move-page.test.mjs share it; the Worker
// never imports it.
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { readRevision } from "./operation-journal.mjs";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import worker, { Catalog, Page, Space } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { plainStub } from "./plain-stub.mjs";
import { operationKey } from "./mutations.mjs";
import { LOCATION_SHAPE_KEY, shapeState } from "./location-shape.mjs";
import { startLocalKiloHandoff } from "../scripts/fixtures/local-kilo-handoff.mjs";
import { resetMembershipCache } from "./kilo-membership.mjs";

const KILO_AUDIENCE = "pages-projects-test";
const KILO_SECRET = "kilo-projects-fixture-secret-0123456789";

/** A response as a Durable Object stub returns it on Cloudflare Workers: its
 * headers refuse writes. Node's own responses allow them, so code that sets a
 * header on a host's answer would pass here and throw in production. */
export function immutableHeaders(response) {
  for (const write of ["set", "append", "delete"])
    response.headers[write] = () => {
      throw new TypeError("Can't modify immutable headers.");
    };
  return response;
}

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
 * transactions, as the lightest storage above does.
 *
 * With `kilo`, the deployment signs in with Kilo beside a fake Kilo, and
 * owner, member and stranger call with Kilo agent tokens. `kilo` maps each of
 * them to the organizations (`[{ id, name }]`) Kilo reports for them;
 * `organizations(who, list)` changes that list and mints a new token, so the
 * next call makes a new exchange. */
export async function world(
  t,
  { index = "1", storage: newStorage = () => new Storage(), kilo: kiloPeople } = {},
) {
  const auth = await createAuthFixture();
  const kilo = kiloPeople
    ? await startLocalKiloHandoff({
        deployments: { [KILO_AUDIENCE]: "https://pages.invalid" },
        secret: KILO_SECRET,
      })
    : null;
  if (kilo) {
    t.after(() => kilo.close());
    resetMembershipCache();
    const send = globalThis.fetch;
    t.mock.method(globalThis, "fetch", (input, init) =>
      String(input?.url ?? input).startsWith(kilo.origin)
        ? send(input, init)
        : auth.fetch(input, init),
    );
  } else t.mock.method(globalThis, "fetch", auth.fetch);
  const owner = kilo ? "user:kilo:owner-person" : `user:anaconda-fixture:${auth.subject}`;
  const member = kilo ? "user:kilo:member-person" : "user:anaconda-fixture:member-user";
  let minted = 0;
  const kiloToken = (who, organizations) =>
    kilo.mintToken(
      {
        id: `${who}-person`,
        name: `${who[0].toUpperCase()}${who.slice(1)} Person`,
        organizations: organizations.map((organization) => ({ ...organization, role: "member" })),
      },
      { audience: KILO_AUDIENCE, claims: { n: ++minted } },
    );
  const tokens = kilo
    ? Object.fromEntries(
        ["owner", "member", "stranger"].map((who) => [who, kiloToken(who, kiloPeople[who] ?? [])]),
      )
    : {
        owner: auth.apiKey(),
        member: auth.apiKey({ userId: "member-user" }),
        stranger: auth.apiKey({ userId: "stranger-user" }),
        reader: auth.apiKey({ scopes: ["cloud:read"] }),
      };
  const organizations = (who, list) => {
    tokens[who] = kiloToken(who, list);
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
      return immutableHeaders(response);
    },
  });
  const env = {
    ...auth.env,
    ...(kilo && {
      NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.invalid",
      NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
      PAGES_KILO_APP_URL: kilo.origin,
      PAGES_KILO_AUDIENCE: KILO_AUDIENCE,
      PAGES_KILO_EXCHANGE_SECRET: KILO_SECRET,
    }),
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
            new Catalog(
              {
                id: { name: principal },
                storage: newStorage(principal),
                waitUntil: (promise) => jobs.push(promise),
              },
              env,
            ),
          );
        return catalogs.get(principal);
      },
    },
  };
  function pageHost(id) {
    if (pages.has(id)) return pages.get(id);
    const storage = new Storage();
    let doc;
    const handle = {
      doc: () => doc,
      async update(fn) {
        doc = fn(doc);
      },
      broadcast() {},
      on() {},
      off() {},
    };
    const page = Object.assign(Object.create(Page.prototype), {
      env,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      ctx: { id: { name: id }, storage, waitUntil: (promise) => jobs.push(promise) },
      wires: new Set(),
      serverSenderId: "server-sender",
      repo: {
        async import(bytes) {
          doc = A.load(bytes);
          return handle;
        },
        async flush() {},
        async delete() {},
      },
    });
    page.plain = plainStub(page.repo);
    page.policy = new DocumentPolicy({
      metadata: () => ({
        ...(page.policyMetadata ?? page.metadata),
        projectAccess: page.projectAccess,
      }),
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
  /** The public HTTP tool route, through the gateway. A body that isn't
   * JSON comes back as its text. */
  const call = async (who, operation, args = {}) => {
    const response = await worker.fetch(
      request(who, "/api/tools", { operation, arguments: args }),
      env,
    );
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text, headers: response.headers };
    }
  };
  /** A request to one of the REST routes (GET /api/pages, PUT|DELETE
   * /api/pages/<id>/tags/<tag>), through the gateway. */
  const rest = async (who, method, path) => {
    const response = await worker.fetch(
      new Request(`https://pages.invalid${path}`, {
        method,
        headers: { authorization: `Bearer ${tokens[who]}`, "x-pages-driver": "Projects test" },
      }),
      env,
    );
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text), headers: response.headers };
    } catch {
      return { status: response.status, body: text, headers: response.headers };
    }
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
      nonce: key(),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body;
  };
  const createPage = async (args, who = "owner") => {
    const created = await call(who, "create_page", {
      title: "Untitled",
      nonce: key(),
      ...args,
    });
    return created;
  };
  const heads = (pageId) => A.getHeads(pages.get(pageId).handle.doc());
  const catalogStorage = (principal = owner) => env.CATALOGS.getByName(principal).ctx.storage;
  /** The storage key of `principal`'s receipt for `nonce` in `lane`. */
  const receiptKey = (nonce, principal = owner, lane = "catalog") =>
    operationKey({ nonce }, { principal }, lane);
  /** `principal`'s Catalog receipt for `nonce`, or undefined. */
  const receipt = async (nonce, principal = owner) =>
    catalogStorage(principal).get(await receiptKey(nonce, principal));
  /** A revision handle of the Page as it is now, minted in its host. */
  const revision = (pageId) => readRevision(pages.get(pageId).ctx.storage, "page", heads(pageId));
  /** Run every held background job, including ones they start, to the end. */
  const settle = async () => {
    while (jobs.length) await Promise.allSettled(jobs.splice(0));
  };
  return {
    settle,
    auth,
    organizations,
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
    rest,
    oldGateway,
    mcp,
    key,
    createProject,
    createPage,
    heads,
    revision,
    catalogStorage,
    receiptKey,
    receipt,
    page: (id) => pages.get(id),
    catalog: (principal = owner) => env.CATALOGS.getByName(principal),
  };
}

export const ids = (listing) => listing.body.pages.map((page) => page.page_id).sort();
/** A Catalog entry's location fields. */
export const locationOf = (entry) =>
  Object.fromEntries(
    ["parent_id", "position", "space_id", "project_content", "restore_space_id"]
      .filter((field) => Object.hasOwn(entry, field))
      .map((field) => [field, entry[field]]),
  );

export const shapeOf = async (storage) => shapeState(await storage.get(LOCATION_SHAPE_KEY));
