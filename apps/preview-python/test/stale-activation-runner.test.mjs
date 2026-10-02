import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  runActivationProbe,
  validateRecord,
  requireExecutable,
  verifyReviewedEvidence,
  evidenceDigest,
} from "./stale-activation-runner.mjs";

// No native runtime or evidence writes: deliberately adversarial transport.
function transport(fault = {}) {
  let generation = "old";
  let evictions = 0;
  const markers = new Map();
  const jobs = new Map();
  const sockets = new Map();
  const calls = [];
  return {
    calls,
    async openWs(path) {
      if (fault.open) throw new Error("socket open failed");
      const url = new URL(path, "http://probe");
      const scenario = url.searchParams.get("scenario");
      const name = url.searchParams.get("name");
      const instance = name === "b" ? "b" : generation;
      const messages = [];
      sockets.set(`${name}:${scenario}`, messages);
      jobs.set(`${instance}:${scenario}`, { instance, scenario });
      return {
        messages,
        send(message) {
          assert.equal(message, "who");
          if (!fault.eventAdoption && fault.eventAdoptionScenario !== scenario)
            messages.push({ type: "who", instance: generation });
        },
      };
    },
    async evict() {
      generation = `fresh-${++evictions}`;
      return fault.missingFresh ? {} : { instance: generation };
    },
    async get(path) {
      if (fault.fetch) throw new Error("fetch failed");
      const url = new URL(path, "http://probe");
      const scenario = url.searchParams.get("scenario");
      const name = url.searchParams.get("name");
      const instance = name === "b" ? "b" : generation;
      calls.push(url.pathname + ":" + scenario);
      if (url.pathname === "/whoami") return fault.missingOld ? {} : { instance };
      if (url.pathname === "/arm") {
        markers.set(`${name}:${scenario}`, url.searchParams.get("value"));
        return { armed: true };
      }
      if (url.pathname === "/marker") {
        if (fault.markerScenario === scenario) throw new Error("marker observer failed");
        return { completedBy: markers.get(`${name}:${scenario}`) };
      }
      if (url.pathname === "/publish") {
        if (!fault.adoption)
          for (const [key, messages] of sockets)
            if (key.startsWith(`${name}:`) && key !== `${name}:${fault.adoptionScenario}`)
              messages.push({ type: "hello", instance });
        return { instance };
      }
      if (url.pathname === "/resolve") {
        if (fault.resolve) return { resolved: false };
        const job = jobs.get(`${url.searchParams.get("instance")}:${scenario}`);
        assert.ok(job);
        job.resolved = true;
        job.resumed = true;
        const stale = job.instance !== generation && job.instance !== "b";
        job.attempted = {
          kv: scenario !== "socket",
          socket: scenario !== "kv",
          timer: scenario === "timer" || scenario === "timer-live",
        };
        job.outcomes = {};
        if (
          job.attempted.timer &&
          (fault.allTimersRejected || (scenario === "timer" && fault.timerRejected))
        ) {
          job.attempted = { timer: true };
          job.outcomes = { timer: "rejected" };
          job.errors = { timer: "host rejected released activation timer" };
          job.settled = true;
          return { resolved: true };
        }
        if (job.attempted.kv) {
          job.outcomes.kv = stale ? "rejected" : "fulfilled";
          if (stale && fault.staleKv) markers.set(`a:${scenario}`, job.instance);
          if (!stale && !fault.dropLivePut && !(fault.dropBPut && job.instance === "b"))
            markers.set(
              `${name === "b" && job.instance === "b" ? "b" : "a"}:${scenario}`,
              job.instance,
            );
        }
        if (job.attempted.socket) {
          // Combined callback stops after rejected KV, but socket-only must run.
          if (stale && scenario !== "socket") job.attempted.socket = false;
          else {
            job.outcomes.socket = stale && !fault.staleSocket ? "rejected" : "fulfilled";
            if (
              (!stale || fault.staleSocket) &&
              !(fault.dropBMessage && job.instance === "b") &&
              !(fault.dropAMessage && job.instance !== "b" && !stale)
            )
              sockets
                .get(`${job.instance === "b" ? "b" : "a"}:${scenario}`)
                .push({ type: "done", instance: job.instance, scenario });
          }
        }
        if (job.attempted.timer) job.outcomes.timer = "fulfilled";
        if (fault.missingAttempt) job.attempted = {};
        if (fault.missingOutcome) job.outcomes = {};
        if (fault.invalidOutcome)
          job.outcomes = { kv: "unknown", socket: "unknown", timer: "unknown" };
        if (fault.timer) job.outcomes.timer = "rejected";
        job.settled = !fault.unsettled;
        return { resolved: true };
      }
      if (url.pathname === "/status")
        return jobs.get(`${url.searchParams.get("instance")}:${scenario}`);
      throw new Error("unexpected endpoint");
    },
    async observe(check) {
      return check();
    },
    async settle(path) {
      return this.get(path);
    },
  };
}

