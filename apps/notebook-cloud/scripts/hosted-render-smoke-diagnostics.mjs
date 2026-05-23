const FATAL_ISOLATED_DIAGNOSTIC_PHASES = new Set([
  "renderer-plugin-install-failed",
  "rendered-empty-after-paint",
]);

export function parseIsolatedDiagnosticText(text) {
  const match = text.match(/^\[(isolated-frame|isolated-renderer|iframe-libraries)\]\s+(\S+)/);
  if (!match) {
    return null;
  }
  return {
    source: match[1],
    phase: match[2],
  };
}

export function consoleMessageLevel(type) {
  if (type === "error") {
    return "error";
  }
  if (type === "warning") {
    return "warn";
  }
  if (type === "info") {
    return "info";
  }
  return "debug";
}

export function isFatalIsolatedDiagnostic(diagnostic) {
  return diagnostic.level === "error" || FATAL_ISOLATED_DIAGNOSTIC_PHASES.has(diagnostic.phase);
}

export function isolatedDiagnosticFailure(diagnostic) {
  const message =
    typeof diagnostic.details?.message === "string" ? diagnostic.details.message : diagnostic.text;
  return {
    kind: "isolated-diagnostic",
    source: diagnostic.source,
    phase: diagnostic.phase,
    level: diagnostic.level,
    text: message,
    details: diagnostic.details ?? null,
  };
}
