// edit_page's asset_from (dataset-copies.mjs) through the gateway, over real
// Catalog, Project and Page hosts (projects-fixture.mjs) and private asset
// storage: a dataset on one Page or Project placed on another.
import assert from "node:assert/strict";
import { test } from "node:test";
import { secretHash } from "@nteract/session";
import worker from "./index.mjs";
import { world } from "./projects-fixture.mjs";
import { exchangeAuthorizationCode, issueAuthorizationCode } from "./oauth-store.mjs";
import { imageAssetKey } from "./image-assets.mjs";
import { MAX_DATASET_COPIES, takeAssetHints } from "./dataset-copies.mjs";
import { DATASET_MAX_BYTES, PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

const origin = "https://pages.invalid";
// A pyarrow table, shared with the upload tests.
const parquet = new Uint8Array(
  Buffer.from(
    "UEFSMRUEFTgVOEwVBBUAEgAACgAAADIwMjYtMTEtMDEKAAAAMjAyNi0xMS0wMhUAFRIVEiwVBBUQFQYVBhw2ACgKMjAyNi0xMS0wMhgKMjAyNi0xMS0wMRERAAAAAgAAAAQBAQMCFQQVJBUkTBUEFQASAAADAAAAbWNwBwAAAGJyb3dzZXIVABUSFRIsFQQVEBUGFQYcNgAoA21jcBgHYnJvd3NlchERAAAAAgAAAAQBAQMCFQQVIBUgTBUEFQASAAAqAAAAAAAAAAcAAAAAAAAAFQAVEhUSLBUEFRAVBhUGHBgIKgAAAAAAAAAYCAcAAAAAAAAAFgAoCCoAAAAAAAAAGAgHAAAAAAAAABERAAAAAgAAAAQBAQMCFQQZTDUAGAZzY2hlbWEVBgAVDCUCGANkYXklAEwcAAAAFQwlAhgHc3VyZmFjZSUATBwAAAAVBCUCGAZldmVudHMAFgQZHBk8JgAcFQwZNQAGEBkYA2RheRUAFgQWxAEWxAEmXCYIHDYAKAoyMDI2LTExLTAyGAoyMDI2LTExLTAxEREAGSwVBBUAFQIAFQAVEBUCADwWKBkGGSYABAAAACYAHBUMGTUABhAZGAdzdXJmYWNlFQAWBBacARacASaMAibMARw2ACgDbWNwGAdicm93c2VyEREAGSwVBBUAFQIAFQAVEBUCADwWFBkGGSYABAAAACYAHBUEGTUABhAZGAZldmVudHMVABYEFswBFswBJqQDJugCHBgIKgAAAAAAAAAYCAcAAAAAAAAAFgAoCCoAAAAAAAAAGAgHAAAAAAAAABERABksFQQVABUCABUAFRAVAgA8KQYZJgAEAAAAFqwEFgQmCBasBAAZHBgMQVJST1c6c2NoZW1hGKwCLy8vLy85Z0FBQUFRQUFBQUFBQUtBQXdBQmdBRkFBZ0FDZ0FBQUFBQkJBQU1BQUFBQ0FBSUFBQUFCQUFJQUFBQUJBQUFBQU1BQUFCOEFBQUFRQUFBQUFRQUFBQ2cvLy8vQUFBQkFoQUFBQUFnQUFBQUJBQUFBQUFBQUFBR0FBQUFaWFpsYm5SekFBQUlBQXdBQ0FBSEFBZ0FBQUFBQUFBQlFBQUFBTmovLy84QUFBRUZFQUFBQUJnQUFBQUVBQUFBQUFBQUFBY0FBQUJ6ZFhKbVlXTmxBTXovLy84UUFCUUFDQUFHQUFjQURBQUFBQkFBRUFBQUFBQUFBUVVRQUFBQUdBQUFBQVFBQUFBQUFBQUFBd0FBQUdSaGVRQUVBQVFBQkFBQUFBQUFBQUE9ABggcGFycXVldC1jcHAtYXJyb3cgdmVyc2lvbiAyNi4wLjAZPBwAABwAABwAAADYAgAAUEFSMQ==",
    "base64",
  ),
);
/** Another valid container: one data byte changed, so another id. */
const variant = (n) => {
  const bytes = parquet.slice();
  bytes[10] = n;
  return bytes;
};
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP07NrPAAZMEIqBgQEAHAoBlkMvCokAAAAASUVORK5CYII=",
    "base64",
  ),
);
const sha256 = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const absentId = "e".repeat(64);
const absentPage = "55555555-5555-4555-8555-555555555555";
const absentProject = "prj_66666666-6666-4666-8666-666666666666";