test("acknowledged immediate safety is diagnostic only, never full qualification", async () => {
  const result = await runActivationProbe(transport());
  assert.equal(result.probeVerdict, "pass");
  assert.equal(result.qualificationVerdict, "fail");
  assert.equal(result.surfaces.asyncKvPut, "pass");
  assert.equal(result.surfaces.webSocketPublish, "pass");
  assert.equal(result.flushFencing, "design-only");
});

test("failed storage observer preserves independently confirmed stale publication", async () => {
  const result = await runActivationProbe(
    transport({ staleSocket: true, markerScenario: "socket" }),
  );
  assert.equal(result.probeVerdict, "fail");
  assert.equal(result.surfaces.webSocketPublish, "fail");
  assert.equal(result.observations.socket.publication, true);
  assert.equal(result.observations.socket.status.attempted.socket, true);
  assert.match(result.observations.socket.storageError, /marker observer failed/);
});

test("failed callback observer preserves independently confirmed stale publication", async () => {
  const io = transport({ staleSocket: true });
  const settle = io.settle.bind(io);
  io.settle = (path) => {
    if (new URL(path, "http://probe").searchParams.get("scenario") === "socket")
      throw new Error("status observer failed");
    return settle(path);
  };
  const result = await runActivationProbe(io);
  assert.equal(result.probeVerdict, "fail");
  assert.equal(result.surfaces.webSocketPublish, "fail");
  assert.equal(result.observations.socket.publication, true);
  assert.match(result.observations.socket.statusError, /status observer failed/);
});

test("failed KV marker observer cannot produce a passing storage verdict", async () => {
  const result = await runActivationProbe(transport({ markerScenario: "kv" }));
  assert.equal(result.probeVerdict, "fail");
  assert.equal(result.surfaces.asyncKvPut, "unaudited");
  assert.equal(result.surfaces.webSocketPublish, "pass");
  assert.match(result.observations.kv.storageError, /marker observer failed/);
});

for (const fault of [
  "open",
  "fetch",
  "resolve",
  "unsettled",
  "dropLivePut",
  "adoption",
  "missingAttempt",
  "missingOutcome",
  "invalidOutcome",
  "timer",
  "eventAdoption",
  "missingOld",
  "missingFresh",
  "staleKv",
  "dropBMessage",
  "dropBPut",
  "dropAMessage",
]) {
  test(`${fault} cannot produce a passing record`, async () => {
    const result = await runActivationProbe(transport({ [fault]: true }));
    assert.equal(result.probeVerdict, "fail");
    assert.equal(result.qualificationVerdict, "fail");
    assert.ok(result.failures.length);
  });
}

