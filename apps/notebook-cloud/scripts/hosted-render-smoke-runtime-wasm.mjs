const RUNTIMED_WASM_MODULE_NAME = "runtimed_wasm.js";
const RUNTIMED_WASM_BINARY_NAME = "runtimed_wasm_bg.wasm";
const RUNTIMED_WASM_MODULE_FILENAME = /^runtimed_wasm(?:\.[a-f0-9]{12,64})?\.js$/;
const RUNTIMED_WASM_BINARY_FILENAME = /^runtimed_wasm_bg(?:\.[a-f0-9]{12,64})?\.wasm$/;

export function checkRuntimeWasmHints(hints, options = {}) {
  const expectedRuntimeWasmOrigin =
    options.expectedRuntimeWasmOrigin ?? options.expectedRendererAssetOrigin ?? "";
  const requireHints = options.requireHints ?? true;
  const failures = [];
  const modulepreload = hints.find(
    (hint) =>
      relIncludes(hint.rel, "modulepreload") &&
      matchesRuntimeWasmFilename(hint.href, RUNTIMED_WASM_MODULE_FILENAME),
  );
  const wasmPrefetch = hints.find(
    (hint) =>
      relIncludes(hint.rel, "prefetch") &&
      matchesRuntimeWasmFilename(hint.href, RUNTIMED_WASM_BINARY_FILENAME),
  );

  if (requireHints && !modulepreload) {
    failures.push({
      kind: "runtimed-wasm-hint",
      text: `Missing ${RUNTIMED_WASM_MODULE_NAME} modulepreload hint`,
    });
  }
  if (requireHints && !wasmPrefetch) {
    failures.push({
      kind: "runtimed-wasm-hint",
      text: `Missing ${RUNTIMED_WASM_BINARY_NAME} prefetch hint`,
    });
  }

  if (modulepreload) {
    assertCrossOrigin(modulepreload, failures, `${RUNTIMED_WASM_MODULE_NAME} modulepreload`);
    assertExpectedOrigin(
      modulepreload,
      expectedRuntimeWasmOrigin,
      failures,
      `${RUNTIMED_WASM_MODULE_NAME} modulepreload`,
    );
  }
  if (wasmPrefetch) {
    if (wasmPrefetch.as !== "fetch") {
      failures.push({
        kind: "runtimed-wasm-hint",
        text: `${RUNTIMED_WASM_BINARY_NAME} prefetch used as=${JSON.stringify(wasmPrefetch.as)}`,
      });
    }
    if (wasmPrefetch.type !== "application/wasm") {
      failures.push({
        kind: "runtimed-wasm-hint",
        text: `${RUNTIMED_WASM_BINARY_NAME} prefetch used type=${JSON.stringify(wasmPrefetch.type)}`,
      });
    }
    assertCrossOrigin(wasmPrefetch, failures, `${RUNTIMED_WASM_BINARY_NAME} prefetch`);
    assertExpectedOrigin(
      wasmPrefetch,
      expectedRuntimeWasmOrigin,
      failures,
      `${RUNTIMED_WASM_BINARY_NAME} prefetch`,
    );
  }

  return {
    ok: failures.length === 0,
    modulepreload: modulepreload ?? null,
    wasmPrefetch: wasmPrefetch ?? null,
    runtimedWasmHints: hints.filter((hint) => isRuntimeWasmAssetHref(hint.href)),
    failures,
  };
}

function relIncludes(rel, expected) {
  return rel
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(expected);
}

function assertCrossOrigin(hint, failures, label) {
  if (!hint.crossorigin && hint.crossOrigin !== "" && hint.crossOrigin !== "anonymous") {
    failures.push({
      kind: "runtimed-wasm-hint",
      text: `${label} did not declare crossorigin`,
    });
  }
}

function assertExpectedOrigin(hint, expectedRendererAssetOrigin, failures, label) {
  if (!expectedRendererAssetOrigin) {
    return;
  }
  if (!hint.href.startsWith(expectedRendererAssetOrigin)) {
    failures.push({
      kind: "runtimed-wasm-hint-origin",
      text: `${label} did not point at ${expectedRendererAssetOrigin}`,
      href: hint.href,
    });
  }
}

function isRuntimeWasmAssetHref(href) {
  return (
    matchesRuntimeWasmFilename(href, RUNTIMED_WASM_MODULE_FILENAME) ||
    matchesRuntimeWasmFilename(href, RUNTIMED_WASM_BINARY_FILENAME)
  );
}

function matchesRuntimeWasmFilename(href, pattern) {
  try {
    const pathname = new URL(href).pathname;
    return pattern.test(pathname.split("/").pop() ?? "");
  } catch {
    return pattern.test(href.split(/[?#]/)[0].split("/").pop() ?? "");
  }
}
