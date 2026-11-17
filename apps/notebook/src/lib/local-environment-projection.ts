/**
 * Projections of daemon-authored kernel facts for the Environment area.
 * Pure: the daemon owns the facts, the selector only renders them.
 */

export type BorrowedEnvironmentKind = "conda" | "kernelspec";

/**
 * A borrowed environment is executed as it is: nteract neither installs
 * notebook declarations into it nor syncs packages. `null` means managed.
 */
export function borrowedEnvironmentKind(
  envSource: string | null | undefined,
): BorrowedEnvironmentKind | null {
  if (envSource === "conda:existing:local") return "conda";
  if (envSource === "kernelspec") return "kernelspec";
  return null;
}

export interface RunningEnvironmentFacts {
  lifecycle: string;
  envSource: string | null | undefined;
  environmentId: string | null | undefined;
  environmentName: string | null | undefined;
  pythonVersion: string | null | undefined;
  language: string | null | undefined;
}

export interface RunningEnvironment {
  id: string | null;
  name: string;
  pythonVersion: string | null;
  language: string | null;
}

/**
 * The environment of a kernel that is running now. Any other lifecycle,
 * including a launch in progress, yields `null` so the selector never names an
 * environment the kernel has not reached.
 */
export function projectRunningEnvironment(
  facts: RunningEnvironmentFacts,
): RunningEnvironment | null {
  if (facts.lifecycle !== "Running") return null;
  const installedKernel = borrowedEnvironmentKind(facts.envSource) === "kernelspec";
  return {
    id: facts.environmentId || null,
    name:
      facts.environmentName ||
      (installedKernel ? "Jupyter kernel" : facts.envSource || "Automatic environment"),
    pythonVersion: facts.pythonVersion || null,
    // Language identifies an installed kernel; managed environments show Python facts.
    language: installedKernel ? facts.language || null : null,
  };
}
