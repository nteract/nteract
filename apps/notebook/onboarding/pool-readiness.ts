import type { PoolState, RuntimePoolState } from "runtimed";

export type PythonEnv = keyof PoolState;

export function isOnboardingPoolReady(pythonEnv: PythonEnv, state: PoolState): boolean {
  const selected = state[pythonEnv];

  if (selected.pool_size === 0) {
    return true;
  }

  return selected.available > 0;
}

/**
 * A pool has surfaced a real failure the user should see (rather than a
 * transient "still warming"). True when the daemon recorded at least one
 * warm-env failure and no environment is available yet.
 */
export function hasOnboardingPoolError(pythonEnv: PythonEnv, state: PoolState): boolean {
  const selected = state[pythonEnv];
  if (isOnboardingPoolReady(pythonEnv, state)) return false;
  return selected.consecutive_failures > 0 && Boolean(selected.error);
}

/**
 * Build a user-facing message from a failed pool's error fields.
 */
export function onboardingPoolErrorMessage(envLabel: string, selected: RuntimePoolState): string {
  if (selected.error_kind === "invalid_package" && selected.failed_package) {
    return `${envLabel} setup failed: package "${selected.failed_package}" could not be installed.`;
  }
  if (selected.error_kind === "timeout") {
    return `${envLabel} setup timed out. This can happen on a slow network — it will keep retrying in the background.`;
  }
  const detail = selected.error?.trim();
  return detail
    ? `${envLabel} setup failed: ${detail}`
    : `${envLabel} setup failed. It will keep retrying in the background.`;
}
