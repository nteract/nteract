// How an installed release becomes live on the running celld node.
//
// `celld deploy` moves the fleet's deployment pointer. Every node adopts the
// new pointer at its next poll (CELLD_DEPLOY_POLL_S, 30 s by default) without
// restarting. A restart drains the node, and on a one-node fleet a drain is an
// outage. So the installer restarts only when something the process reads at
// startup changed:
//
// - the unit as systemd loads it: the rendered fragment plus every drop-in
//   (`DropInPaths`), and a pending `daemon-reload` (`NeedDaemonReload`),
// - the celld executable,
// - the configured wrangler.json (bindings, migrations, vars).
//
// The firewall helper runs as ExecStartPre and binds its rules to the service
// cgroup, which lives as long as the process. A changed helper is applied
// live instead of restarting.
//
// After the local node serves the release, the installer records what the
// process runs with in /etc/<service>/running.json, keyed by its MainPID and
// start time. The record describes only that process. When the process is a
// different one (a crash restart, a manual restart, an earlier installer) or
// there is no record, the installer observes the process instead: see
// observedFingerprint.

// Schema 2: unit_sha256 covers the fragment and its drop-ins.
export const RUNNING_SCHEMA = 2;
export const RESTART_INPUTS = Object.freeze(["unit", "celld", "config"]);

/**
 * The bytes whose SHA-256 is unit_sha256: the fragment, then each drop-in in
 * path order with its path. systemd applies drop-ins in file-name order, and
 * a renamed drop-in can change that order, so the path is part of the input.
 *
 * @param {string} fragment
 * @param {{path: string, text: string}[]} dropIns
 */
export function unitInput(fragment, dropIns) {
  return [...dropIns]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .reduce((input, { path, text }) => input + "\n\0drop-in " + path + "\n" + text, fragment);
}

/** @param {{unit: string, celld: string, config: string, firewall: string}} hashes */
export function fingerprint({ unit, celld, config, firewall }) {
  for (const value of [unit, celld, config, firewall])
    if (!/^[a-f0-9]{64}$/.test(value ?? "")) throw new Error("Fingerprint inputs are SHA-256");
  return {
    schema: RUNNING_SCHEMA,
    unit_sha256: unit,
    celld_sha256: celld,
    config_sha256: config,
    firewall_sha256: firewall,
  };
}

/** A process is its MainPID and its start second. */
export function runningRecord(desired, current) {
  return { ...desired, pid: current.pid, started_at: current.startedAtSeconds };
}

/** The recorded fingerprint, if the record describes this process. */
export function parseRunning(text, current) {
  try {
    const value = JSON.parse(text);
    return value?.schema === RUNNING_SCHEMA &&
      Number.isSafeInteger(current?.pid) &&
      current.pid > 0 &&
      value.pid === current.pid &&
      value.started_at === current.startedAtSeconds
      ? fingerprint({
          unit: value.unit_sha256,
          celld: value.celld_sha256,
          config: value.config_sha256,
          firewall: value.firewall_sha256,
        })
      : null;
  } catch {
    return null;
  }
}

/**
 * Reconstruct the running fingerprint of a process without a record. Every
 * installer writes its files before it restarts, and systemd reads the unit
 * at start, so a file older than the process start is what the process read.
 * A file written at or after that second is unknown, and unknown restarts.
 * `unit.mtimeMs` is the newest of the fragment and its loaded drop-ins.
 *
 * @param {{
 *   startedAtSeconds: number,
 *   exeSha256: string | null,
 *   unit: {sha256: string, mtimeMs: number} | null,
 *   config: {sha256: string, mtimeMs: number} | null,
 *   firewall: {sha256: string, mtimeMs: number} | null,
 * }} observed
 */
