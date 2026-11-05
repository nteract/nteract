// A Page listing's two candidate sources, D1 and the Catalog entries, order
// shared rows by different times. A walk continues on the source that issued
// its cursor, and neither source ends a walk while Pages remain.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogIndexBounds,
  catalogIndexTimeouts,
  listScope,
  parseListArguments,
  reportContentActivity,
  sealPosition,
} from "./catalog-index.mjs";
import { at, catalogFixture, id, member, viewerAcl } from "./catalog-fixture.mjs";

const DIRTY = "host/index/dirty";
/** Object state for direct index calls; the test awaits each one. */
const testCtx = {};

/** Every Page once, from one source. */
function assertComplete(label, { seen, sources }, want) {
  assert.equal(new Set(seen).size, seen.length, `${label}: no Page twice (${sources})`);
  assert.deepEqual([...seen].sort(), [...want].sort(), `${label}: every Page (${sources})`);
  assert.equal(new Set(sources).size, 1, `${label}: one source per walk (${sources})`);
}

/** `count` shared Pages whose Catalog entries order one way and whose D1
 * rows, after their hosts' content flushes, order the other way. */
async function sharedLibrary(f, count, { first = 1 } = {}) {
  const storage = f.catalog(member).ctx.storage;
  const ids = [];
  for (let n = first; n < first + count; n++) {
    const page = f.addPage(id(n), `Shared ${String(n).padStart(4, "0")}`, viewerAcl);
    page.contentActivity = { value: at(5000 + (first + count - n)), pump() {} };
    await storage.put(`shared/${id(n)}`, {
      page_id: id(n),
      title: `Shared ${String(n).padStart(4, "0")}`,
      created_at: at(n),
      updated_at: at(n),
      shared: true,
    });
    ids.push(id(n));
  }
  return ids;
}

/** Edits by other people after the hosts' projections: each host's flush
 * moves D1's member rows, not the member's own Catalog entries. */
async function editElsewhere(f, ids, time) {
  for (const [index, pageId] of ids.entries()) {
    const value = at(time(index));
    f.pages.get(pageId).contentActivity = { value, pump() {} };
    await reportContentActivity(f.env, testCtx, { pageId, contentUpdatedAt: value });
  }
}

test("the Catalog fallback lists every shared Page past its first 500 entries and never ends a walk early", async (t) => {
  const f = await catalogFixture(t);
  const storage = f.catalog(member).ctx.storage;
  // Entry key order (Page ID) differs from every sort's order.
  const ids = [];
  for (let n = 1; n <= 620; n++) {
    const scrambled = (n * 337) % 620;
    f.addPage(id(n), `Shared ${scrambled}`, viewerAcl);
    await storage.put(`shared/${id(n)}`, {
      page_id: id(n),
      title: `Shared ${scrambled}`,
      created_at: at(scrambled),
      updated_at: at(scrambled),
      shared: true,
    });
    ids.push(id(n));
  }
  await f.untilReady(member);
  // Any Catalog write puts the account behind, so the walk starts on the
  // Catalog entries. One Page at a time, its own listings finish the pass
  // mid-walk; the walk stays on the Catalog.
  await storage.put(DIRTY, crypto.randomUUID());
  const single = await f.walk(member, { limit: 1 });
  assert.equal(await storage.get(DIRTY), undefined, "the pass finished mid-walk");
  assertComplete("activity all limit 1", single, ids);
  // The rest stay behind: a pass that can't advance keeps every listing on
  // the Catalog without re-checking 620 hosts per walk.
  const saved = catalogIndexBounds.verifications;
  t.after(() => {
    catalogIndexBounds.verifications = saved;
  });
  catalogIndexBounds.verifications = 0;
  await storage.put(DIRTY, crypto.randomUUID());
  for (const sort of ["activity", "created", "title"])
    for (const access of [null, "shared"])
      for (const limit of [9, 100]) {
        const walked = await f.walk(member, { sort, limit, ...(access && { access }) });
        assert.equal(walked.sources[0], "catalog");
        assertComplete(`${sort} ${access ?? "all"} limit ${limit}`, walked, ids);
      }
});

