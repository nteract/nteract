import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const verifiedInputs = new WeakMap();
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const evidenceDigest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function verifyReviewedEvidence(record, path, expectedSha256) {
  assert.ok(
    path && hash(expectedSha256),
    "explicit reviewed evidence path and expected SHA256 required",
  );
  const bytes = await readFile(path);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expectedSha256,
    "reviewed bundle digest mismatch",
  );
  const bundle = JSON.parse(bytes);
  const provenance = record.provenance;
  assert.equal(bundle.schemaVersion, 1, "unsupported reviewed evidence schema");
  assert.ok(
    bundle.review?.disposition === "reviewed" &&
      typeof bundle.review.reference === "string" &&
      bundle.review.reference.trim(),
    "operator-selected review claim missing",
  );
  assert.ok(hash(bundle.artifact?.sha256), "artifact hash missing");
  assert.equal(bundle.artifact.sha256, provenance?.before?.sha256, "artifact mismatch");
  assert.equal(bundle.artifact.bytes, provenance?.before?.bytes, "artifact byte count mismatch");
  assert.ok(Number.isSafeInteger(bundle.artifact.bytes) && bundle.artifact.bytes > 0);
  assert.equal(bundle.artifact.platform, provenance?.platform, "platform mismatch");
  assert.ok(
    typeof bundle.sourceCommit === "string" && bundle.sourceCommit.trim(),
    "native source revision missing",
  );
  assert.equal(bundle.sourceCommit, provenance?.sourceCommit, "source revision mismatch");
  assert.equal(
    bundle.effectiveConfigSha256,
    evidenceDigest(provenance.effectiveConfig),
    "effective configuration mismatch",
  );
  for (const name of ["driver", "fixture", "runner", "harness", "worker"]) {
    assert.ok(hash(bundle.sources?.[name]), `${name} digest missing`);
    assert.equal(bundle.sources[name], provenance.sources?.[name], `${name} source mismatch`);
  }
  for (const name of ["readoption", "timer", "live", "bBackground"]) {
    assert.equal(bundle.controls?.[name], "pass", `${name} reviewed control incomplete`);
    assert.equal(
      bundle.controls[name],
      record.controls?.[name],
      `${name} observed control mismatch`,
    );
  }
  const references = [];
  for (const name of [
    "source",
    "revocation",
    "flush",
    "build",
    "childExecution",
    "launchRace",
    "configuration",
  ])
    references.push([name, bundle.claims?.[name]]);
  for (const name of [
    "asyncKvPut",
    "webSocketPublish",
    "asyncKvRead",
    "asyncKvDelete",
    "syncKv",
    "sql",
    "transaction",
    "alarm",
  ]) {
    assert.equal(
      bundle.surfaces?.[name]?.disposition,
      "pass",
      `${name} unaudited, unsupported or failed`,
    );
    references.push([name, bundle.surfaces[name].evidence]);
  }
  for (const [name, reference] of references) {
    assert.ok(
      typeof reference?.path === "string" && reference.path && hash(reference.sha256),
      `${name} content reference missing`,
    );
    const content = await readFile(resolve(dirname(path), reference.path));
    assert.ok(content.length, `${name} empty evidence`);
    assert.equal(
      createHash("sha256").update(content).digest("hex"),
      reference.sha256,
      `${name} content digest mismatch`,
    );
  }
  const result = { bundlePath: resolve(path), sha256: expectedSha256, bundle };
  // Only an explicit verification in this process counts; JSON 'verified/pass'
  // strings cannot authenticate input. The operator, not this tool, selects review.
  verifiedInputs.set(result, {
    binding: evidenceDigest({ provenance, controls: record.controls }),
    digest: evidenceDigest(result),
  });
  return result;
}

export function requireExecutable(env) {
  if (!env.CELLD_BIN) throw new Error("qualify:activation requires CELLD_BIN");
  return env.CELLD_BIN;
}

