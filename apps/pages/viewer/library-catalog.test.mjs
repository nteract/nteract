// A view's library map from its pinned catalog's manifest: the decision over
// every answer, and the load step's caching and cancellation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { firstValueFrom } from "rxjs";
import {
  LIBRARIES_MISSING,
  LIBRARIES_UNREACHABLE,
  forgetLibraryMaps,
  libraryManifestOutcome,
  libraryMap$,
} from "./library-catalog.mjs";

const origin = "https://pages.example";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const manifest =
  JSON.stringify({
    imports: { d3: "d3.js", "@observablehq/plot": "observablehq-plot.js" },
    files: { "d3.js": "1".repeat(64), "observablehq-plot.js": "2".repeat(64) },
  }) + "\n";
const revision = sha256(manifest);

test("each manifest answer decides the view's library step", () => {
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
  const missing = { kind: "missing", message: LIBRARIES_MISSING };
  const failed = { kind: "failed", message: LIBRARIES_UNREACHABLE };
  const answer = (fields) => libraryManifestOutcome({ revision, origin, ...fields });
  const ok = { status: 200, text: manifest, digest: revision };
  for (const [name, fields, expected] of [
    ["the manifest the view pins", ok, ready],
    ["a revision this host lacks", { status: 404 }, missing],
    ["other bytes under the pinned name", { ...ok, digest: sha256("other") }, missing],
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

test("a manifest that matches its pin gives absolute URLs on this origin and is kept", async (t) => {
  t.after(forgetLibraryMaps);
  const { fetch, urls } = fetchFrom([new Response(manifest)]);
  const first = await firstValueFrom(libraryMap$(revision, { origin, fetch }));
  assert.equal(first.kind, "ready");
  assert.equal(first.libraries.d3, `${origin}/catalog/${revision}/d3.js`);
  assert.deepEqual(urls, [
    { url: `${origin}/catalog/${revision}/manifest.json`, credentials: "omit" },
  ]);
  // The same revision again needs no request.
  assert.deepEqual(await firstValueFrom(libraryMap$(revision, { origin, fetch })), first);
  assert.equal(urls.length, 1);
});

for (const [name, answer, kind] of [
  ["a missing manifest", new Response("No such library file\n", { status: 404 }), "missing"],
  ["a manifest whose hash does not match", new Response(manifest + " "), "missing"],
  ["a failed request", new TypeError("network down"), "failed"],
])
  test(`${name} is not kept: the next load asks again`, async (t) => {
    t.after(forgetLibraryMaps);
    const { fetch, urls } = fetchFrom([answer, new Response(manifest)]);
    const first = await firstValueFrom(libraryMap$(revision, { origin, fetch }));
    assert.equal(first.kind, kind);
    const retried = await firstValueFrom(libraryMap$(revision, { origin, fetch }));
    assert.equal(retried.kind, "ready");
    assert.equal(urls.length, 2);
  });

test("a view without a pin has no libraries and asks for nothing", async () => {
  const { fetch, urls } = fetchFrom([]);
  for (const pin of [null, undefined])
    assert.deepEqual(await firstValueFrom(libraryMap$(pin, { origin, fetch })), {
      kind: "ready",
      libraries: undefined,
    });
  assert.deepEqual(await firstValueFrom(libraryMap$("latest", { origin, fetch })), {
    kind: "missing",
    message: LIBRARIES_MISSING,
  });
  assert.equal(urls.length, 0);
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