test("positively observed host timer rejection is safe, but missing rejection evidence is not", async () => {
  assert.equal((await runActivationProbe(transport({ timerRejected: true }))).probeVerdict, "pass");
  const io = transport({ timerRejected: true });
  const settle = io.settle;
  io.settle = async function (path) {
    const status = await settle.call(this, path);
    if (status.scenario === "timer") delete status.errors;
    return status;
  };
  assert.equal((await runActivationProbe(io)).probeVerdict, "fail");
});

test("globally broken timers cannot masquerade as stale activation rejection", async () => {
  const result = await runActivationProbe(transport({ allTimersRejected: true }));
  assert.equal(result.controls.timer, "fail");
  assert.equal(result.controls.live, "pass");
  assert.equal(result.controls.bBackground, "pass");
  assert.equal(result.probeVerdict, "fail");
});

test("KV rejection cannot hide an unfenced independent socket", async () => {
  const result = await runActivationProbe(transport({ staleSocket: true }));
  assert.equal(result.surfaces.asyncKvPut, "pass");
  assert.equal(result.surfaces.webSocketPublish, "fail");
  assert.equal(result.probeVerdict, "fail");
  assert.equal(result.observations.socket.status.attempted.socket, true);
});

for (const scenario of ["combined", "kv", "socket", "timer"]) {
  for (const handler of ["fetch", "event"]) {
    test(`selective ${scenario} ${handler} adoption loss cannot pass`, async () => {
      const result = await runActivationProbe(
        transport({
          [handler === "fetch" ? "adoptionScenario" : "eventAdoptionScenario"]: scenario,
        }),
      );
      assert.equal(result.controls.readoption, "fail");
      assert.equal(result.probeVerdict, "fail");
      assert.equal(result.observations[scenario].status.settled, true);
      assert.equal(result.surfaces.asyncKvPut, "pass");
      assert.equal(result.surfaces.webSocketPublish, "pass");
      assert.match(result.failures.join("\n"), new RegExp(`${scenario}.*adoption`));
    });
  }
}

test("selective adoption loss does not suppress independent stale effect failures", async () => {
  const result = await runActivationProbe(
    transport({
      adoptionScenario: "socket",
      eventAdoptionScenario: "socket",
      staleKv: true,
      staleSocket: true,
    }),
  );
  assert.equal(result.controls.readoption, "fail");
  assert.equal(result.surfaces.asyncKvPut, "fail");
  assert.equal(result.surfaces.webSocketPublish, "fail");
  assert.equal(result.observations.socket.publication, true);
});

test("timer stall and missing outcome are inconclusive even with preserved marker", async () => {
  for (const fault of ["settled", "outcome"]) {
    const io = transport();
    const settle = io.settle;
    io.settle = async function (path) {
      const status = await settle.call(this, path);
      if (status.scenario === "timer") {
        if (fault === "settled") status.settled = false;
        else delete status.outcomes.timer;
      }
      return status;
    };
    const record = await runActivationProbe(io);
    assert.equal(record.controls.timer, "fail");
    assert.equal(record.probeVerdict, "fail");
  }
});

test("missing callback acknowledgment cannot erase independently observed stale leaks", async () => {
  const io = transport({ staleSocket: true, staleKv: true });
  const settle = io.settle;
  io.settle = async function (path) {
    return { ...(await settle.call(this, path)), resumed: false };
  };
  const record = await runActivationProbe(io);
  assert.equal(record.surfaces.asyncKvPut, "fail");
  assert.equal(record.surfaces.webSocketPublish, "fail");
  assert.equal(record.probeVerdict, "fail");
});

test("unexpected observer errors are captured and other surfaces remain independent", async () => {
  const io = transport({ staleSocket: true });
  const settle = io.settle;
  io.settle = function (path) {
    if (path.includes("scenario=kv&")) throw new Error("observer assertion failed");
    return settle.call(this, path);
  };
  const result = await runActivationProbe(io);
  assert.equal(result.surfaces.asyncKvPut, "unaudited");
  assert.equal(result.surfaces.webSocketPublish, "fail");
  assert.match(result.failures.join("\n"), /observer assertion failed/);
});

