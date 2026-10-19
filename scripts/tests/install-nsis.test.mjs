import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {test} from "node:test";
import {installNsis, verifiedArchive} from "../ci/install-nsis.mjs";

const bytes = Buffer.from("fixture archive; never a real executable");
const artifact = {version: "3.13", url: "https://example.invalid/nsis.zip", sha256: createHash("sha256").update(bytes).digest("hex")};
const ok = () => new Response(bytes);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nsis-setup-test-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  return {root, archive: join(root, "cache", "nsis-3.13.zip")};
}

test("verified cache avoids all network access", async t => {
  const {archive} = await fixture(t);
  await verifiedArchive(archive, {artifact, fetchImpl: async () => ok()});
  await verifiedArchive(archive, {artifact, fetchImpl: () => assert.fail("cache must avoid download")});
  assert.deepEqual(await readFile(archive), bytes);
});

test("corrupt cache fails closed before extraction or network access", async t => {
  const {archive} = await fixture(t);
  mkdirSync(dirname(archive));
  await writeFile(archive, "corrupt");
  await assert.rejects(verifiedArchive(archive, {artifact, fetchImpl: () => assert.fail("no fallback on bad checksum")}), /SHA-256 mismatch/);
});

for (const [name, failure] of [
  ["HTTP 503", () => new Response("unavailable", {status: 503})],
  ["connection reset", () => { throw new TypeError("fetch failed", {cause: {code: "ECONNRESET"}}); }],
  ["request timeout", () => { throw Object.assign(new Error("timed out"), {name: "TimeoutError"}); }],
]) {
  test(`transient download recovers: ${name}`, async t => {
    const {archive} = await fixture(t);
    let calls = 0;
    const delays = [];
    await verifiedArchive(archive, {artifact, fetchImpl: async () => ++calls === 1 ? failure() : ok(), sleepImpl: async ms => delays.push(ms)});
    assert.equal(calls, 2);
    assert.deepEqual(delays, [1000]);
    assert.deepEqual(await readFile(archive), bytes);
  });
}

test("persistent 503 stops after three attempts without caching partial data", async t => {
  const {archive} = await fixture(t);
  let calls = 0;
  const delays = [];
  await assert.rejects(verifiedArchive(archive, {artifact, fetchImpl: async () => { calls++; return new Response("unavailable", {status: 503}); }, sleepImpl: async ms => delays.push(ms)}), /HTTP 503/);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(existsSync(archive), false);
});

for (const [name, failure] of [
  ["404", () => new Response("missing", {status: 404})],
  ["403", () => new Response("forbidden", {status: 403})],
  ["TLS error", () => { throw new TypeError("untrusted certificate", {cause: {code: "CERT_HAS_EXPIRED"}}); }],
  ["checksum mismatch", () => new Response("wrong bytes")],
]) {
  test(`permanent failure is not retried: ${name}`, async t => {
    const {archive} = await fixture(t);
    let calls = 0;
    await assert.rejects(verifiedArchive(archive, {artifact, fetchImpl: async () => { calls++; return failure(); }, sleepImpl: () => assert.fail("permanent failure must not retry")}));
    assert.equal(calls, 1);
    assert.equal(existsSync(archive), false);
  });
}

async function installation(t, mode = "success") {
  const {root} = await fixture(t);
  const githubPath = join(root, "github-path");
  await writeFile(githubPath, "existing-path\n");
  const calls = [];
  const options = {
    cacheDir: join(root, "cache"), toolsDir: join(root, "tools"), githubPath,
    platform: "win32", artifact, fetchImpl: async () => ok(),
    execute(command, args, opts) {
      calls.push(command);
      assert.equal(existsSync(githubPath), true);
      if (command === "pwsh") {
        assert.ok(args.includes("-NoProfile"));
        if (mode === "extract-failed") throw new Error("extract failed");
        if (mode !== "missing-executable") {
          const exe = join(opts.env.NTERACT_NSIS_DESTINATION, "nsis-3.13", "makensis.exe");
          mkdirSync(dirname(exe));
          writeFileSync(exe, "mock executable; not run");
        }
        return "";
      }
      assert.deepEqual(args, ["/VERSION"]);
      if (mode === "probe-failed") throw new Error("compiler exited nonzero");
      return mode === "wrong-version" ? "v0.0\r\n" : "v3.13\r\n";
    },
  };
  return {options, calls};
}

test("publish only the extracted, runnable pinned compiler to the next step", async t => {
  const {options, calls} = await installation(t);
  const exe = await installNsis(options);
  assert.deepEqual(calls, ["pwsh", exe]);
  assert.equal(await readFile(options.githubPath, "utf8"), `existing-path\n${dirname(exe)}\n`);
});

for (const mode of ["extract-failed", "missing-executable", "probe-failed", "wrong-version"]) {
  test(`setup failure cannot publish PATH: ${mode}`, async t => {
    const {options, calls} = await installation(t, mode);
    await assert.rejects(installNsis(options));
    assert.equal(await readFile(options.githubPath, "utf8"), "existing-path\n");
    assert.deepEqual(await readdir(options.toolsDir), []);
    assert.equal(calls.filter(command => command === "pwsh").length, 1);
  });
}

test("non-Windows execution stops before downloads or installer commands", async t => {
  const {options} = await installation(t);
  await assert.rejects(installNsis({...options, platform: "darwin", fetchImpl: () => assert.fail("no download"), execute: () => assert.fail("no execution")}), /only for disposable Windows/);
});

test("installer never extracts or executes a corrupt cached archive", async t => {
  const {options} = await installation(t);
  mkdirSync(options.cacheDir);
  await writeFile(join(options.cacheDir, "nsis-3.13.zip"), "corrupt cache");
  await assert.rejects(installNsis({...options, fetchImpl: () => assert.fail("no download fallback"), execute: () => assert.fail("no unverified execution")}), /SHA-256 mismatch/);
  assert.equal(await readFile(options.githubPath, "utf8"), "existing-path\n");
  assert.equal(existsSync(options.toolsDir), false);
});