test("with the index off, the Catalog lists every shared Page past 500", async (t) => {
  const f = await catalogFixture(t, { index: null });
  const ids = await sharedLibrary(f, 560);
  // A host's first check projects its title observation, which moves the
  // member's entry; pagination is best-effort across that. Once each host
  // has projected, a walk is exact.
  await f.walk(member, { limit: 100 });
  await f.settle();
  assertComplete("index off", await f.walk(member, { limit: 100 }), ids);
});

test("a Home walk stays on its source when a write lands, across shared rows the two sources order differently", async (t) => {
  const f = await catalogFixture(t);
  const storage = f.catalog(member).ctx.storage;
  const owned = [];
  for (let n = 1; n <= 250; n++) {
    await storage.put(`page/${id(n)}`, {
      page_id: id(n),
      title: `Own ${n}`,
      created_at: at(n),
      updated_at: at(n),
    });
    owned.push(id(n));
  }
  const shared = await sharedLibrary(f, 20, { first: 1000 });
  await f.untilReady(member);
  await f.walk(member, { limit: 100 });
  await f.settle();
  await editElsewhere(f, shared, (index) => 1200 + (index % 7) * 20);
  assertComplete("ready", await f.walk(member, { limit: 100 }), [...owned, ...shared]);
  // The member creates a Page; for the walks below, its D1 row never landed.
  await storage.put(DIRTY, "created");
  await storage.put(`page/${id(400)}`, {
    page_id: id(400),
    title: "New",
    created_at: at(1439),
    updated_at: at(1439),
  });
  for (let round = 0; round < 6; round++)
    assertComplete(`round ${round}`, await f.walk(member, { limit: 100 }), [
      ...owned,
      ...shared,
      id(400),
    ]);
});

for (const sort of ["activity", "created", "title"])
  test(`a ${sort} walk over shared Pages finishes on the source it started on when readiness flips`, async (t) => {
    const f = await catalogFixture(t);
    const storage = f.catalog(member).ctx.storage;
    const ids = await sharedLibrary(f, 40);
    await f.untilReady(member);
    await f.walk(member, { limit: 100 });
    await f.settle();
    await editElsewhere(f, ids, (index) => 9000 + index);
    // D1 to behind: a write lands after the first page.
    const fromIndex = await f.walk(member, { limit: 5, sort }, async (request) => {
      if (request === 1) await storage.put(DIRTY, "written");
    });
    assert.equal(fromIndex.sources[0], "index");
    assertComplete("index, then behind", fromIndex, ids);
    // Behind to ready: the walk's own listings finish the pass.
    await storage.put(DIRTY, "again");
    const fromCatalog = await f.walk(member, { limit: 5, sort });
    assert.equal(fromCatalog.sources[0], "catalog");
    assert.equal(await storage.get(DIRTY), undefined, "the pass finished mid-walk");
    assertComplete("behind, then ready", fromCatalog, ids);
  });

test("randomized walks list every Page once while readiness flips and shared keys differ by source", async (t) => {
  for (const seed of [11, 23, 47, 91, 131, 977]) {
    let state = seed;
    const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (list) => list[Math.floor(random() * list.length)];
    await t.test(`seed ${seed}`, async (t) => {
      const f = await catalogFixture(t);
      const storage = f.catalog(member).ctx.storage;
      const owned = [];
      for (let n = 1; n <= 30 + Math.floor(random() * 60); n++) {
        const time = at(Math.floor(random() * 4000));
        await storage.put(`page/${id(n)}`, {
          page_id: id(n),
          title: `Own ${Math.floor(random() * 50)}`,
          created_at: time,
          updated_at: time,
        });
        owned.push(id(n));
      }
      const shared = await sharedLibrary(f, 10 + Math.floor(random() * 30), { first: 500 });
      await f.untilReady(member);
      await f.walk(member, { limit: 100 });
      await f.settle();
      await editElsewhere(f, shared, () => Math.floor(random() * 9000));
      for (let walk = 0; walk < 6; walk++) {
        const access = pick([null, null, "owned", "shared"]);
        const args = {
          sort: pick(["activity", "created", "title"]),
          limit: 1 + Math.floor(random() * 12),
        };
        if (access) args.access = access;
        if (random() < 0.5) await storage.put(DIRTY, `start ${walk}`);
        const walked = await f.walk(member, args, async () => {
          if (random() < 0.25) await storage.put(DIRTY, crypto.randomUUID());
        });
        const want = [...(access === "shared" ? [] : owned), ...(access === "owned" ? [] : shared)];
        assertComplete(`walk ${walk} ${JSON.stringify(args)}`, walked, want);
      }
    });
  }
});