test("cancelled and mismatched callback observations cannot pass", async () => {
  for (const cancelled of [true, false]) {
    const io = transport();
    const settle = io.settle;
    io.settle = async function (path) {
      if (cancelled) throw new Error("probe cancelled");
      return { ...(await settle.call(this, path)), instance: "wrong-activation" };
    };
    const record = await runActivationProbe(io);
    assert.equal(record.probeVerdict, "fail");
    assert.equal(record.qualificationVerdict, "fail");
    assert.ok(record.failures.length);
  }
});

test("qualification requires executable, matching artifacts and complete controls", () => {
  assert.throws(() => requireExecutable({}), /CELLD_BIN/);
  assert.equal(requireExecutable({ CELLD_BIN: "/native/celld" }), "/native/celld");
  for (const record of [
    {},
    {
      complete: true,
      failures: [],
      provenance: { before: { sha256: "a" }, after: { sha256: "b" } },
    },
    { complete: true, failures: [], controls: {}, flushFencing: "design-only" },
  ])
    assert.ok(validateRecord(record, { full: true }).length);
});

test("complete diagnostic provenance validates but design-only required criteria cannot qualify", async () => {
  const record = await runActivationProbe(transport());
  record.provenance = {
    before: { realpath: "/celld", sha256: "a".repeat(64) },
    after: { realpath: "/celld", sha256: "a".repeat(64) },
    runtimeVersion: "celld test",
    sources: Object.fromEntries(
      ["driver", "fixture", "runner", "harness", "worker"].map((name) => [name, "b".repeat(64)]),
    ),
    effectiveConfig: { environment: {} },
  };
  record.evidencePaths = ["/evidence.json", "/evidence.log"];
  assert.deepEqual(validateRecord(record), []);
  assert.ok(validateRecord(record, { full: true }).some((error) => error.includes("flush")));
  record.provenance.after.sha256 = "different";
  assert.ok(validateRecord(record).some((error) => error.includes("provenance")));
});

test("malformed hashes and omitted required surfaces cannot qualify", async () => {
  const record = await runActivationProbe(transport());
  record.provenance = {
    before: { realpath: "/celld", sha256: "abc" },
    after: { realpath: "/celld", sha256: "abc" },
    runtimeVersion: "celld test",
    sources: Object.fromEntries(
      ["driver", "fixture", "runner", "harness", "worker"].map((name) => [name, "b".repeat(64)]),
    ),
    effectiveConfig: {},
  };
  record.evidencePaths = ["/evidence.json", "/evidence.log"];
  assert.ok(validateRecord(record).some((error) => error.includes("provenance")));
  record.provenance.before.sha256 = record.provenance.after.sha256 = "a".repeat(64);
  record.flushFencing = record.nativeAudit = "pass";
  for (const surface of Object.keys(record.surfaces)) record.surfaces[surface] = "pass";
  assert.ok(validateRecord(record, { full: true }).some((error) => error.includes("reviewed")));
  delete record.surfaces.alarm;
  assert.ok(validateRecord(record, { full: true }).some((error) => error.includes("alarm")));
});

