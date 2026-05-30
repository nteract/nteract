const PREFLIGHT_FAILURE_KINDS = new Set(["catalog-api", "viewer-css"]);

export function hasPreflightFailures(failures) {
  return (
    Array.isArray(failures) &&
    failures.some((failure) => PREFLIGHT_FAILURE_KINDS.has(failure?.kind))
  );
}
