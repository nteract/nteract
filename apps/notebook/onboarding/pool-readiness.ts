export type PythonEnv = "uv" | "conda" | "pixi";

export type OnboardingPoolRuntimeState = {
  available?: number;
  warming?: number;
  pool_size?: number;
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