test("a cursor from an earlier build, sealed without a source, continues by readiness as before", async (t) => {
  const f = await catalogFixture(t);
  const storage = f.catalog(member).ctx.storage;
  // More shared Pages than one listing's pass verifies, so a behind account
  // stays behind for the next listing.
  const ids = await sharedLibrary(f, 40);
  await f.untilReady(member);
  const first = await f.list(member, { limit: 5 });
  assert.equal(first.source, "index");
  const sealedWithoutSource = async (args, row) => {
    const options = parseListArguments(args);
    return sealPosition(
      f.env,
      {
        principal: member,
        needle: options.needle,
        inTrash: options.inTrash,
        scope: listScope(options),
      },
      options.sort,
      { key: row.content_updated_at ?? row.updated_at, page_id: row.page_id },
    );
  };
  // The fifth row's D1 key: its host's content time.
  const fifth = first.body.pages[4];
  const legacy = await sealedWithoutSource({ limit: 5 }, fifth);
  const ready = await f.list(member, { limit: 5, cursor: legacy });
  assert.equal(ready.source, "index", "a ready account continues on D1");
  assert.deepEqual(
    ready.body.pages.map((page) => page.page_id),
    (await f.walk(member, { limit: 100 })).seen.slice(5, 10),
  );
  await storage.put(DIRTY, "behind");
  const behind = await f.list(member, { limit: 5, cursor: legacy });
  assert.equal(behind.source, "catalog", "a behind account continues on the Catalog");
  // The next cursor names its source, so the walk stays there.
  const rest = await f.list(member, { limit: 100, cursor: behind.body.next_cursor });
  assert.equal(rest.source, "catalog");
  assert.ok(ids.length > 0);

  // A source never opens a cursor under another scope, and a cursor sealed
  // with a source name no build issues doesn't open at all.
  const titled = await f
    .list(member, { limit: 5, cursor: ready.body.next_cursor, sort: "title" })
    .catch((error) => error);
  assert.match(String(titled.message), /invalid_cursor/);
  const options = parseListArguments({ limit: 5 });
  const bogus = await sealPosition(
    f.env,
    {
      principal: member,
      needle: null,
      inTrash: false,
      scope: listScope(options),
      source: "elsewhere",
    },
    "activity",
    { key: fifth.updated_at, page_id: fifth.page_id },
  );
  const refused = await f.list(member, { limit: 5, cursor: bogus }).catch((error) => error);
  assert.match(String(refused.message), /invalid_cursor/);
});

/** Make D1 calls throw while `broken.on`: every call, or with `broken.scan`
 * only the listing's own reads, after the account marker reads fine. */
function breakable(db) {
  const broken = { on: false, scan: false };
  for (const name of ["prepare", "batch"]) {
    const original = db[name].bind(db);
    db[name] = (...args) => {
      const marker = name === "prepare" && args[0].includes("pages_catalog_accounts");
      if (broken.on && !(broken.scan && marker)) throw new Error("injected D1 outage");
      return original(...args);
    };
  }
  return broken;
}

/** Walk as the viewer's listing machine does (viewer/listing-machine.mjs): a
 * next page that fails with `invalid_cursor` restarts the listing from its
 * first page, whose rows replace the ones shown. */
async function viewerWalk(f, args, between, onCursor = () => {}) {
  let seen = [];
  let sources = [];
  let restarts = 0;
  let cursor;
  for (let request = 0; request < 300; request++) {
    onCursor(cursor);
    if (between) await between(request);
    const { status, source, body } = await f.listRaw(member, {
      ...args,
      ...(cursor && { cursor }),
    });
    if (status === 400 && body.code === "invalid_cursor" && cursor) {
      restarts++;
      seen = [];
      sources = [];
      cursor = undefined;
      continue;
    }
    assert.equal(status, 200, JSON.stringify(body));
    seen.push(...body.pages.map((page) => page.page_id));
    sources.push(source);
    cursor = body.next_cursor;
    if (!cursor) return { seen, sources, restarts };
  }
  throw new Error("the walk did not end");
}

