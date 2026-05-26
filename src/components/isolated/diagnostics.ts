export type IsolatedDiagnosticLevel = "debug" | "info" | "warn" | "error";

export type IsolatedDiagnosticSource = "isolated-frame" | "isolated-renderer" | "iframe-libraries";

export interface IsolatedDiagnosticEvent {
  source: IsolatedDiagnosticSource;
  phase: string;
  level?: IsolatedDiagnosticLevel;
  details?: Record<string, unknown>;
}

export type IsolatedDiagnosticHandler = (
  phase: string,
  details?: Record<string, unknown>,
  level?: IsolatedDiagnosticLevel,
  source?: IsolatedDiagnosticSource,
) => void;

export const ISOLATED_DIAGNOSTICS_STORAGE_KEY = "notebook-isolated-diagnostics";

export function isolatedDebugDiagnosticsEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const value = window.localStorage?.getItem(ISOLATED_DIAGNOSTICS_STORAGE_KEY)?.toLowerCase();
    return value === "1" || value === "true" || value === "debug" || value === "verbose";
  } catch {
    return false;
  }
}

export function shouldLogIsolatedDiagnostic(level: IsolatedDiagnosticLevel = "debug"): boolean {
  return level !== "debug" || isolatedDebugDiagnosticsEnabled();
}

export function logIsolatedDiagnostic(event: IsolatedDiagnosticEvent): void {
  const { source, phase, level = "debug", details = {} } = event;
  if (!shouldLogIsolatedDiagnostic(level)) {
    return;
  }

  const logger = console[level] ?? console.debug;
  logger(`[${source}] ${phase}`, details);
}

export function rendererBundleDetails(
  rendererCode: string | undefined,
  rendererCss: string | undefined,
): Record<string, unknown> {
  return {
    hasRendererCode: rendererCode !== undefined,
    hasRendererCss: rendererCss !== undefined,
    rendererCodeLength: rendererCode?.length ?? 0,
    rendererCssLength: rendererCss?.length ?? 0,
  };
}
