export type PythonEnv = "uv" | "conda" | "pixi";

export type OnboardingPoolRuntimeState = {
  available?: number;
  warming?: number;
  pool_size?: number;
  /** Human-readable error message from the daemon (absent if healthy). */
  error?: string;
  /** Package that failed to install, when the daemon could identify one. */
  failed_package?: string;
  /** Error classification: "timeout" | "invalid_package" | "import_error" | "setup_failed". */
  error_kind?: string;
  /** Consecutive warm-env failures (0 if healthy). */
  consecutive_failures?: number;
  /** Seconds until the daemon retries warming (0 if imminent or healthy). */
  retry_in_secs?: number;
};

export type OnboardingPoolState = Partial<Record<PythonEnv, OnboardingPoolRuntimeState>>;

export function isOnboardingPoolReady(pythonEnv: PythonEnv, state: OnboardingPoolState): boolean {
  const selected = state[pythonEnv];
  if (!selected) return false;

  if ((selected.pool_size ?? 1) === 0) {
    return true;
  }

  return (selected.available ?? 0) > 0;
}

/**
 * A pool has surfaced a real failure the user should see (rather than a
 * transient "still warming"). True when the daemon recorded at least one
 * warm-env failure and no environment is available yet.
 */
export function hasOnboardingPoolError(pythonEnv: PythonEnv, state: OnboardingPoolState): boolean {
  const selected = state[pythonEnv];
  if (!selected) return false;
  if (isOnboardingPoolReady(pythonEnv, state)) return false;
  return (selected.consecutive_failures ?? 0) > 0 && Boolean(selected.error);
}

/**
 * Build a user-facing message from a failed pool's error fields.
 */
export function onboardingPoolErrorMessage(
  envLabel: string,
  selected: OnboardingPoolRuntimeState,
): string {
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