// These fixtures validate the explicit operator input boundary, not native authority.
async function reviewedFixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), "activation-review-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = await runActivationProbe(transport());
  record.provenance = {
    before: { realpath: "/celld", sha256: "a".repeat(64), bytes: 123 },
    after: { realpath: "/celld", sha256: "a".repeat(64), bytes: 123 },
    platform: "darwin-arm64",
    sourceCommit: "native-revision",
    runtimeVersion: "celld test",
    sources: Object.fromEntries(
      ["driver", "fixture", "runner", "harness", "worker"].map((key) => [key, "b".repeat(64)]),
    ),
    effectiveConfig: { environmentSha256: "c".repeat(64) },
  };
  record.evidencePaths = ["/record.json", "/record.log"];
  const content = "synthetic native evidence, never actual review";
  await writeFile(resolve(directory, "native.txt"), content);
  const reference = {
    path: "native.txt",
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  const bundle = {
    schemaVersion: 1,
    artifact: { sha256: record.provenance.before.sha256, bytes: 123, platform: "darwin-arm64" },
    sourceCommit: "native-revision",
    effectiveConfigSha256: evidenceDigest(record.provenance.effectiveConfig),
    sources: record.provenance.sources,
    review: { disposition: "reviewed", reference: "operator-selected synthetic fixture" },
    controls: { ...record.controls },
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
      Object.keys(record.surfaces).map((key) => [
        key,
        { disposition: "pass", evidence: reference },
      ]),
    ),
  };
  const path = resolve(directory, "bundle.json");
  const save = async () => {
    const bytes = JSON.stringify(bundle);
    await writeFile(path, bytes);
    return createHash("sha256").update(bytes).digest("hex");
  };
  return { record, bundle, path, save, directory };
}

test("operator-selected content-bound evidence validates without overwriting observed fields", async (t) => {
  const { record, path, save } = await reviewedFixture(t);
  const before = JSON.stringify(record);
  const verified = await verifyReviewedEvidence(record, path, await save());
  assert.equal(JSON.stringify(record), before);
  record.reviewedEvidence = verified;
  assert.deepEqual(validateRecord(record, { full: true }), []);
  assert.equal(record.surfaces.alarm, "unaudited");
  record.surfaces.asyncKvPut = "fail";
  assert.ok(validateRecord(record, { full: true }).length);
});

test("serialized verification labels and post-verification bundle edits cannot qualify", async (t) => {
  const { record, path, save } = await reviewedFixture(t);
  const verified = await verifyReviewedEvidence(record, path, await save());
  record.reviewedEvidence = JSON.parse(JSON.stringify(verified));
  assert.ok(validateRecord(record, { full: true }).length);
  record.reviewedEvidence = verified;
  verified.bundle.claims.flush.sha256 = "d".repeat(64);
  assert.ok(validateRecord(record, { full: true }).length);
});

for (const fault of [
  "digest",
  "artifact",
  "platform",
  "source",
  "config",
  "probeSource",
  "review",
  "revocation",
  "flush",
  "build",
  "childExecution",
  "launchRace",
  "configuration",
  "surface",
  "control",
  "unsupported",
  "missingContent",
  "changedContent",
]) {
  test(`reviewed input ${fault} fails closed`, async (t) => {
    const fixture = await reviewedFixture(t);
    const { bundle, record, path, directory } = fixture;
    if (fault === "artifact") bundle.artifact.sha256 = "d".repeat(64);
    if (fault === "platform") bundle.artifact.platform = "linux-x64";
    if (fault === "source") delete bundle.sourceCommit;
    if (fault === "config") bundle.effectiveConfigSha256 = "d".repeat(64);
    if (fault === "probeSource") bundle.sources = { ...bundle.sources, worker: "d".repeat(64) };
    if (fault === "review") delete bundle.review;
    if (
      ["revocation", "flush", "build", "childExecution", "launchRace", "configuration"].includes(
        fault,
      )
    )
      delete bundle.claims[fault];
    if (fault === "surface") delete bundle.surfaces.alarm;
    if (fault === "control") bundle.controls.live = "not-run";
    if (fault === "unsupported") bundle.surfaces.sql.disposition = "unsupported";
    const digest = await fixture.save();
    if (fault === "missingContent") await rm(resolve(directory, "native.txt"));
    if (fault === "changedContent") await writeFile(resolve(directory, "native.txt"), "changed");
    await assert.rejects(() =>
      verifyReviewedEvidence(record, path, fault === "digest" ? "e".repeat(64) : digest),
    );
  });
}
