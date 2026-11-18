import { validSourceId, SOURCE_REVISION_PATTERN } from "./sources.mjs";
const revisionPattern = new RegExp(SOURCE_REVISION_PATTERN);
export const WIDGET_IMPORTS = "widget-imports";
export const standardImports = Object.freeze([
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "d3",
  "@observablehq/plot",
]);
export const catalogDigest = /^[a-f0-9]{64}$/;
export function localCatalogRevision(env = {}) {
  return catalogDigest.test(env.PAGES_WIDGET_CATALOG_REVISION) &&
    URL.canParse(env.PAGES_OUTPUT_FRAME_URL) &&
    new URL(env.PAGES_OUTPUT_FRAME_URL).hostname === "127.0.0.1"
    ? env.PAGES_WIDGET_CATALOG_REVISION
    : null;
}

export function checkedModules(modules, reserved = standardImports) {
  if (!Array.isArray(modules) || modules.length > 16)
    throw Error("Provide at most 16 Page modules.");
  const names = new Set();
  for (const module of modules) {
    if (
      !module ||
      typeof module.name !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(module.name) ||
      reserved.includes(module.name) ||
      module.name in Object.prototype ||
      names.has(module.name)
    )
      throw Error("Each Page module needs a unique bare name outside the standard catalog.");
    if (
      !validSourceId(module.source_id) ||
      typeof module.revision !== "string" ||
      !revisionPattern.test(module.revision)
    )
      throw Error("Each Page module needs a source_id and a pinned source revision.");
    names.add(module.name);
  }
  return modules;
}

export function decodeWidgetImports(bytes, assetId) {
  if (bytes.byteLength > 16384) throw Error("Widget imports declaration exceeds 16 KiB.");
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (data.catalog === "standard" && catalogDigest.test(data.catalog_revision)) {
    const imports = data.imports ?? standardImports;
    if (
      !Array.isArray(imports) ||
      imports.length > 32 ||
      !imports.every((name) => typeof name === "string" && /^[a-z@][a-z0-9@/-]{0,79}$/.test(name))
    )
      throw Error("Invalid catalog imports.");
    const modules = checkedModules(data.modules, imports);
    if (!modules.every((m) => catalogDigest.test(m.asset_id))) throw Error("Invalid module asset.");
    return { catalog: "standard", catalog_revision: data.catalog_revision, imports, modules };
  }
  // Original local prototype stored the catalog manifest itself as the source.
  if (
    !data.files ||
    !data.imports ||
    Array.isArray(data.imports) ||
    typeof data.imports !== "object"
  )
    throw Error("Invalid widget imports declaration.");
  return {
    catalog: "legacy",
    catalog_revision: assetId,
    imports: Object.keys(data.imports),
    modules: [],
  };
}
