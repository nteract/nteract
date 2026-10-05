import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startStaleActivationFixture,
  fixtureConfig,
  fixtureEnvironment,
  fixtureSource,
} from "./stale-activation-fixture.mjs";
import {
  requireExecutable,
  runActivationProbe,
  validateRecord,
  verifyReviewedEvidence,
  evidenceDigest,
} from "./stale-activation-runner.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function artifact(path) {
  const canonical = await realpath(path);
  const bytes = await readFile(canonical);
  // Hash native executable bytes, not a shell launcher with another payload.
  const magic = bytes.subarray(0, 4).toString("hex");
  if (
    !["7f454c46", "cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca"].includes(
      magic,
    ) &&
    bytes.subarray(0, 2).toString() !== "MZ"
  )
    throw new Error("CELLD_BIN must identify the native executable, not a launcher");
  return { realpath: canonical, sha256: sha256(bytes), bytes: bytes.length };
}

export async function runActivationDriver(t, options = {}) {
  const env = options.env || process.env;
  const full = options.full || false;
  requireExecutable(env);
  if (
    full &&
    (!env.ACTIVATION_REVIEWED_EVIDENCE ||
      !/^[a-f0-9]{64}$/.test(env.ACTIVATION_REVIEWED_SHA256 || ""))
  )
    throw new Error(
      "qualify:activation requires ACTIVATION_REVIEWED_EVIDENCE and ACTIVATION_REVIEWED_SHA256",
    );
  if (full)
    assert.equal(
      sha256(await readFile(env.ACTIVATION_REVIEWED_EVIDENCE)),
      env.ACTIVATION_REVIEWED_SHA256,
      "reviewed bundle digest mismatch before launch",
    );
  const identify = options.artifact || artifact;
  const WebSocket = options.WebSocketImpl || globalThis.WebSocket;
  const fetch = options.fetchImpl || globalThis.fetch;
  const fileIO = { appendFile, mkdir, writeFile, ...options.fileIO };
  let server;
  const sockets = new Set();
  let closingSockets = false;
  const transportErrors = [];
  let record = {
    complete: false,
    probeVerdict: "fail",
    qualificationVerdict: "fail",
    failures: [],
  };
  const provenance = {
    requestedExecutable: env.CELLD_BIN,
    platform: `${process.platform}-${process.arch}`,
    nodeVersion: process.version,
    effectiveConfig: {
      wrangler: fixtureConfig,
      environment: fixtureEnvironment,
      watch: false,
      // Bind every effective inherited value without persisting credentials.
      environmentSha256: evidenceDigest(
        Object.fromEntries(
          Object.entries({ ...env, ...fixtureEnvironment })
            .filter(
              ([key]) =>
                ![
                  "ACTIVATION_REVIEWED_EVIDENCE",
                  "ACTIVATION_REVIEWED_SHA256",
                  "ACTIVATION_EVIDENCE_INDEX",
                ].includes(key),
            )
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
      environmentKeys: Object.keys({ ...env, ...fixtureEnvironment })
        .filter(
          (key) =>
            ![
              "ACTIVATION_REVIEWED_EVIDENCE",
              "ACTIVATION_REVIEWED_SHA256",
              "ACTIVATION_EVIDENCE_INDEX",
            ].includes(key),
        )
        .sort(),
    },
    sources: {},
  };
  try {
    provenance.before = await identify(env.CELLD_BIN);
    for (const [name, file] of Object.entries({
      driver: "stale-activation-celld.test.mjs",
      fixture: "stale-activation-fixture.mjs",
      runner: "stale-activation-runner.mjs",
      harness: "local-celld.mjs",
    }))
      provenance.sources[name] = sha256(await readFile(resolve(directory, file)));
    provenance.sources.worker = sha256(fixtureSource);
    provenance.sourceCommit = options.sourceCommit
      ? await options.sourceCommit()
      : env.ACTIVATION_SOURCE_COMMIT;
    if (options.version) provenance.runtimeVersion = await options.version();
    else {
      const version = await promisify(execFile)(provenance.before.realpath, ["--version"], {
        timeout: 10_000,
        signal: t.signal,
      });
      provenance.runtimeVersion = (version.stdout + version.stderr).trim();
    }
    server = await (options.start || startStaleActivationFixture)(provenance.before.realpath);
    provenance.launch = server.launchMetadata;
    provenance.pid = server.pid;
    const get = async (path) => {
      t.signal.throwIfAborted();
      const response = await fetch(server.url + path, {
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(5000)]),
      });
      assert.equal(response.ok, true, `${path}: HTTP ${response.status}`);
      return await response.json();
    };
    const checkTransport = () => {
      t.signal.throwIfAborted();
      if (transportErrors.length) throw new Error(transportErrors.join("; "));
    };
    const io = {
      get,
      async openWs(path) {
        const messages = [];
        const ws = new WebSocket(server.url.replace(/^http/, "ws") + path);
        sockets.add(ws); // Own it before open/error, including failed opens.
        ws.addEventListener("error", () => transportErrors.push(`WebSocket error: ${path}`));
        ws.addEventListener("close", () => {
          if (!closingSockets) transportErrors.push(`Unexpected WebSocket close: ${path}`);
        });
        ws.addEventListener("message", (event) => {
          try {
            messages.push(JSON.parse(event.data));
          } catch (error) {
            transportErrors.push(`WebSocket decode error: ${String(error)}`);
          }
        });
        await new Promise((done, reject) => {
          const timer = setTimeout(
            () => finish(new Error(`WebSocket open timeout: ${path}`)),
            options.socketTimeoutMs || 5000,
          );
          const abort = () => finish(new Error("WebSocket open cancelled"));
          const opened = () => finish();
          const failed = () => finish(new Error(`WebSocket open failed: ${path}`));
          const closed = () => finish(new Error(`WebSocket closed before open: ${path}`));
          const finish = (error) => {
            clearTimeout(timer);
            t.signal.removeEventListener("abort", abort);
            ws.removeEventListener("open", opened);
            ws.removeEventListener("error", failed);
            ws.removeEventListener("close", closed);
            if (error) reject(error);
            else done();
          };
          ws.addEventListener("open", opened, { once: true });
          ws.addEventListener("error", failed, { once: true });
          ws.addEventListener("close", closed, { once: true });
          t.signal.addEventListener("abort", abort, { once: true });
          if (t.signal.aborted) abort();
        });
        return { messages, send: (message) => ws.send(message) };
      },
      async evict(previous) {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          // Touch only B during the idle window: hibernated A sockets do not
          // pin A, while B preserves the isolate's module-scoped jobs.
          const windowEnd = Date.now() + 10_000;
          while (Date.now() < windowEnd) {
            checkTransport();
            await get("/whoami?name=b");
            await sleep(1000);
          }
          const who = await get("/whoami?name=a");
          if (who.instance !== previous) return who;
        }
        throw new Error("A not evicted within 60s (inconclusive)");
      },
      async settle(path) {
        const deadline = Date.now() + 5000;
        let status;
        do {
          checkTransport();
          status = await get(path);
          if (status?.settled) return status;
          await sleep(50);
        } while (Date.now() < deadline);
        // Return the observed incomplete status so any actual leaked effect
        // still gets its own fail, never infer safety from a timeout.
        return status;
      },
      async observe(check) {
        const deadline = Date.now() + 750;
        do {
          checkTransport();
          if (check()) return true;
          await sleep(25);
        } while (Date.now() < deadline);
        return check();
      },
    };
    record = await (options.probe || runActivationProbe)(io);
    checkTransport();
  } catch (error) {
    record.failures.push(`driver: ${error?.stack || String(error)}`);
    record.probeVerdict = "fail";
  } finally {
    // Close every owned socket on every path, before the owned server.
    closingSockets = true;
    for (const ws of sockets) {
      try {
        await new Promise((done, reject) => {
          if (ws.readyState === WebSocket.CLOSED) return done();
          const timer = setTimeout(
            () => reject(new Error("owned socket close timed out")),
            options.cleanupTimeoutMs || 500,
          );
          ws.addEventListener(
            "close",
            () => {
              clearTimeout(timer);
              done();
            },
            { once: true },
          );
          ws.close();
        });
      } catch (error) {
        record.failures.push(`socket cleanup: ${String(error)}`);
      }
    }
    if (server) {
      try {
        let timer;
        try {
          await Promise.race([
            server.close(),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("owned server close timed out")),
                options.cleanupTimeoutMs || 20_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        record.failures.push(`server cleanup: ${String(error)}`);
      }
    }
    try {
      provenance.after = await identify(env.CELLD_BIN);
    } catch (error) {
      record.failures.push(`post-launch artifact: ${String(error)}`);
    }
  }
  if (transportErrors.length)
    record.failures.push(...transportErrors.map((error) => `transport: ${error}`));
  if (t.signal.aborted) record.failures.push("probe cancelled or timed out");
  record.provenance = provenance;
  if (provenance.before?.bytes !== provenance.after?.bytes)
    record.failures.push("native executable byte count changed");
  record.observedAt = new Date().toISOString();
  record.mode = full ? "qualification" : "diagnostic";
  const evidenceDir =
    options.evidenceDir || resolve(directory, "../../../.context/stale-activation-authority");
  const stem = `probe-${options.runId || `${record.observedAt.replaceAll(":", "-")}-${randomUUID()}`}`;
  const evidence = resolve(evidenceDir, `${stem}.json`);
  const logs = resolve(evidenceDir, `${stem}.log`);
  record.evidencePaths = [evidence, logs];
  if (full) {
    try {
      record.reviewedEvidence = await verifyReviewedEvidence(
        record,
        env.ACTIVATION_REVIEWED_EVIDENCE,
        env.ACTIVATION_REVIEWED_SHA256,
      );
    } catch (error) {
      record.failures.push(`reviewed evidence: ${String(error)}`);
    }
  }
  const capturedLogs = server?.logs();
  if (!capturedLogs) record.failures.push("server log evidence missing");
  record.diagnosticValidation = validateRecord(record);
  record.qualificationBlockers = validateRecord(record, { full: true });
  record.probeVerdict = record.diagnosticValidation.length ? "fail" : "pass";
  record.qualificationVerdict = record.qualificationBlockers.length ? "fail" : "pass";
  // Exclusive writes preserve historical evidence; failures are test failures.
  await fileIO.mkdir(evidenceDir, { recursive: true });
  await fileIO.writeFile(logs, capturedLogs || "No server logs captured\n", { flag: "wx" });
  if (env.ACTIVATION_EVIDENCE_INDEX) {
    // Append before the qualifying JSON; failed appends leave logs only.
    // Index entries describe pending writes, never qualification authority.
    await fileIO.appendFile(
      env.ACTIVATION_EVIDENCE_INDEX,
      JSON.stringify({
        observedAt: record.observedAt,
        evidencePaths: record.evidencePaths,
        binarySha256: provenance.before?.sha256,
        probeVerdict: record.probeVerdict,
        qualificationVerdict: "not-run",
        evidenceCommit: "pending-json",
      }) + "\n",
    );
  }
  await fileIO.writeFile(evidence, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  if (!options.probe) console.log("PROBE_VERDICT: " + JSON.stringify(record));
  assert.equal(
    full ? record.qualificationVerdict : record.probeVerdict,
    "pass",
    JSON.stringify(full ? record.qualificationBlockers : record.diagnosticValidation),
  );
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const full = process.argv.includes("--qualify");
  if (full) requireExecutable(process.env);
  test(
    full
      ? "mandatory native activation qualification"
      : "native immediate activation diagnostic (not full qualification)",
    { skip: !process.env.CELLD_BIN, timeout: 180_000 },
    (t) => runActivationDriver(t, { full }),
  );
}
