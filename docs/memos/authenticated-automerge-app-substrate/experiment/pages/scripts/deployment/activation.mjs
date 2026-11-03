// How an installed release becomes live on the running celld node.
//
// `celld deploy` moves the fleet's deployment pointer. Every node adopts the
// new pointer at its next poll (CELLD_DEPLOY_POLL_S, 30 s by default) without
// restarting. A restart drains the node, and on a one-node fleet a drain is an
// outage. So the installer restarts only when something the process reads at
// startup changed:
//
// - the rendered unit file (flags, environment, limits),
// - the celld executable,
// - the configured wrangler.json (bindings, migrations, vars).
//
// The firewall helper runs as ExecStartPre and binds its rules to the service
// cgroup, which lives as long as the process. A changed helper is applied
// live instead of restarting.
//
// After the node serves the release, the installer records what the process
// runs with in /etc/<service>/running.json, keyed by its MainPID and start
// time. The record describes only that process. When the process is a
// different one (a crash restart, a manual restart, an earlier installer) or
// there is no record, the installer observes the process instead: see
// observedFingerprint.

export const RUNNING_SCHEMA = 1;
export const RESTART_INPUTS = Object.freeze(["unit", "celld", "config"]);

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
 *
 * @param {{
 *   startedAtSeconds: number,
 *   exeSha256: string | null,
 *   needDaemonReload: boolean,
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
  const unit = observed.needDaemonReload ? null : before(observed.unit);
  const config = before(observed.config);
  const firewall = before(observed.firewall);
  if (!unit || !config || !firewall || !observed.exeSha256) return null;
  return fingerprint({ unit, celld: observed.exeSha256, config, firewall });
}

/**
 * The activation decision. Pure: the installer gathers the inputs and runs the
 * effects.
 *
 * @returns {{action: "restart" | "adopt", reasons: string[], applyFirewall: boolean}}
 */
export function planActivation({ active, running, desired }) {
  if (!active) return { action: "restart", reasons: ["inactive"], applyFirewall: false };
  if (!running) return { action: "restart", reasons: ["unknown"], applyFirewall: false };
  const reasons = RESTART_INPUTS.filter(
    (input) => running[input + "_sha256"] !== desired[input + "_sha256"],
  );
  if (reasons.length) return { action: "restart", reasons, applyFirewall: false };
  return {
    action: "adopt",
    reasons: [],
    applyFirewall: running.firewall_sha256 !== desired.firewall_sha256,
  };
}

/**
 * Waiting for the node to serve the new build. States: `waiting`, then
 * `serving` or `timed_out`. Each health probe is one event.
 *
 * @param {{phase: "waiting", startedAt: number, timeoutMs: number, want: string}} state
 * @param {{at: number, health: {ok: boolean, build?: string, error?: string}}} event
 */
export function waitTransition(state, event) {
  if (state.phase !== "waiting") return state;
  const waitedMs = event.at - state.startedAt;
  if (event.health.ok && event.health.build === state.want)
    return { phase: "serving", waitedMs, health: event.health };
  if (waitedMs >= state.timeoutMs) return { phase: "timed_out", waitedMs, health: event.health };
  return state;
}

export function awaitBuild({ want, probe, sleep, now, timeoutMs, intervalMs }) {
  let state = { phase: "waiting", startedAt: now(), timeoutMs, want };
  for (;;) {
    state = waitTransition(state, { health: probe(), at: now() });
    if (state.phase === "serving") return state;
    if (state.phase === "timed_out")
      throw new Error(
        `Node did not serve build ${want} within ${timeoutMs} ms; last health: ` +
          (state.health.error ??
            `ok=${state.health.ok} build=${state.health.build ?? "<missing>"}`),
      );
    sleep(intervalMs);
  }
}
