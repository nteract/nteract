import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "../lib/logger";
import {
  addExecutionDependency,
  removeExecutionDependency,
  useExecutionDependencies,
} from "../lib/notebook-metadata";
import { useRuntimeState } from "../lib/runtime-state";

/**
 * Pyodide (micropip) dependency management for the packages panel.
 *
 * These are *declared* dependencies stored at `metadata.runt.execution.dependencies`.
 * The pyodide sandbox installs them via micropip at interpreter startup —
 * nothing installs them until then.
 */
export function usePyodideDependencies() {
  const [loading, setLoading] = useState(false);
  const executionDeps = useExecutionDependencies();
  const runtimeState = useRuntimeState();
  const runtimeInstalled = runtimeState.env.runtime_installed ?? [];
  const declared = executionDeps?.dependencies ?? [];
  const promotingRef = useRef(false);

  // Promote packages a cell installed at runtime into durable notebook
  // metadata. The runtime peer records them in RuntimeStateDoc
  // `env.runtime_installed` because it cannot author NotebookDoc; the frontend
  // owns notebook metadata, so it merges new entries in (deduplicated by exact
  // requirement string) which makes them reinstall on the next restart.
  useEffect(() => {
    if (promotingRef.current) return;
    const pending = runtimeInstalled.filter((pkg) => !declared.includes(pkg));
    if (pending.length === 0) return;
    promotingRef.current = true;
    void (async () => {
      try {
        for (const pkg of pending) {
          await addExecutionDependency(pkg);
        }
      } catch (e) {
        logger.error("Failed to promote runtime-installed pyodide packages:", e);
      } finally {
        promotingRef.current = false;
      }
    })();
  }, [runtimeInstalled, declared]);

  const addDependency = useCallback(async (pkg: string) => {
    if (!pkg.trim()) return;
    setLoading(true);
    try {
      await addExecutionDependency(pkg.trim());
    } catch (e) {
      logger.error("Failed to add pyodide dependency:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const removeDependency = useCallback(async (pkg: string) => {
    setLoading(true);
    try {
      await removeExecutionDependency(pkg);
    } catch (e) {
      logger.error("Failed to remove pyodide dependency:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    dependencies: executionDeps?.dependencies ?? [],
    profile: executionDeps?.profile ?? null,
    loading,
    addDependency,
    removeDependency,
  };
}
