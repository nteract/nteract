const RUNTIMED_WASM_MODULE_NAME = "runtimed_wasm.js";
const RUNTIMED_WASM_BINARY_NAME = "runtimed_wasm_bg.wasm";

export function checkRuntimeWasmHints(hints, options = {}) {
  const expectedRendererAssetOrigin = options.expectedRendererAssetOrigin ?? "";
  const requireHints = options.requireHints ?? true;
  const failures = [];
  const modulepreload = hints.find(
    (hint) =>
      relIncludes(hint.rel, "modulepreload") && hint.href.includes(RUNTIMED_WASM_MODULE_NAME),
  );
  const wasmPreload = hints.find(
    (hint) => relIncludes(hint.rel, "preload") && hint.href.includes(RUNTIMED_WASM_BINARY_NAME),
  );

  if (requireHints && !modulepreload) {
    failures.push({
      kind: "runtimed-wasm-hint",
      text: `Missing ${RUNTIMED_WASM_MODULE_NAME} modulepreload hint`,
    });
  }
  if (requireHints && !wasmPreload) {
    failures.push({
      kind: "runtimed-wasm-hint",
      text: `Missing ${RUNTIMED_WASM_BINARY_NAME} preload hint`,
    });
  }

  if (modulepreload) {
    assertCrossOrigin(modulepreload, failures, `${RUNTIMED_WASM_MODULE_NAME} modulepreload`);
    assertExpectedOrigin(
      modulepreload,
      expectedRendererAssetOrigin,
      failures,
      `${RUNTIMED_WASM_MODULE_NAME} modulepreload`,
    );
  }
  if (wasmPreload) {
    if (wasmPreload.as !== "fetch") {
      failures.push({
        kind: "runtimed-wasm-hint",
        text: `${RUNTIMED_WASM_BINARY_NAME} preload used as=${JSON.stringify(wasmPreload.as)}`,
      });
    }
    if (wasmPreload.type !== "application/wasm") {
      failures.push({
        kind: "runtimed-wasm-hint",
        text: `${RUNTIMED_WASM_BINARY_NAME} preload used type=${JSON.stringify(wasmPreload.type)}`,
      });
    }
    assertCrossOrigin(wasmPreload, failures, `${RUNTIMED_WASM_BINARY_NAME} preload`);
    assertExpectedOrigin(
      wasmPreload,
      expectedRendererAssetOrigin,
      failures,
      `${RUNTIMED_WASM_BINARY_NAME} preload`,
    );
  }

  return {
    ok: failures.length === 0,
    modulepreload: modulepreload ?? null,
    wasmPreload: wasmPreload ?? null,
    runtimedWasmHints: hints.filter((hint) => hint.href.includes("runtimed_wasm")),
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
