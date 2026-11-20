// A view's library map: what one manifest answer means, which map a view
// mounts with given its pin and the host's current catalog, and the load
// step's requests, caching and cancellation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { firstValueFrom } from "rxjs";
import {
  LIBRARIES_UNREACHABLE,
  forgetLibraryMaps,
  hostLibraryRevision,
  libraryDecision,
  libraryManifestOutcome,
  libraryMap$,
} from "./library-catalog.mjs";
import { UNBUILT_LIBRARY_CATALOG } from "../shared/library-catalog.mjs";

const origin = "https://pages.example";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const manifest =
  JSON.stringify({
    imports: { d3: "d3.js", "@observablehq/plot": "observablehq-plot.js" },
    files: { "d3.js": "1".repeat(64), "observablehq-plot.js": "2".repeat(64) },
  }) + "\n";
const revision = sha256(manifest);
const nextManifest = JSON.stringify({
  imports: { d3: "d3.js" },
  files: { "d3.js": "3".repeat(64) },
});
const nextRevision = sha256(nextManifest);

test("each manifest answer decides what that catalog gives the view", () => {
  const at = (file) => `${origin}/catalog/${revision}/${file}`;
  const ready = {
    kind: "ready",
    libraries: { d3: at("d3.js"), "@observablehq/plot": at("observablehq-plot.js") },
    // Each module's integrity is the manifest's sha256, in base64.
    integrity: {
      [at("d3.js")]: "sha256-" + Buffer.from("1".repeat(64), "hex").toString("base64"),
      [at("observablehq-plot.js")]:
        "sha256-" + Buffer.from("2".repeat(64), "hex").toString("base64"),
    },
  };
  const unhashed = (files) => JSON.stringify({ imports: { d3: "d3.js" }, files });
  const missing = { kind: "missing" };
  const failed = { kind: "failed" };
  const answer = (fields) => libraryManifestOutcome({ revision, origin, ...fields });
  const ok = { status: 200, text: manifest, digest: revision };
  for (const [name, fields, expected] of [
    ["the manifest the revision names", ok, ready],
    ["a revision this host lacks", { status: 404 }, missing],
    ["other bytes under the revision's name", { ...ok, digest: sha256("other") }, missing],
    ["a manifest that is not JSON", { ...ok, text: "not json" }, missing],
    ["a manifest with no imports", { ...ok, text: "{}" }, missing],
    ["an import that names a path", { ...ok, text: '{"imports":{"d3":"../d3.js"}}' }, missing],
    [
      "an import that is not a module file",
      { ...ok, text: '{"imports":{"d3":"d3.css"}}' },
      missing,
    ],
    ["a manifest with no file hashes", { ...ok, text: '{"imports":{"d3":"d3.js"}}' }, missing],
    ["a library with no hash", { ...ok, text: unhashed({ "other.js": "1".repeat(64) }) }, missing],
    ["a malformed hash", { ...ok, text: unhashed({ "d3.js": "XYZ" }) }, missing],
    ["a server error", { status: 503 }, failed],
    ["a failed request", { status: 0 }, failed],
  ])
    assert.deepEqual(answer(fields), expected, name);
  // A text whose digest does match but which isn't a manifest is missing too.
  assert.deepEqual(
    libraryManifestOutcome({
      revision: sha256("[]"),
      origin,
      status: 200,
      text: "[]",
      digest: sha256("[]"),
    }),
    missing,
  );
});

test("the library decision covers every pin, current revision and manifest outcome", () => {
  const pin = "a".repeat(64);
  const current = "b".repeat(64);
  const map = (digit) => ({
    kind: "ready",
    libraries: { d3: digit },
    integrity: { [digit]: "sha256-" + digit },
  });
  const use = (revision, digit) => ({
    kind: "ready",
    revision,
    libraries: { d3: digit },
    integrity: { [digit]: "sha256-" + digit },
  });
  const missing = { kind: "missing" };
  const failed = { kind: "failed" };
  const none = { kind: "none" };
  const retry = { kind: "failed", message: LIBRARIES_UNREACHABLE };
  const fetch = (revision) => ({ kind: "fetch", revision });
  for (const [name, input, expected] of [
    // A pin this host serves.
    ["a pin not asked for yet", { pin, current }, fetch(pin)],
    ["a pin this host serves", { pin, current, pinned: map("p") }, use(pin, "p")],
    ["a served pin on a host naming none", { pin, current: null, pinned: map("p") }, use(pin, "p")],
    // A pin this host does not serve falls through to the current revision.
    ["a missing pin", { pin, current, pinned: missing }, fetch(current)],
    [
      "a missing pin with the current catalog ready",
      { pin, current, pinned: missing, latest: map("c") },
      use(current, "c"),
    ],
    [
      "a missing pin on a host serving no catalog",
      { pin, current, pinned: missing, latest: missing },
      none,
    ],
    ["a missing pin on a host naming none", { pin, current: null, pinned: missing }, none],
    [
      "a missing pin and a failed current manifest",
      { pin, current, pinned: missing, latest: failed },
      retry,
    ],
    ["a failed pinned manifest", { pin, current, pinned: failed }, retry],
    // A pin equal to the current revision is asked for once.
    ["a pin equal to current", { pin, current: pin }, fetch(pin)],
    ["a pin equal to current, served", { pin, current: pin, pinned: map("p") }, use(pin, "p")],
    ["a pin equal to current, missing", { pin, current: pin, pinned: missing }, none],
    ["a pin equal to current, failed", { pin, current: pin, pinned: failed }, retry],
    // No pin: the host's current catalog.
    ["no pin", { pin: null, current }, fetch(current)],
    ["no pin, current ready", { pin: null, current, latest: map("c") }, use(current, "c")],
    ["no pin, current missing", { pin: null, current, latest: missing }, none],
    ["no pin, current failed", { pin: null, current, latest: failed }, retry],
    ["no pin on a host naming none", { pin: null, current: null }, none],
    ["an unreadable pin counts as none", { pin: "latest", current }, fetch(current)],
    ["an unreadable current counts as none", { pin: null, current: "latest" }, none],
  ])
    assert.deepEqual(libraryDecision(input), expected, name);
});