export function validateRecord(record, { full = false } = {}) {
  const errors = [];
  if (!record.complete) errors.push("probe did not complete");
  if (!Array.isArray(record.failures) || record.failures.length)
    errors.push("probe errors present");
  const provenance = record.provenance;
  if (
    !hash(provenance?.before?.sha256) ||
    !hash(provenance?.after?.sha256) ||
    !provenance?.before?.realpath ||
    provenance.before.sha256 !== provenance.after?.sha256 ||
    provenance.before.realpath !== provenance.after?.realpath ||
    !provenance.runtimeVersion ||
    !["driver", "fixture", "runner", "harness", "worker"].every((source) =>
      hash(provenance.sources?.[source]),
    ) ||
    !provenance.effectiveConfig ||
    !Array.isArray(record.evidencePaths) ||
    record.evidencePaths.length < 2 ||
    record.evidencePaths.some((path) => typeof path !== "string" || !path)
  )
    errors.push("missing or mismatched artifact provenance");
  for (const control of ["readoption", "timer", "live", "bBackground"])
    if (record.controls?.[control] !== "pass")
      errors.push(`${control} control incomplete or failed`);
  for (const surface of ["asyncKvPut", "webSocketPublish"])
    if (record.surfaces?.[surface] !== "pass") errors.push(`${surface} incomplete or failed`);
  if (full) {
    const verified = verifiedInputs.get(record.reviewedEvidence);
    if (
      !verified ||
      verified.binding !== evidenceDigest({ provenance, controls: record.controls }) ||
      verified.digest !== evidenceDigest(record.reviewedEvidence)
    )
      errors.push(
        "explicit content-bound reviewed evidence missing or changed (native audit/flush/surfaces)",
      );
    if (
      !Number.isSafeInteger(provenance?.before?.bytes) ||
      provenance.before.bytes <= 0 ||
      provenance.before.bytes !== provenance?.after?.bytes
    )
      errors.push("native artifact byte count missing or changed");
    if (
      typeof provenance?.platform !== "string" ||
      !provenance.platform ||
      typeof provenance?.sourceCommit !== "string" ||
      !provenance.sourceCommit
    )
      errors.push("native platform/source identity missing");
    for (const surface of [
      "asyncKvPut",
      "webSocketPublish",
      "asyncKvRead",
      "asyncKvDelete",
      "syncKv",
      "sql",
      "transaction",
      "alarm",
    ]) {
      const disposition = record.surfaces?.[surface];
      if (!["pass", "fail", "unaudited"].includes(disposition))
        errors.push(`${surface} disposition missing or invalid`);
      if (disposition === "fail") errors.push(`${surface} failed runtime observation`);
    }
  }
  return errors;
}