class Bucket {
  objects = new Map();
  calls = [];
  async head(key) {
    this.calls.push(["head", key]);
    return this.objects.get(key) ?? null;
  }
  async put(key, bytes, options) {
    this.calls.push(["put", key]);
    if (this.objects.has(key)) return null;
    const object = {
      key,
      bytes: bytes.slice(),
      size: bytes.length,
      httpEtag: '"etag"',
      ...options,
    };
    this.objects.set(key, object);
    return object;
  }
  async get(key) {
    this.calls.push(["get", key]);
    const object = this.objects.get(key);
    return object ? { ...object, body: new Blob([object.bytes]).stream() } : null;
  }
  async delete(keys) {
    for (const key of [keys].flat()) this.objects.delete(key);
  }
}

async function setup(t) {
  const w = await world(t);
  w.env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN = origin;
  const bucket = (w.env.PAGES_ASSETS = new Bucket());
  // Every request a Page host receives, in order.
  const hosts = [];
  const pages = w.env.PAGES;
  w.env.PAGES = {
    getByName(id) {
      const host = pages.getByName(id);
      return {
        async fetch(request, init) {
          const path = new URL(request.url).pathname;
          const entry = { id, path };
          if (path === "/internal/tool") {
            const body = await request.clone().json();
            entry.operation = body.operation;
            entry.hints = body.asset_hints;
            entry.operations = body.arguments?.operations;
          }
          hosts.push(entry);
          return host.fetch(request, init);
        },
      };
    },
  };
  const create = async (title, who = "owner", extra = {}) => {
    const created = await w.createPage({ title, ...extra }, who);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body.page_id;
  };
  /** Upload bytes to `/api/pages/<id>` or `/api/projects/<id>` with an API key. */
  const upload = async (path, bytes = parquet, who = "owner") => {
    const response = await worker.fetch(
      new Request(`${origin}${path}/assets`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${w.token(who)}`,
          "content-type": bytes === png ? "image/png" : PARQUET_MEDIA_TYPE,
        },
        body: bytes,
      }),
      w.env,
    );
    const body = await response.json();
    assert.ok([200, 201].includes(response.status), JSON.stringify(body));
    return body.asset_id;
  };
  const revision = async (address, who = "owner") => {
    const read = await w.call(who, "read_page", { ...address, include_content: false });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    return read.body.revision;
  };
  /** One edit_page batch over /api/tools, at the revision `reader` reads. */
  const edit = async (address, operations, { who = "owner", reader = who, nonce } = {}) =>
    w.call(who, "edit_page", {
      ...address,
      revision: await revision(address, reader),
      nonce: nonce ?? w.key(),
      operations,
    });
  /** Give `w.member` a role on a Page (expected_revision counts its grants). */
  const share = (pageId, role, expected_revision = 0) =>
    w.call("owner", "manage_page_access", {
      page_id: pageId,
      action: "set_role",
      principal: w.member,
      role,
      expected_revision,
      nonce: w.key(),
    });
  const shareProject = (projectId, role, expected_revision = 0) =>
    w.call("owner", "manage_project_access", {
      project_id: projectId,
      action: "set_role",
      principal: w.member,
      role,
      expected_revision,
      nonce: w.key(),
    });
  /** Requests the hosts of `ids` received since `from`. */
  const reached = (ids, from = 0) => hosts.slice(from).filter((entry) => ids.includes(entry.id));
  /** Storage calls on `pageId`'s assets since `from`. */
  const storage = (pageId, from = 0) =>
    bucket.calls.slice(from).filter(([, key]) => key.startsWith(imageAssetKey(pageId, "")));
  const served = async (pageId, assetId, who = "owner") =>
    (
      await worker.fetch(
        new Request(`${origin}/api/pages/${pageId}/assets/${assetId}`, {
          headers: { authorization: `Bearer ${w.token(who)}` },
        }),
        w.env,
      )
    ).status;
  return {
    w,
    bucket,
    hosts,
    create,
    upload,
    revision,
    edit,
    share,
    shareProject,
    reached,
    storage,
    served,
  };
}

const dataframe = (asset_id, asset_from) => ({
  op: "insert_node",
  node: { type: "dataframe", attrs: { asset_id } },
  ...(asset_from !== undefined && { asset_from }),
});
const source = (source_id, asset_id, asset_from) => ({
  op: "set_source",
  source_id,
  name: source_id,
  asset_id,
  source_revision: null,
  ...(asset_from !== undefined && { asset_from }),
});

test("insert_node takes a dataset from another Page; the Page keeps its own bytes", async (t) => {
  const { w, bucket, hosts, create, upload, edit, served } = await setup(t);
  const a = await create("Source");
  const b = await create("Destination");
  const assetId = await upload(`/api/pages/${a}`);
  const from = hosts.length;
  const placed = await edit({ page_id: b }, [dataframe(assetId, a)]);
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  assert.ok(bucket.objects.has(imageAssetKey(b, assetId)));
  // The destination is asked first, then the source's read check; the batch
  // the host sees never holds asset_from, and its second pass no hints.
  const order = hosts.slice(from).map(({ id, path, operation }) => [id, operation ?? path]);
  const editIndex = order.findIndex(([id, what]) => id === b && what === "edit_page");
  const sourceIndex = order.findIndex(([id]) => id === a);
  assert.ok(editIndex >= 0 && sourceIndex > editIndex, JSON.stringify(order));
  assert.deepEqual(order[sourceIndex], [a, "/internal/assets/authorize"]);
  const forwards = hosts.slice(from).filter((entry) => entry.operation === "edit_page");
  assert.equal(forwards.length, 2);
  assert.deepEqual(forwards[0].hints, [assetId]);
  assert.equal(forwards[1].hints, undefined);
  for (const forward of forwards)
    assert.equal(JSON.stringify(forward.operations).includes("asset_from"), false);
  const read = await w.call("owner", "read_page", { page_id: b });
  assert.ok(JSON.stringify(read.body).includes(assetId));
  assert.equal(JSON.stringify(read.body).includes("asset_from"), false);
  // The source losing its bytes leaves the copy.
  bucket.objects.delete(imageAssetKey(a, assetId));
  assert.equal(await served(b, assetId), 200);
});

test("a dataframe set_node takes asset_from", async (t) => {
  const { bucket, create, upload, edit } = await setup(t);
  const a = await create("Source");
  const b = await create("Destination");
  const first = await upload(`/api/pages/${b}`);
  const second = await upload(`/api/pages/${a}`, variant(1));
  // set_source takes it too; the sources tests cover its host side.
  const placed = await edit({ page_id: b }, [dataframe(first)]);
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  const [node_id] = placed.body.result.edits[0].nodes;
  const changed = await edit({ page_id: b }, [
    { op: "set_node", node_id, attrs: { asset_id: second }, asset_from: a },
  ]);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.ok(bucket.objects.has(imageAssetKey(b, second)));
});

test("a hash alone grants nothing: without asset_from the edit is refused as before", async (t) => {
  const { create, upload, edit, reached, hosts } = await setup(t);
  const a = await create("Source");
  const b = await create("Destination");
  const assetId = await upload(`/api/pages/${a}`);
  const from = hosts.length;
  for (const op of [dataframe(assetId), source("daily", assetId)]) {
    const refused = await edit({ page_id: b }, [op]);
    assert.equal(refused.status, 404, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "dataset_not_found");
  }
  assert.deepEqual(reached([a], from), []);
});

test("the destination's edit check comes first; the source isn't asked without it", async (t) => {
  const { w, create, upload, edit, share, reached, storage, hosts, bucket } = await setup(t);
  const a = await create("Source");
  const b = await create("Destination");
  const assetId = await upload(`/api/pages/${a}`);
  {
    const shared = await share(a, "viewer");
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
  }
  {
    const shared = await share(b, "viewer");
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
  }
  const from = hosts.length;
  const calls = bucket.calls.length;
  const refused = await edit({ page_id: b }, [dataframe(assetId, a)], { who: "member" });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.notEqual(refused.body.code, "source_not_readable");
  assert.deepEqual(reached([a], from), []);
  assert.deepEqual([...storage(a, calls), ...storage(b, calls)], []);
  void w;
});

test("a source the caller can't read is refused the same whether the dataset is there", async (t) => {
  const { create, upload, edit, share, reached, storage, hosts, bucket } = await setup(t);
  const a = await create("Source");
  const b = await create("Destination");
  const assetId = await upload(`/api/pages/${a}`);
  {
    const shared = await share(b, "editor");
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
  }
  const answers = [];
  for (const [asset, from] of [
    [assetId, a],
    [absentId, a],
    [assetId, absentPage],
    [assetId, absentProject],
  ]) {
    const calls = bucket.calls.length;
    const before = hosts.length;
    const refused = await edit({ page_id: b }, [dataframe(asset, from)], { who: "member" });
    answers.push([refused.status, refused.body]);
    // The source's storage is never read; the destination's only by HEAD.
    assert.deepEqual(storage(a, calls), []);
    assert.ok(storage(b, calls).every(([call]) => call === "head"));
    assert.ok(reached([b], before).length > 0);
  }
  for (const answer of answers)
    assert.deepEqual(answer, [
      403,
      {
        error: "asset_from names a Page or Project you can't read, or one that doesn't exist",
        code: "source_not_readable",
      },
    ]);
});

test("an unneeded asset_from is harmless when the asset is already on the destination", async (t) => {
  const { w, create, upload, edit, reached, hosts, bucket, storage } = await setup(t);
  const a = await create("Source");
  const b = await create("Destination");
  const stranger = await create("Stranger's", "stranger");
  const project = await w.createProject("Shelf");
  const inside = await create("Inside", "owner", { project_id: project.project_id });
  const assetId = await upload(`/api/pages/${b}`);
  await upload(`/api/pages/${inside}`);
  const puts = () => bucket.calls.filter(([call]) => call === "put").length;
  const before = puts();
  for (const [destination, from] of [
    [b, b],
    [b, stranger],
    [b, absentPage],
    [b, absentProject],
    [b, a],
    // A model-style mistake: the destination Page's own Project.
    [inside, project.project_id],
  ]) {
    const start = hosts.length;
    const calls = bucket.calls.length;
    const placed = await edit({ page_id: destination }, [dataframe(assetId, from)]);
    assert.equal(placed.status, 200, `${from}: ${JSON.stringify(placed.body)}`);
    // Nothing but the destination is asked.
    assert.deepEqual(
      reached([from, stranger, a], start).filter(({ id }) => id !== destination),
      [],
    );
    assert.deepEqual(storage(a, calls), []);
  }
  assert.equal(puts(), before);
  // asset_from naming the destination itself, for an asset it lacks, is the
  // usual refusal.
  const missing = await edit({ page_id: b }, [dataframe(absentId, b)]);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "dataset_not_found");
});

test("a malformed asset_from, or one on an operation without an asset, is invalid_arguments", async (t) => {
  const { create, edit, reached, hosts } = await setup(t);
  const a = await create("Source");
  const b = await create("Destination");
  const from = hosts.length;
  for (const op of [
    dataframe(absentId, "not-a-page"),
    dataframe(absentId, 7),
    dataframe(absentId, `${a}x`),
    { op: "set_title", title: "x", asset_from: a },
    { op: "insert_node", node: { type: "view", attrs: { view_id: "v" } }, asset_from: a },
  ]) {
    const refused = await edit({ page_id: b }, [op]);
    assert.equal(refused.status, 400, JSON.stringify(op));
    assert.equal(refused.body.code, "invalid_arguments");
  }
  assert.deepEqual(
    reached([b], from).filter(({ operation }) => operation === "edit_page"),
    [],
  );
});

test("only Parquet copies, within the dataset limit", async (t) => {
  const { create, upload, edit, bucket } = await setup(t);
  const a = await create("Source");
  const b = await create("Destination");
  const image = await upload(`/api/pages/${a}`, png);
  for (const op of [
    { op: "insert_image", asset_id: image, alt: "x", asset_from: a },
    source("pic", image, a),
  ]) {
    const refused = await edit({ page_id: b }, [op]);
    assert.equal(refused.status, 415, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "not_a_dataset");
    assert.match(refused.body.error, /Parquet|datasets/);
  }
  // A stored object over the limit, as an older limit might have left.
  const big = "f".repeat(64);
  bucket.objects.set(imageAssetKey(a, big), {
    size: DATASET_MAX_BYTES + 1,
    httpMetadata: { contentType: PARQUET_MEDIA_TYPE },
    customMetadata: { page_id: a, hash: big },
  });
  const tooLarge = await edit({ page_id: b }, [dataframe(big, a)]);
  assert.equal(tooLarge.status, 413, JSON.stringify(tooLarge.body));
  assert.equal(tooLarge.body.code, "dataset_too_large");
  const missing = await edit({ page_id: b }, [dataframe(absentId, a)]);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "dataset_not_found");
  assert.ok(!bucket.calls.some(([call, key]) => call === "put" && key.includes(b)));
});

test("a batch that needs more copies than a paste is refused before any copy", async (t) => {
  const { create, edit, reached, hosts, bucket } = await setup(t);
  const a = await create("Source");
  const b = await create("Destination");
  const ids = Array.from({ length: MAX_DATASET_COPIES + 1 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const from = hosts.length;
  const refused = await edit(
    { page_id: b },
    ids.map((id) => dataframe(id, a)),
  );
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "too_many_copies");
  assert.deepEqual(reached([a], from), []);
  assert.ok(!bucket.calls.some(([call]) => call === "put" || call === "get"));
});

test("copies run at most two at a time and a dataset on the destination isn't written twice", async (t) => {
  const { create, upload, edit, bucket } = await setup(t);
  const a = await create("Source");
  const b = await create("Destination");
  const ids = [];
  for (let n = 1; n <= 4; n++) ids.push(await upload(`/api/pages/${a}`, variant(n)));
  // One of them is already on the destination.
  await upload(`/api/pages/${b}`, variant(1));
  let active = 0,
    peak = 0;
  const get = bucket.get.bind(bucket);
  bucket.get = async (key) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await get(key);
    } finally {
      active--;
    }
  };
  const puts = () => bucket.calls.filter(([call, key]) => call === "put" && key.includes(b));
  const before = puts().length;
  const placed = await edit(
    { page_id: b },
    ids.map((id) => dataframe(id, a)),
  );
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  assert.equal(puts().length - before, 3);
  assert.ok(peak <= 2, `peak ${peak}`);
});

test("a retry with the same nonce replays without the source; a new nonce checks it again", async (t) => {
  const { w, create, upload, edit, share, reached, hosts, revision } = await setup(t);
  const a = await create("Source");
  const b = await create("Destination");
  const first = await upload(`/api/pages/${a}`);
  const second = await upload(`/api/pages/${a}`, variant(2));
  {
    const shared = await share(a, "viewer");
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
  }
  {
    const shared = await share(b, "editor");
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
  }
  const request = {
    page_id: b,
    revision: await revision({ page_id: b }, "member"),
    nonce: "retry-copy-0001",
    operations: [dataframe(first, a)],
  };
  const applied = await w.call("member", "edit_page", request);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  // The source closes to the member.
  {
    const shared = await share(a, null, 1);
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
  }
  const from = hosts.length;
  const replay = await w.call("member", "edit_page", request);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body, applied.body);
  assert.deepEqual(reached([a], from), []);
  const refused = await edit({ page_id: b }, [dataframe(second, a)], { who: "member" });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "source_not_readable");
});

test("a stale revision is refused before anything is copied", async (t) => {
  const { w, create, upload, revision, reached, hosts, bucket } = await setup(t);
  const a = await create("Source");
  const b = await create("Destination");
  const assetId = await upload(`/api/pages/${a}`);
  const old = await revision({ page_id: b });
  const moved = await w.call("owner", "edit_page", {
    page_id: b,
    revision: old,
    nonce: w.key(),
    operations: [{ op: "insert_markdown", markdown: "Moved on." }],
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const from = hosts.length;
  const stale = await w.call("owner", "edit_page", {
    page_id: b,
    revision: old,
    nonce: w.key(),
    operations: [dataframe(assetId, a)],
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, "stale_revision");
  assert.deepEqual(reached([a], from), []);
  assert.ok(!bucket.objects.has(imageAssetKey(b, assetId)));
});

test("a Project shelves datasets for its members' Pages, inside it and out", async (t) => {
  const { w, bucket, create, upload, edit, shareProject, storage, served } = await setup(t);
  const project = await w.createProject("Shelf");
  const assetId = await upload(`/api/projects/${project.project_id}`);
  assert.ok(bucket.objects.has(imageAssetKey(project.document_id, assetId)));
  {
    const shared = await shareProject(project.project_id, "editor");
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
  }
  const inside = await create("Inside", "member", { project_id: project.project_id });
  const outside = await create("Outside", "member");
  for (const page of [inside, outside]) {
    const placed = await edit({ page_id: page }, [dataframe(assetId, project.project_id)], {
      who: "member",
    });
    assert.equal(placed.status, 200, JSON.stringify(placed.body));
    assert.ok(bucket.objects.has(imageAssetKey(page, assetId)));
  }
  // A non-member hears the same whether the dataset is there.
  const own = await create("Stranger's", "stranger");
  for (const asset of [assetId, absentId]) {
    const calls = bucket.calls.length;
    const refused = await edit({ page_id: own }, [dataframe(asset, project.project_id)], {
      who: "stranger",
    });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "source_not_readable");
    assert.deepEqual(storage(project.document_id, calls), []);
  }
  // A removed member is refused.
  const second = await upload(`/api/projects/${project.project_id}`, variant(3));
  {
    const shared = await shareProject(project.project_id, null, 1);
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
  }
  const removed = await edit({ page_id: outside }, [dataframe(second, project.project_id)], {
    who: "member",
  });
  assert.equal(removed.status, 403, JSON.stringify(removed.body));
  assert.equal(removed.body.code, "source_not_readable");
  // The Pages keep their bytes after the Project's go.
  bucket.objects.delete(imageAssetKey(project.document_id, assetId));
  assert.equal(await served(outside, assetId, "member"), 200);
  assert.equal(await served(inside, assetId), 200);
});

test("Project content as the destination takes a dataset from a Page", async (t) => {
  const { w, bucket, create, upload, edit } = await setup(t);
  const project = await w.createProject("Shelf");
  const a = await create("Source");
  const assetId = await upload(`/api/pages/${a}`);
  const placed = await edit({ project_id: project.project_id }, [dataframe(assetId, a)]);
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  assert.ok(bucket.objects.has(imageAssetKey(project.document_id, assetId)));
  // Its own Project id names the destination itself.
  const missing = await edit({ project_id: project.project_id }, [
    dataframe(absentId, project.project_id),
  ]);
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.equal(missing.body.code, "dataset_not_found");
});

test("an OAuth MCP client takes a dataset with asset_from", async (t) => {
  const { w, bucket, create, upload, revision } = await setup(t);
  const a = await create("Source");
  const b = await create("Destination");
  const assetId = await upload(`/api/pages/${a}`);
  const clientId = "https://chatgpt.com/oauth/client.json";
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const verifier = "v".repeat(43);
  const { code } = await issueAuthorizationCode(w.env, {
    clientId,
    redirectUri,
    resource: `${origin}/mcp`,
    scope: "pages:read pages:write offline_access",
    codeChallenge: await secretHash(verifier),
    identity: { principal: w.owner, namespace: "user:anaconda-fixture", displayName: "Fixture" },
  });
  const tokens = await exchangeAuthorizationCode(w.env, {
    code,
    clientId,
    redirectUri,
    resource: `${origin}/mcp`,
    codeVerifier: verifier,
  });
  const call = async (args) => {
    const response = await worker.fetch(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "edit_page", arguments: args },
        }),
      }),
      w.env,
    );
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const result = await call({
    page_id: b,
    revision: await revision({ page_id: b }),
    nonce: w.key(),
    operations: [dataframe(assetId, a)],
  });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.ok(bucket.objects.has(imageAssetKey(b, assetId)));
  // Refusals keep their codes over MCP.
  const refused = await call({
    page_id: b,
    revision: await revision({ page_id: b }),
    nonce: w.key(),
    operations: [dataframe(absentId, absentPage)],
  });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.code, "source_not_readable");
});

test("takeAssetHints reads asset_from off each operation and keeps the rest", () => {
  const page = "77777777-7777-4777-8777-777777777777";
  const args = {
    page_id: page,
    operations: [
      dataframe("a".repeat(64), page),
      source("s", "b".repeat(64), absentProject),
      { op: "insert_markdown", markdown: "x" },
    ],
  };
  const { args: forwarded, hints } = takeAssetHints(args);
  assert.deepEqual(forwarded.operations, [
    dataframe("a".repeat(64)),
    source("s", "b".repeat(64)),
    { op: "insert_markdown", markdown: "x" },
  ]);
  assert.deepEqual(
    [...hints],
    [
      ["a".repeat(64), { source: { page_id: page }, kind: "dataset" }],
      ["b".repeat(64), { source: { project_id: absentProject }, kind: "dataset" }],
    ],
  );
  const plain = { page_id: page, operations: [dataframe("a".repeat(64))] };
  assert.equal(takeAssetHints(plain).args, plain);
});