for (const sort of ["activity", "created", "title"])
  test(`a ${sort} walk that began on D1 restarts on the Catalog when D1 fails or the index goes off`, async (t) => {
    for (const failure of ["outage", "index off", "scan"]) {
      const f = await catalogFixture(t);
      const broken = breakable(f.db);
      const ids = await sharedLibrary(f, 40);
      await f.untilReady(member);
      await f.walk(member, { limit: 100 });
      await f.settle();
      // Every edit moves D1's member rows away from the Catalog's order.
      await editElsewhere(f, ids, (index) => 9000 + index);
      const walked = await viewerWalk(f, { limit: 5, sort }, async (request) => {
        if (request !== 2) return;
        if (failure === "index off") delete f.env.PAGES_CATALOG_INDEX;
        else Object.assign(broken, { on: true, scan: failure === "scan" });
      });
      broken.on = false;
      assertComplete(`${sort} ${failure}`, walked, ids);
      assert.equal(walked.restarts, 1, `${failure}: one restart`);
      assert.equal(walked.sources[0], "catalog", `${failure}: the restart reads the Catalog`);
    }
  });

test("a walk that began on the Catalog never needs D1", async (t) => {
  const f = await catalogFixture(t);
  const broken = breakable(f.db);
  const storage = f.catalog(member).ctx.storage;
  const ids = await sharedLibrary(f, 40);
  await f.untilReady(member);
  await storage.put(DIRTY, "behind");
  const walked = await viewerWalk(f, { limit: 5 }, async (request) => {
    // D1 goes down, comes back and the account turns ready mid-walk.
    broken.on = request === 2;
    if (request === 4) await storage.delete(DIRTY);
  });
  assert.equal(walked.restarts, 0);
  assertComplete("catalog walk", walked, ids);
});

/** A Page host's projection of a newly shared Page to the member's Catalog:
 * the member discovering it. Its host's own D1 report hasn't landed. */
async function discover(f, n, acl = viewerAcl) {
  f.addPage(id(n), `Found ${n}`, acl);
  const response = await f.catalog(member).fetch(
    new Request("https://pages.internal/internal/projection", {
      method: "POST",
      body: JSON.stringify({
        page_id: id(n),
        title: `Found ${n}`,
        observed_at: at(n),
        shared: true,
      }),
    }),
  );
  assert.equal(response.status, 200, await response.text());
}

test("a discovery marks its Page, and the next listing settles it from D1 without restarting the pass", async (t) => {
  const f = await catalogFixture(t);
  const storage = f.catalog(member).ctx.storage;
  const ids = await sharedLibrary(f, 30);
  await f.untilReady(member);
  await discover(f, 900);
  // A Page shared and then revoked before the member listed.
  await discover(f, 901, { revision: 2, members: {} });
  assert.equal(await storage.get(DIRTY), undefined, "the account isn't behind");
  assert.equal(await storage.get("host/index/sync"), undefined, "no pass started");
  const listed = await f.walk(member, { limit: 100 });
  assert.deepEqual(listed.sources, ["index"]);
  assertComplete("after discovery", listed, [...ids, id(900)]);
  assert.equal((await storage.list({ prefix: "host/index/page/" })).size, 0);
  assert.equal(await storage.get(`shared/${id(901)}`), undefined, "the refused entry is gone");
});

test("discovery marks every few listings keep D1 serving", async (t) => {
  const table = [];
  for (const every of [10, 20, 40, 80]) {
    const f = await catalogFixture(t);
    await sharedLibrary(f, 300);
    await f.untilReady(member);
    let index = 0;
    let found = 2000;
    for (let listing = 1; listing <= 240; listing++) {
      if (listing % every === 0) await discover(f, found++);
      if ((await f.list(member, { limit: 50 })).source === "index") index++;
    }
    table.push(`a discovery every ${every} listings: ${index}/240 from D1`);
    assert.equal(index, 240, table.at(-1));
  }
  t.diagnostic(table.join("; "));
});

test("more pending discovery marks than a listing checks keep D1 out until every one settles", async (t) => {
  const f = await catalogFixture(t);
  const storage = f.catalog(member).ctx.storage;
  const ids = await sharedLibrary(f, 10);
  await f.untilReady(member);
  // 30 discoveries whose hosts haven't reported: a listing checks 16.
  for (let n = 0; n < 30; n++) {
    await discover(f, 700 + n);
    ids.push(id(700 + n));
  }
  const walked = await f.walk(member, { limit: 10 });
  assert.equal(walked.sources[0], "catalog");
  assertComplete("pending discoveries", walked, ids);
  assert.equal((await storage.list({ prefix: "host/index/page/" })).size, 0);
  assert.equal((await f.list(member, { limit: 1 })).source, "index");
});

