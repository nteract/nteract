import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, readdir, rm, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {downloadWasmPack, publishArchive, WASM_PACK, downloadStep} from "./download-wasm-pack.mjs";

const bytes = Buffer.from("synthetic pinned archive");
const expected = {size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
function fixture(responses) {
  const calls = [];
  const delays = [];
  return {
    calls, delays,
    options: {
      expected,
      sleep: async (delay) => delays.push(delay),
      fetch: async (url, options) => {
        calls.push({url, options});
        const next = responses.shift();
        assert.notEqual(next, undefined, "unexpected extra request");
        if (next instanceof Error) throw next;
        return typeof next === "function" ? next(options) : next;
      },
    },
  };
}

test("production pin is the verified official archive, not latest or a mirror", () => {
  assert.deepEqual(WASM_PACK, {
    release: "https://github.com/wasm-bindgen/wasm-pack/releases/download/v0.15.0/wasm-pack-v0.15.0-x86_64-unknown-linux-musl.tar.gz",
    api: "https://api.github.com/repos/wasm-bindgen/wasm-pack/releases/assets/420850440",
    size: 2881231,
    sha256: "c09f971ecaed9a2efc80fdcea7a00ef6b53c7fadc8c57d1f61b53a6aa66b668a",
  });
});

for (const status of [404, 429, 500, 502, 503, 504])
  test(`release ${status} switches to the pinned official API`, async () => {
    const f = fixture([new Response("private response", {status}), new Response(bytes)]);
    assert.deepEqual(await downloadWasmPack(f.options), bytes);
    assert.deepEqual(f.calls.map((call) => call.url), [WASM_PACK.release, WASM_PACK.api]);
    assert.deepEqual(f.delays, [1000]);
  });

test("network failures are sanitized and use the same bounded fallback", async () => {
  const f = fixture([new Error("token=DO_NOT_LOG"), new Response(bytes)]);
  assert.deepEqual(await downloadWasmPack(f.options), bytes);
  assert.equal(f.calls.length, 2);
});

test("six failed attempts exhaust the budget without another request", async () => {
  const f = fixture(Array.from({length: 6}, () => new Response("token=DO_NOT_LOG", {status: 504})));
  await assert.rejects(downloadWasmPack(f.options), /^Error: wasm-pack download attempts exhausted$/);
  assert.equal(f.calls.length, 6);
  assert.deepEqual(f.delays, [1000, 2000, 4000, 8000, 16000]);
  assert.deepEqual(f.calls.map((call) => call.url), [WASM_PACK.release, ...Array(5).fill(WASM_PACK.api)]);
});

for (const status of [400, 401, 403, 410, 416])
  test(`release ${status} refuses without fallback`, async () => {
    const f = fixture([new Response("token=DO_NOT_LOG", {status})]);
    await assert.rejects(downloadWasmPack(f.options), /^Error: wasm-pack download refused$/);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.delays, []);
  });

test("an API 404 is terminal rather than a release discovery request", async () => {
  const f = fixture([new Response(null, {status: 504}), new Response(null, {status: 404})]);
  await assert.rejects(downloadWasmPack(f.options), /download refused/);
  assert.equal(f.calls.length, 2);
});

for (const prefix of [[], [new Response(null, {status: 504})]])
  test(`corrupt successful ${prefix.length ? "API" : "release"} bytes never fall back or publish`, async () => {
    const f = fixture([...prefix, new Response(Buffer.alloc(bytes.length))]);
    await assert.rejects(downloadWasmPack(f.options), /^Error: wasm-pack archive verification failed$/);
    assert.equal(f.calls.length, prefix.length + 1);
  });

test("200 API JSON is not accepted as an archive", async () => {
  const f = fixture([new Response(null, {status: 504}), new Response('{"token":"DO_NOT_LOG"}')]);
  await assert.rejects(downloadWasmPack(f.options), /archive verification failed/);
});

test("declared oversized responses are cancelled before body reads", async () => {
  let cancelled = false;
  const body = new ReadableStream({cancel() { cancelled = true; }});
  const f = fixture([new Response(body, {headers: {"content-length": String(bytes.length + 1)}})]);
  await assert.rejects(downloadWasmPack(f.options), /archive verification failed/);
  assert.equal(cancelled, true);
});