export function observedFingerprint(observed) {
  const startMs = observed.startedAtSeconds * 1000;
  if (!Number.isSafeInteger(observed.startedAtSeconds) || observed.startedAtSeconds <= 0)
    return null;
  const before = (file) => (file && file.mtimeMs < startMs ? file.sha256 : null);
  const unit = before(observed.unit);
  const config = before(observed.config);
  const firewall = before(observed.firewall);
  if (!unit || !config || !firewall || !observed.exeSha256) return null;
  return fingerprint({ unit, celld: observed.exeSha256, config, firewall });
}

/**
 * The activation decision. Pure: the installer gathers the inputs and runs the
 * effects. `reloadPending` is NeedDaemonReload as found before this
 * installation: the loaded definition differed from the files on disk, so the
 * process may not run what the record or the files say. `requested` is
 * `--restart`.
 *
 * @returns {{action: "restart" | "adopt", reasons: string[], applyFirewall: boolean}}
 */
export function planActivation({
  active,
  running,
  desired,
  reloadPending = false,
  requested = false,
}) {
  if (!active) return { action: "restart", reasons: ["inactive"], applyFirewall: false };
  const reasons = [
    ...(requested ? ["requested"] : []),
    ...(running
      ? RESTART_INPUTS.filter((input) => running[input + "_sha256"] !== desired[input + "_sha256"])
      : ["unknown"]),
    ...(reloadPending ? ["reload"] : []),
  ];
  // The restart's ExecStartPre applies the firewall.
  if (reasons.length) return { action: "restart", reasons, applyFirewall: false };
  return {
    action: "adopt",
    reasons: [],
    applyFirewall: running.firewall_sha256 !== desired.firewall_sha256,
  };
}

/**
 * Waiting for something to serve. States: `waiting`, then `serving` or
 * `timed_out`. Each probe is one event: `{at, serving, detail, ...}`; a
 * terminal state keeps the deciding event's other fields.
 */
export function waitTransition(state, event) {
  if (state.phase !== "waiting") return state;
  const { at, serving, ...observed } = event;
  const waitedMs = at - state.startedAt;
  if (serving) return { phase: "serving", waitedMs, ...observed };
  if (waitedMs >= state.timeoutMs) return { phase: "timed_out", waitedMs, ...observed };
  return state;
}

export function awaitServing({ what, probe, sleep, now, timeoutMs, intervalMs }) {
  let state = { phase: "waiting", startedAt: now(), timeoutMs };
  for (;;) {
    state = waitTransition(state, { ...probe(), at: now() });
    if (state.phase === "serving") return state;
    if (state.phase === "timed_out")
      throw new Error(`${what} did not serve within ${timeoutMs} ms; last: ${state.detail}`);
    sleep(intervalMs);
  }
}

/** One local /health response, against the build the manifest wants. */
export function localServing(health, want) {
  if (health.error) return { serving: false, detail: health.error };
  return {
    serving: health.ok === true && health.build === want,
    detail: `ok=${health.ok} build=${health.build ?? "<missing>"}`,
  };
}

/** Node leases (`<prefix>/nodes/*.json`) that are live at `nowMs`. */
export function liveLeases(leases, nowMs) {
  return leases.filter(
    (lease) =>
      typeof lease?.node === "string" &&
      /^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(lease.addr ?? "") &&
      Number.isSafeInteger(lease.expires_ms) &&
      lease.expires_ms > nowMs,
  );
}

/**
 * Whether every live node reports `version` as its deployment
 * (`GET /state` on its internal listener). No live node is not serving.
 *
 * @param {{node: string, addr: string, version: string | null, error?: string}[]} nodes
 */
export function fleetServing(nodes, version) {
  return {
    serving: nodes.length > 0 && nodes.every((node) => node.version === version),
    detail: nodes.length
      ? nodes
          .map(
            ({ node, addr, version: seen, error }) =>
              `${node}@${addr}=${error ?? seen ?? "<none>"}`,
          )
          .join(", ")
      : "no live node lease",
    nodes: nodes.length,
  };
}