// Transport/time injection is only for testing the driver, never evidence of
// native fencing. Status is module state queried through B, not old A storage.
export async function runActivationProbe(io) {
  const record = {
    complete: false,
    probeVerdict: "fail",
    qualificationVerdict: "fail",
    surfaces: {
      asyncKvPut: "unaudited",
      webSocketPublish: "unaudited",
      asyncKvRead: "unaudited",
      asyncKvDelete: "unaudited",
      syncKv: "unaudited",
      sql: "unaudited",
      transaction: "unaudited",
      alarm: "unaudited",
    },
    controls: { readoption: "not-run", timer: "not-run", live: "not-run", bBackground: "not-run" },
    flushFencing: "design-only",
    nativeAudit: "unverified",
    observations: {},
    failures: [],
  };
  const path = (endpoint, scenario, name = "a", extra = {}) =>
    `/${endpoint}?${new URLSearchParams({ name, scenario, ...extra })}`;
  const capture = async (label, fn) => {
    try {
      await fn();
    } catch (error) {
      record.failures.push(`${label}: ${error?.stack || String(error)}`);
      if (label in record.controls) record.controls[label] = "fail";
    }
  };
  const done = (socket, instance, scenario) =>
    socket.messages.some(
      (msg) => msg.type === "done" && msg.instance === instance && msg.scenario === scenario,
    );
  async function resume(scenario, instance) {
    const response = await io.get(path("resolve", scenario, "b", { instance }));
    assert.equal(response.resolved, true, `${scenario} resolver missing`);
    const status = await io.settle(path("status", scenario, "b", { instance }));
    return status || {};
  }
  function acknowledged(status, instance, scenario) {
    assert.ok(status, `${scenario} status missing`);
    assert.equal(status.instance, instance, `${scenario} status activation mismatch`);
    assert.equal(status.scenario, scenario, `${scenario} status scenario mismatch`);
    assert.equal(status.resolved, true, `${scenario} resolution acknowledgment missing`);
    assert.equal(status.resumed, true, `${scenario} continuation acknowledgment missing`);
  }
  async function readopt(sockets, old, fresh) {
    await capture("readoption", async () => {
      const published = await io.get(path("publish", "combined"));
      assert.equal(published.instance, fresh, "fresh fetch adoption identity mismatch");
    });
    record.observations.readoption ||= {};
    for (const [scenario, socket] of Object.entries(sockets)) {
      const observation = { old, fresh, fetch: false, event: false };
      record.observations.readoption[scenario] = observation;
      await capture("readoption", async () => {
        observation.fetch = await io.observe(() =>
          socket.messages.some((msg) => msg.type === "hello" && msg.instance === fresh),
        );
        assert.equal(observation.fetch, true, `${scenario} fresh fetch adoption missing`);
      });
      await capture("readoption", async () => {
        socket.send("who");
        observation.event = await io.observe(() =>
          socket.messages.some((msg) => msg.type === "who" && msg.instance === fresh),
        );
        assert.equal(
          observation.event,
          true,
          `${scenario} fresh webSocketMessage adoption missing`,
        );
      });
    }
  }
  async function stale(scenario, old, fresh, socket) {
    const sentinel = `sentinel:${scenario}:${fresh}`;
    await io.get(path("arm", scenario, "a", { value: sentinel }));
    const observation = { sentinel, old, fresh };
    record.observations[scenario] = observation;
    await capture(`${scenario} status`, async () => {
      try {
        observation.status = await resume(scenario, old);
      } catch (error) {
        observation.statusError = String(error);
        throw error;
      }
    });
    await capture(`${scenario} storage`, async () => {
      try {
        observation.marker = (await io.get(path("marker", scenario))).completedBy;
        if (observation.marker !== sentinel) record.surfaces.asyncKvPut = "fail";
      } catch (error) {
        observation.storageError = String(error);
        throw error;
      }
    });
    // The observation drain is bounded; settled acknowledgment is mandatory.
    await capture(`${scenario} publication`, () => io.observe(() => done(socket, old, scenario)));
    const publication = done(socket, old, scenario);
    observation.publication = publication;
    const status = observation.status || {};
    const kvLeak = !observation.storageError && observation.marker !== sentinel;
    if (kvLeak) record.surfaces.asyncKvPut = "fail";
    if (publication) record.surfaces.webSocketPublish = "fail";
    acknowledged(status, old, scenario);
    if (scenario === "kv" && record.surfaces.asyncKvPut !== "fail")
      record.surfaces.asyncKvPut =
        !observation.storageError &&
        status.settled &&
        status.attempted?.kv &&
        ["fulfilled", "rejected"].includes(status.outcomes?.kv)
          ? "pass"
          : "unaudited";
    if (scenario === "socket" && record.surfaces.webSocketPublish !== "fail")
      record.surfaces.webSocketPublish =
        status.settled &&
        status.attempted?.socket &&
        ["fulfilled", "rejected"].includes(status.outcomes?.socket)
          ? "pass"
          : "unaudited";
    assert.equal(kvLeak, false, `${scenario} stale storage mutation`);
    assert.equal(publication, false, `${scenario} stale socket publication`);
    assert.equal(status.settled, true, `${scenario} callback settlement unobserved (inconclusive)`);
    if (scenario === "timer") {
      assert.equal(status.attempted?.timer, true, "timer attempt unobserved");
      assert.ok(
        ["fulfilled", "rejected"].includes(status.outcomes?.timer),
        "timer outcome unobserved",
      );
      if (status.outcomes.timer === "rejected") {
        assert.ok(
          typeof status.errors?.timer === "string" && status.errors.timer.trim(),
          "timer rejection evidence unobserved",
        );
        assert.notEqual(status.attempted?.kv, true, "KV attempted after timer rejection");
        assert.notEqual(status.attempted?.socket, true, "socket attempted after timer rejection");
        assert.equal(status.outcomes?.kv, undefined);
        assert.equal(status.outcomes?.socket, undefined);
        record.controls.timer = "pass";
        return;
      }
    }
    if (scenario !== "socket") {
      assert.equal(status.attempted?.kv, true, `${scenario} KV attempt unobserved`);
      assert.ok(
        ["fulfilled", "rejected"].includes(status.outcomes?.kv),
        `${scenario} KV outcome unobserved`,
      );
    }
    if (scenario === "socket") {
      assert.equal(status.attempted?.socket, true, "socket attempt unobserved");
      assert.ok(
        ["fulfilled", "rejected"].includes(status.outcomes?.socket),
        "socket outcome unobserved",
      );
    }
    if (scenario !== "kv" && status.outcomes?.kv === "fulfilled") {
      assert.equal(
        status.attempted?.socket,
        true,
        `${scenario} combined socket attempt unobserved`,
      );
      assert.ok(
        ["fulfilled", "rejected"].includes(status.outcomes?.socket),
        `${scenario} combined socket outcome unobserved`,
      );
    }
    if (scenario === "timer") {
      assert.equal(status.attempted?.timer, true, "timer attempt unobserved");
      assert.equal(status.outcomes?.timer, "fulfilled", "timer continuation unobserved");
      record.controls.timer = "pass";
    }
  }
  await capture("setup", async () => {
    const sockets = {};
    for (const scenario of ["combined", "kv", "socket"])
      sockets[scenario] = await io.openWs(path("ws", scenario));
    const old = (await io.get(path("whoami", "combined"))).instance;
    const fresh = (await io.evict(old)).instance;
    assert.ok(typeof old === "string" && old, "old activation identity missing");
    assert.ok(typeof fresh === "string" && fresh, "fresh activation identity missing");
    assert.notEqual(fresh, old, "reactivation must mint a new UUID");
    record.controls.readoption = "pass";
    await readopt(sockets, old, fresh);
    for (const scenario of ["combined", "kv", "socket"])
      await capture(scenario, () => stale(scenario, old, fresh, sockets[scenario]));
    await capture("timer", async () => {
      const socket = await io.openWs(path("ws", "timer"));
      const timerOld = (await io.get(path("whoami", "timer"))).instance;
      const timerFresh = (await io.evict(timerOld)).instance;
      assert.ok(typeof timerOld === "string" && timerOld, "old timer identity missing");
      assert.ok(typeof timerFresh === "string" && timerFresh, "fresh timer identity missing");
      assert.notEqual(timerOld, timerFresh);
      await readopt({ timer: socket }, timerOld, timerFresh);
      await stale("timer", timerOld, timerFresh, socket);
    });
    for (const [control, name, scenario] of [
      ["timer", "a", "timer-live"],
      ["live", "a", "live"],
      ["bBackground", "b", "b-live"],
    ])
      await capture(control, async () => {
        const socket = await io.openWs(path("ws", scenario, name));
        const instance = (await io.get(path("whoami", scenario, name))).instance;
        assert.ok(typeof instance === "string" && instance, "live identity missing");
        const sentinel = `live-sentinel:${scenario}:${instance}`;
        await io.get(path("arm", scenario, name, { value: sentinel }));
        assert.equal((await io.get(path("marker", scenario, name))).completedBy, sentinel);
        const status = await resume(scenario, instance);
        const marker = (await io.get(path("marker", scenario, name))).completedBy;
        const publication = await io.observe(() => done(socket, instance, scenario));
        record.observations[scenario] = { status, marker, sentinel, publication, instance };
        acknowledged(status, instance, scenario);
        assert.equal(status.settled, true, "live settlement unobserved");
        if (scenario === "timer-live") {
          assert.equal(status.attempted?.timer, true, "live timer attempt unobserved");
          assert.equal(status.outcomes?.timer, "fulfilled", "live timer must fulfill");
        }
        assert.equal(status.attempted?.kv, true);
        assert.equal(status.attempted?.socket, true);
        assert.equal(status.outcomes?.kv, "fulfilled");
        assert.equal(status.outcomes?.socket, "fulfilled");
        assert.equal(marker, instance, "live background put was lost");
        assert.equal(publication, true, "live background publication was lost");
        if (record.controls[control] !== "fail") record.controls[control] = "pass";
      });
    record.complete = true;
  });
  if (!record.complete) record.failures.push("probe incomplete");
  if (Object.values(record.controls).some((status) => status !== "pass"))
    record.failures.push("controls incomplete or failed");
  if (
    [record.surfaces.asyncKvPut, record.surfaces.webSocketPublish].some(
      (status) => status !== "pass",
    )
  )
    record.failures.push("immediate surfaces incomplete or failed");
  record.probeVerdict = record.failures.length ? "fail" : "pass";
  // This repository-local diagnostic does not establish upstream native audits
  // or enqueue/flush races; full qualification is intentionally still blocked.
  return record;
}