test("chunked oversized and undersized bodies fail integrity without retries", async () => {
  for (const body of [Buffer.alloc(bytes.length + 1), Buffer.alloc(bytes.length - 1)]) {
    const f = fixture([new Response(body)]);
    await assert.rejects(downloadWasmPack(f.options), /archive verification failed/);
    assert.equal(f.calls.length, 1);
  }
});

test("body transport failure discards partial bytes before fallback", async () => {
  const f = fixture([new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes.subarray(0, 2)); controller.error(new Error("token=DO_NOT_LOG")); },
  })), new Response(bytes)]);
  assert.deepEqual(await downloadWasmPack(f.options), bytes);
});

test("a stalled fetch is aborted at the attempt deadline before fallback", async (t) => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const f = fixture([
    ({signal}) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("private timeout")))),
    new Response(bytes),
  ]);
  const pending = downloadWasmPack(f.options);
  t.mock.timers.tick(59999);
  assert.equal(f.calls[0].options.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, bytes);
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.calls.length, 2);
});

test("failure while cancelling a refused response cannot trigger fallback", async () => {
  const f = fixture([new Response(new ReadableStream({cancel() { throw new Error("private cancellation"); }}), {status: 403})]);
  await assert.rejects(downloadWasmPack(f.options), /^Error: wasm-pack download refused$/);
  assert.equal(f.calls.length, 1);
});

test("redirects permit only credential-free HTTPS on the official asset host", async () => {
  const url = "https://release-assets.githubusercontent.com/github-production-release-asset/example?sig=DO_NOT_LOG";
  const f = fixture([new Response(null, {status: 302, headers: {location: url}}), new Response(bytes)]);
  assert.deepEqual(await downloadWasmPack(f.options), bytes);
  assert.equal(f.calls[1].url, url);
  for (const {options} of f.calls) {
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
    assert.deepEqual(options.headers, {Accept: "application/octet-stream"});
    assert.ok(options.signal instanceof AbortSignal);
  }
});

for (const location of ["http://release-assets.githubusercontent.com/a", "https://evil.example/a", "https://user:secret@release-assets.githubusercontent.com/a", "https://release-assets.githubusercontent.com:8443/a"])
  test(`unsafe redirect rejected without following: ${new URL(location).hostname}`, async () => {
    const f = fixture([new Response(null, {status: 302, headers: {location}})]);
    await assert.rejects(downloadWasmPack(f.options), /^Error: wasm-pack redirect refused$/);
    assert.equal(f.calls.length, 1);
  });

test("redirect loops are bounded independently of download retries", async () => {
  const f = fixture(Array.from({length: 4}, () => new Response(null, {
    status: 302, headers: {location: "https://release-assets.githubusercontent.com/loop"},
  })));
  await assert.rejects(downloadWasmPack(f.options), /redirect refused/);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.delays, []);
});

test("download transition has terminal integrity failure and a fixed retry budget", () => {
  const initial = {phase: "fetching", attempt: 1, source: "release"};
  assert.deepEqual(downloadStep(initial, "verified"), {phase: "verified"});
  assert.deepEqual(downloadStep(initial, "refused"), {phase: "failed"});
  assert.deepEqual(downloadStep(initial, "retry"), {phase: "backoff", attempt: 2, source: "api"});
  assert.deepEqual(downloadStep({phase: "backoff", attempt: 2, source: "api"}, "elapsed"), {phase: "fetching", attempt: 2, source: "api"});
  assert.deepEqual(downloadStep({phase: "fetching", attempt: 6, source: "api"}, "retry"), {phase: "exhausted"});
  for (const phase of ["verified", "failed", "exhausted"])
    for (const event of ["retry", "verified", "refused", "elapsed"])
      assert.deepEqual(downloadStep({phase}, event), {phase});
});

test("publication is exclusive, private and leaves no partial files or symlink writes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wasm-download-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const output = join(dir, "archive.tar.gz");
  await publishArchive(output, bytes);
  assert.deepEqual(await readFile(output), bytes);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(publishArchive(output, Buffer.from("replacement")));
  assert.deepEqual(await readFile(output), bytes);
  const target = join(dir, "target");
  await writeFile(target, "unchanged");
  await symlink(target, join(dir, "link"));
  await assert.rejects(publishArchive(join(dir, "link"), bytes));
  assert.equal(await readFile(target, "utf8"), "unchanged");
  assert.deepEqual((await readdir(dir)).sort(), ["archive.tar.gz", "link", "target"]);
});