test("a discovery whose host check is unavailable keeps listings off D1 while D1 is healthy", async (t) => {
  const f = await catalogFixture(t);
  const storage = f.catalog(member).ctx.storage;
  const owned = [];
  for (let n = 1; n <= 5; n++) {
    await storage.put(`page/${id(n)}`, {
      page_id: id(n),
      title: `Own ${n}`,
      created_at: at(n),
      updated_at: at(n),
    });
    owned.push(id(n));
  }
  await f.untilReady(member);
  await discover(f, 800);
  const page = f.pages.get(id(800));
  const run = page.fetch;
  page.fetch = async () => Response.json({ error: "busy" }, { status: 503 });
  for (let listing = 0; listing < 3; listing++) {
    // An owned listing never asks the host; it still can't read D1, which
    // lacks the discovered Page's row.
    const listed = await f.list(member, { limit: 100, access: "owned" });
    assert.equal(listed.source, "catalog", `listing ${listing}`);
    assert.deepEqual(listed.body.pages.map((row) => row.page_id).sort(), owned);
  }
  assert.equal((await storage.list({ prefix: "host/index/page/" })).size, 1, "the mark stays");
  page.fetch = run;
  assertComplete("host back", await f.walk(member, { limit: 100 }), [...owned, id(800)]);
  assert.equal((await f.list(member, { limit: 1 })).source, "index");
});

for (const [label, down] of [
  ["down every 2nd request", (request) => request % 2 === 1],
  ["down every 3rd request", (request) => request % 3 === 2],
  ["down only on next pages", (request, cursor) => Boolean(cursor) && request % 2 === 0],
])
  test(`a D1 that fails pages of its own walks restarts each walk once: ${label}`, async (t) => {
    const f = await catalogFixture(t);
    const broken = breakable(f.db);
    const ids = await sharedLibrary(f, 40);
    await f.untilReady(member);
    await f.walk(member, { limit: 100 });
    await f.settle();
    await editElsewhere(f, ids, (index) => 9000 + index);
    let cursor;
    const walked = await viewerWalk(
      f,
      { limit: 5 },
      async (request) => {
        broken.on = down(request, cursor);
      },
      (next) => (cursor = next),
    );
    broken.on = false;
    assertComplete(label, walked, ids);
    assert.equal(walked.restarts, 1, label);
    // Once the cooldown passes, first pages try D1 again.
    await f.catalog(member).ctx.storage.put("host/index/unavailable-until", Date.now() - 1);
    assert.equal((await f.list(member, { limit: 1 })).source, "index");
  });

test("a search whose later D1 pages time out finishes on the Catalog after one restart", async (t) => {
  const f = await catalogFixture(t);
  const ids = await sharedLibrary(f, 40);
  await f.untilReady(member);
  await f.walk(member, { limit: 100 });
  await f.settle();
  const saved = catalogIndexTimeouts.read;
  t.after(() => {
    catalogIndexTimeouts.read = saved;
  });
  catalogIndexTimeouts.read = 60;
  const prepare = f.db.prepare.bind(f.db);
  let hung = 0;
  f.db.prepare = (sql, ...rest) => {
    const statement = prepare(sql, ...rest);
    // A search past its first page: the keyset clause and a LIKE pattern.
    if (/title_search LIKE \? ESCAPE/.test(sql) && /a\.page_id\) [<>] \(\?, \?\)/.test(sql)) {
      const bind = statement.bind.bind(statement);
      statement.bind = (...params) => {
        const bound = bind(...params);
        if (params[3] === null) return bound;
        hung++;
        return { ...bound, all: () => new Promise(() => {}) };
      };
    }
    return statement;
  };
  const walked = await viewerWalk(f, { limit: 5, query: "shared" });
  catalogIndexTimeouts.read = saved;
  assert.ok(hung > 0, "a later D1 page hung");
  assertComplete("slow search", walked, ids);
  assert.equal(walked.restarts, 1);
});
