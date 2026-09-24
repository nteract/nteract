import type { NotebookResponse } from "runtimed";

/**
 * Add a pyodide package and hot-install it, rolling the declaration back when
 * the install fails.
 *
 * The packages panel writes the requirement into
 * `metadata.runt.execution.dependencies` *before* the interpreter installs it,
 * and that list is what every later kernel start installs via `RUNT_PYODIDE_DEPS`.
 * A requirement micropip cannot resolve (a typo, or a package with no pyodide
 * wheel) would therefore be retried on every restart and break environment
 * startup, so a failed install removes the entry again.
 *
 * A requirement that was already declared before this call is never removed: a
 * failed re-add must not delete a dependency the user still wants.
 */
export interface AddPyodidePackageOptions {
  /** Requirement the user asked to add (already trimmed by the panel). */
  pkg: string;
  /** Declared dependencies as of before the add. */
  declaredBefore: readonly string[];
  /** Writes the requirement to `runt.execution.dependencies`. */
  addDependency: (pkg: string) => Promise<void>;
  /** Removes the requirement from `runt.execution.dependencies`. */
  removeDependency: (pkg: string) => Promise<void>;
  /** Runs the hot-install sync request. */
  syncEnvironment: () => Promise<NotebookResponse>;
  /** Called with the failure message when the install fails. */
  onFailure?: (error: string) => void;
}

export interface AddPyodidePackageResult {
  /** True when the failed requirement was removed again. */
  rolledBack: boolean;
  /** Error from a rollback that itself failed, if any. */
  rollbackError?: unknown;
}

export async function addPyodidePackageWithRollback({
  pkg,
  declaredBefore,
  addDependency,
  removeDependency,
  syncEnvironment,
  onFailure,
}: AddPyodidePackageOptions): Promise<AddPyodidePackageResult> {
  const wasDeclared = declaredBefore.includes(pkg);
  await addDependency(pkg);

  const response = await syncEnvironment();
  if (response.result !== "sync_environment_failed") {
    return { rolledBack: false };
  }

  onFailure?.(response.error);
  if (wasDeclared) {
    return { rolledBack: false };
  }

  try {
    await removeDependency(pkg);
    return { rolledBack: true };
  } catch (rollbackError) {
    return { rolledBack: false, rollbackError };
  }
}