test("the host's current revision is the build's own, and a run from source has none", () => {
  assert.equal(hostLibraryRevision(revision), revision);
  assert.equal(hostLibraryRevision(UNBUILT_LIBRARY_CATALOG), null);
  // Unbundled, this module carries the unbuilt revision.
  assert.equal(hostLibraryRevision(), null);
  for (const value of [
    null,
    "",
    "latest",
    revision.toUpperCase(),
    revision.slice(1),
    revision + "0",
  ])
    assert.equal(hostLibraryRevision(value), null, String(value));
});

/** A fetch that answers from `answers` in order and records each URL. */
function fetchFrom(answers) {
  const urls = [];
  const fetch = async (url, init) => {
    urls.push({ url, credentials: init.credentials });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, urls };
}
const manifestUrl = (rev) => ({
  url: `${origin}/catalog/${rev}/manifest.json`,
  credentials: "omit",
});

test("a pin this host serves gives absolute URLs on this origin and is kept", async (t) => {
  t.after(forgetLibraryMaps);
  const { fetch, urls } = fetchFrom([new Response(manifest)]);
  const load = () =>
    firstValueFrom(libraryMap$(revision, { origin, current: nextRevision, fetch }));
  const first = await load();
  assert.equal(first.kind, "ready");
  assert.equal(first.revision, revision);
  assert.equal(first.libraries.d3, `${origin}/catalog/${revision}/d3.js`);
  assert.deepEqual(urls, [manifestUrl(revision)]);
  // The same revision again needs no request.
  assert.deepEqual(await load(), first);
  assert.equal(urls.length, 1);
});

test("a pin this host lacks loads the current catalog's map instead", async (t) => {
  t.after(forgetLibraryMaps);
  const { fetch, urls } = fetchFrom([
    new Response("No such library file\n", { status: 404 }),
    new Response(nextManifest),
  ]);
  const loaded = await firstValueFrom(
    libraryMap$(revision, { origin, current: nextRevision, fetch }),
  );
  assert.equal(loaded.kind, "ready");
  assert.equal(loaded.revision, nextRevision);
  assert.equal(loaded.libraries.d3, `${origin}/catalog/${nextRevision}/d3.js`);
  assert.deepEqual(urls, [manifestUrl(revision), manifestUrl(nextRevision)]);
});

test("a pin equal to the current revision is asked for once", async (t) => {
  t.after(forgetLibraryMaps);
  const { fetch, urls } = fetchFrom([new Response("", { status: 404 })]);
  assert.deepEqual(
    await firstValueFrom(libraryMap$(revision, { origin, current: revision, fetch })),
    { kind: "none" },
  );
  assert.deepEqual(urls, [manifestUrl(revision)]);
});

test("a view with no pin on a host naming no catalog asks for nothing", async () => {
  const { fetch, urls } = fetchFrom([]);
  for (const pin of [null, undefined, "latest"])
    assert.deepEqual(await firstValueFrom(libraryMap$(pin, { origin, fetch })), { kind: "none" });
  assert.equal(urls.length, 0);
});

for (const [name, answer, kind] of [
  ["a missing manifest", new Response("No such library file\n", { status: 404 }), "none"],
  ["a manifest whose hash does not match", new Response(manifest + " "), "none"],
  ["a failed request", new TypeError("network down"), "failed"],
])
  test(`${name} is not kept: the next load asks again`, async (t) => {
    t.after(forgetLibraryMaps);
    const { fetch, urls } = fetchFrom([answer, new Response(manifest)]);
    const load = () => firstValueFrom(libraryMap$(null, { origin, current: revision, fetch }));
    assert.equal((await load()).kind, kind);
    assert.equal((await load()).kind, "ready");
    assert.equal(urls.length, 2);
  });

test("unsubscribing aborts the manifest request and emits nothing", async (t) => {
  t.after(forgetLibraryMaps);
  let signal;
  const fetch = (_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason)),
    );
  };
  const seen = [];
  const subscription = libraryMap$(revision, { origin, fetch }).subscribe((value) =>
    seen.push(value),
  );
  subscription.unsubscribe();
  assert.equal(signal.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, []);
});
