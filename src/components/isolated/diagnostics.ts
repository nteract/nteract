export type IsolatedDiagnosticLevel = "debug" | "info" | "warn" | "error";

export type IsolatedDiagnosticSource = "isolated-frame" | "isolated-renderer" | "iframe-libraries";

export interface IsolatedDiagnosticEvent {
  source: IsolatedDiagnosticSource;
  phase: string;
  level?: IsolatedDiagnosticLevel;
  details?: Record<string, unknown>;
}

export function logIsolatedDiagnostic(event: IsolatedDiagnosticEvent): void {
  const { source, phase, level = "debug", details = {} } = event;
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
