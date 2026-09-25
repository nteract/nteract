import type { ManagedPythonPackagesProps } from "@/components/environment/ManagedPythonPackages";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Projection only: installed observations can never promote themselves into requirements. */
export function projectCloudPackages(
  metadata: unknown,
  progress: unknown,
  sessionId: string | null,
  ready: boolean,
  includedDefaults: readonly string[] = [],
): Pick<
  ManagedPythonPackagesProps,
  "requirements" | "installed" | "included" | "phase" | "error" | "needsRestart" | "progressMessage"
> {
  const manifest = record(record(record(metadata).runt).pyodide);
  const state = record(record(progress).managed_packages);
  const current = sessionId !== null && state.session_id === sessionId;
  const phase =
    current && ["ready", "installing", "restoring", "error"].includes(String(state.phase))
      ? (state.phase as ManagedPythonPackagesProps["phase"])
      : "unavailable";
  return {
    requirements: strings(manifest.requirements),
    installed: current && ready ? strings(state.installed) : [],
    included:
      current && ready && strings(state.included).length
        ? strings(state.included)
        : includedDefaults,
    phase: ready ? phase : "unavailable",
    progressMessage:
      current && ready && typeof record(progress).message === "string"
        ? (record(progress).message as string)
        : null,
    error: current && typeof state.error === "string" ? state.error : null,
    needsRestart: current && state.needs_restart === true,
  };
}
