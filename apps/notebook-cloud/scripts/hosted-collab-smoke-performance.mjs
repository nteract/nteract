export function summarizeCollabPerformanceTimings(timings = {}) {
  return {
    collab_path: {
      collab_connected_ms: maxNamedTiming(timings, [
        "alice_connected",
        "bob_connected",
        "anonymous_connected",
      ]),
      collab_editor_update_max_ms: maxNamedTiming(timings, [
        "alice_to_bob",
        "alice_to_bob_editor",
        "bob_to_alice",
        "bob_to_alice_editor",
        ...numberedRoundTimingNames(timings, "_alice_exact"),
        ...numberedRoundTimingNames(timings, "_bob_exact"),
      ]),
      collab_anonymous_update_max_ms: maxNamedTiming(timings, [
        "alice_to_anonymous",
        "bob_to_anonymous",
        "overlap_anonymous",
        ...numberedRoundTimingNames(timings, "_anonymous"),
      ]),
      collab_editor_convergence_max_ms: maxNamedTiming(timings, [
        "bob_to_alice_exact",
        "bob_to_bob_exact",
        "overlap_editors_converged",
        ...numberedRoundTimingNames(timings, "_alice_exact"),
        ...numberedRoundTimingNames(timings, "_bob_exact"),
      ]),
      collab_total_ms: numericTiming(timings.total),
    },
  };
}

function maxNamedTiming(timings, names) {
  let max = null;
  for (const name of names) {
    const value = numericTiming(timings[name]);
    if (value === null) {
      continue;
    }
    max = max === null ? value : Math.max(max, value);
  }
  return max;
}

function numberedRoundTimingNames(timings, suffix) {
  return Object.keys(timings).filter(
    (name) => /^(alice|bob)_ping_\d+_/.test(name) && name.endsWith(suffix),
  );
}

function numericTiming(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
