import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runActivationDriver } from "./stale-activation-celld.test.mjs";
import { evidenceDigest } from "./stale-activation-runner.mjs";

class Socket extends EventTarget {
  static CLOSED = 3;
  readyState = 0;
  static owned = [];
  constructor() {
    super();
    Socket.owned.push(this);
    if (Socket.fault !== "timeout")
      queueMicrotask(() =>
        this.dispatchEvent(new Event(Socket.fault === "handshake" ? "error" : "open")),
      );
  }
  close() {
    if (Socket.fault === "cleanupTimeout") return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  send() {}
}

async function setup(t, fault) {
  const directory = await mkdtemp(resolve(tmpdir(), "activation-driver-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  Socket.owned = [];
  Socket.fault = fault;
  let closed = 0;
  const identity = { realpath: "/native", bytes: 10, sha256: "a".repeat(64) };
  const options = {
    env: {
      CELLD_BIN: "/explicit/native",
      INHERITED_CONFIG: "present",
      SECRET_TOKEN: "do-not-record",
    },
    evidenceDir: directory,
    runId: "owned-run",
    WebSocketImpl: Socket,
    socketTimeoutMs: 5,
    cleanupTimeoutMs: 5,
    artifact: async () => identity,
    version: async () => "native test",
    sourceCommit: async () => "revision",
    start: async () => ({
      url: "http://owned",
      pid: 123,
      logs: () => "owned logs",
      launchMetadata: {},
      close: async () => {
        closed++;
        if (fault === "cleanup") throw new Error("cleanup failed");
        if (fault === "serverTimeout") await new Promise(() => {});
      },
    }),
    fetchImpl: async () => {
      throw new Error("fetch failed");
    },
    probe: async (io) => {
      if (["handshake", "cancel", "timeout", "cleanupTimeout"].includes(fault))
        await io.openWs("/ws");
      if (fault === "fetch") await io.get("/whoami");
      if (fault === "resolution") await io.settle("/status");
      return {
        complete: true,
        failures: [],
        controls: Object.fromEntries(
          ["readoption", "timer", "live", "bBackground"].map((key) => [key, "pass"]),
        ),
        surfaces: Object.fromEntries(
          [
            "asyncKvPut",
            "webSocketPublish",
            "asyncKvRead",
            "asyncKvDelete",
            "syncKv",
            "sql",
            "transaction",
            "alarm",
          ].map((key) => [
            key,
            ["asyncKvPut", "webSocketPublish"].includes(key) ? "pass" : "unaudited",
          ]),
        ),
        observations: {},
      };
    },
  };
  return { options, directory, closed: () => closed };
}

for (const fault of [
  "handshake",
  "fetch",
  "resolution",
  "cancel",
  "timeout",
  "cleanup",
  "cleanupTimeout",
  "serverTimeout",
  "log",
  "json",
  "index",
  "changedBinary",
  "changedBytes",
  "missingLogs",
]) {
  test(`driver ${fault} cannot succeed and cleans only owned resources`, async (t) => {
    const fixture = await setup(t, fault);
    const { options, directory } = fixture;
    const controller = new AbortController();
    if (fault === "cancel") controller.abort();
    if (["log", "json", "index"].includes(fault))
      options.fileIO = {
        [fault === "index" ? "appendFile" : "writeFile"]: async (path) => {
          if (fault === "index" || path.endsWith(fault === "log" ? ".log" : ".json"))
            throw new Error(`${fault} write failed`);
          const { writeFile } = await import("node:fs/promises");
          return writeFile(path, "logs", { flag: "wx" });
        },
      };
    if (fault === "index")
      options.env.ACTIVATION_EVIDENCE_INDEX = resolve(directory, "index.jsonl");
    if (fault === "missingLogs")
      options.start = async () => ({ close: async () => {}, logs: () => "" });
    if (fault === "changedBinary" || fault === "changedBytes") {
      let calls = 0;
      options.artifact = async () => ({
        realpath: "/native",
        bytes: fault === "changedBytes" && calls > 0 ? 11 : 10,
        sha256: (++calls === 1 || fault === "changedBytes" ? "a" : "b").repeat(64),
      });
    }
    await assert.rejects(() => runActivationDriver({ signal: controller.signal }, options));
    if (fault !== "missingLogs") assert.equal(fixture.closed(), 1);
    if (fault !== "cleanupTimeout")
      assert.ok(Socket.owned.every((socket) => socket.readyState === Socket.CLOSED));
    const files = await readdir(directory);
    for (const path of files.filter((file) => file.endsWith(".json"))) {
      const record = JSON.parse(await readFile(resolve(directory, path), "utf8"));
      assert.notEqual(record.qualificationVerdict, "pass");
      assert.ok(!JSON.stringify(record.provenance).includes("do-not-record"));
    }
  });
}

test("duplicate run IDs cannot overwrite historical records", async (t) => {
  const { options, directory } = await setup(t);
  await runActivationDriver({ signal: new AbortController().signal }, options);
  const before = await readFile(resolve(directory, "probe-owned-run.json"));
  await assert.rejects(
    () => runActivationDriver({ signal: new AbortController().signal }, options),
    /EEXIST/,
  );
  assert.deepEqual(await readFile(resolve(directory, "probe-owned-run.json")), before);
});

test("successful owned diagnostic captures inherited configuration without secret values", async (t) => {
  const fixture = await setup(t);
  const record = await runActivationDriver(
    { signal: new AbortController().signal },
    fixture.options,
  );
  assert.equal(record.probeVerdict, "pass");
  assert.equal(record.qualificationVerdict, "fail");
  assert.ok(record.provenance.effectiveConfig.environmentKeys.includes("INHERITED_CONFIG"));
  assert.equal(record.provenance.sourceCommit, "revision");
  assert.equal(fixture.closed(), 1);
  assert.ok(!JSON.stringify(record.provenance).includes("do-not-record"));
});

test("qualification missing reviewed inputs refuses before owning a server", async (t) => {
  const fixture = await setup(t);
  fixture.options.full = true;
  await assert.rejects(
    () => runActivationDriver({ signal: new AbortController().signal }, fixture.options),
    /ACTIVATION_REVIEWED/,
  );
  assert.equal(fixture.closed(), 0);
});

test("qualification forged bundle digest refuses before owning a server", async (t) => {
  const fixture = await setup(t);
  const path = resolve(fixture.directory, "forged.json");
  await writeFile(path, "{}");
  fixture.options.env.ACTIVATION_REVIEWED_EVIDENCE = path;
  fixture.options.env.ACTIVATION_REVIEWED_SHA256 = "a".repeat(64);
  fixture.options.full = true;
  await assert.rejects(
    () => runActivationDriver({ signal: new AbortController().signal }, fixture.options),
    /digest mismatch before launch/,
  );
  assert.equal(fixture.closed(), 0);
});

for (const fault of ["none", "missingSource", "missingChild", "indexFailure", "changedConfig"]) {
  test(`full driver operator-selected synthetic evidence: ${fault}`, async (t) => {
    const { options, directory } = await setup(t);
    const diagnostic = await runActivationDriver({ signal: new AbortController().signal }, options);
    const content = "synthetic review evidence: structure only";
    await writeFile(resolve(directory, "native.txt"), content);
    const reference = {
      path: "native.txt",
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    const bundle = {
      schemaVersion: 1,
      artifact: {
        sha256: diagnostic.provenance.before.sha256,
        bytes: 10,
        platform: diagnostic.provenance.platform,
      },
      sourceCommit: "revision",
      sources: diagnostic.provenance.sources,
      effectiveConfigSha256: evidenceDigest(diagnostic.provenance.effectiveConfig),
      review: { disposition: "reviewed", reference: "explicit synthetic test selection" },
      controls: diagnostic.controls,
      claims: Object.fromEntries(
        [
          "source",
          "revocation",
          "flush",
          "build",
          "childExecution",
          "launchRace",
          "configuration",
        ].map((key) => [key, reference]),
      ),
      surfaces: Object.fromEntries(
        Object.keys(diagnostic.surfaces).map((key) => [
          key,
          { disposition: "pass", evidence: reference },
        ]),
      ),
    };
    if (fault === "missingChild") delete bundle.claims.childExecution;
    const bytes = JSON.stringify(bundle);
    const path = resolve(directory, "review.json");
    await writeFile(path, bytes);
    options.env.ACTIVATION_REVIEWED_EVIDENCE = path;
    options.env.ACTIVATION_REVIEWED_SHA256 = createHash("sha256").update(bytes).digest("hex");
    options.full = true;
    options.runId = "full-run";
    if (fault === "missingSource") options.sourceCommit = async () => undefined;
    if (fault === "changedConfig") options.env.INHERITED_CONFIG = "changed";
    if (fault === "indexFailure") {
      options.env.ACTIVATION_EVIDENCE_INDEX = resolve(directory, "index.jsonl");
      options.fileIO = {
        appendFile: async () => {
          throw new Error("append failed");
        },
      };
    }
    if (fault === "none") {
      const record = await runActivationDriver({ signal: new AbortController().signal }, options);
      assert.equal(record.qualificationVerdict, "pass");
      assert.equal(record.surfaces.alarm, "unaudited");
    } else {
      await assert.rejects(() =>
        runActivationDriver({ signal: new AbortController().signal }, options),
      );
      if (fault === "indexFailure")
        assert.ok(!(await readdir(directory)).includes("probe-full-run.json"));
      else
        assert.equal(
          JSON.parse(await readFile(resolve(directory, "probe-full-run.json")))
            .qualificationVerdict,
          "fail",
        );
    }
  });
}
