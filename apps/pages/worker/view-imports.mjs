import { checkModuleImports } from "../shared/module-imports.mjs";
import { standardImports } from "../shared/widget-imports.mjs";
import { ESM_MEDIA_TYPE, MODULE_MEDIA_TYPE, isExecutableView } from "../shared/anywidget-view.mjs";
import { viewDependencies } from "../shared/view-dependencies.mjs";
import { readSource } from "../model/sources-doc.mjs";
import { fail } from "../model/view-record.mjs";

// A refusal's message names at most this many imports; its details hold up
// to UNRESOLVED_DETAILS. A receipt holds at most MAX_WARNINGS of them.
const NAMED = 8;
const UNRESOLVED_DETAILS = 64;
const MAX_WARNINGS = 16;
const MAX_SPECIFIER = 200;

const quoted = (value) => JSON.stringify(String(value).slice(0, MAX_SPECIFIER));

/** The asset id of the version `binding` names: its pinned revision, else
 * the source's current version. Undefined when the sources document can't
 * answer; the write's binding check owns that refusal. */
function assetOf(sourcesDoc, binding) {
  try {
    const source = readSource(sourcesDoc, binding.source_id);
    if (binding.revision === undefined) return source.asset_id;
    return source.history.find((state) => state.revision === binding.revision)?.asset_id;
  } catch {
    return undefined;
  }
}

/** How a message names the module an import is in. */
function where(view, label) {
  if (view.media_type !== MODULE_MEDIA_TYPE) return label;
  return label === "entry" ? "the module" : `import ${quoted(label)}`;
}

/** One sentence: what this view's modules can import. */
function importable(view, { libraries, imports, files }) {
  const options = [];
  if (libraries.length) options.push(`one of the host's libraries (${libraries.join(", ")})`);
  if (view.media_type === MODULE_MEDIA_TYPE) {
    options.push(`a name bound under imports${imports.length ? ` (${imports.join(", ")})` : ""}`);
    options.push(
      `data/<alias> for a file bound under data${files.length ? ` (${files.map((alias) => `data/${alias}`).join(", ")})` : ""}`,
    );
  }
  options.push("an https: URL");
  const list =
    options.length === 1
      ? options[0]
      : `${options.slice(0, -1).join(", ")}${options.length > 2 ? "," : ""} or ${options.at(-1)}`;
  return `A view can import ${list}.${libraries.length ? "" : " This host offers no libraries."} Relative paths and subpaths the view doesn't name don't load.`;
}

/**
 * The import check of a set_view `op` (as model/view-doc.mjs
 * validateViewOperation returns it) before it is written. `previous` is the
 * stored view, if any; `catalogRevision` the host's catalog, recorded on the
 * write that makes a view executable (model/view-doc.mjs setView), so the
 * view has libraries when it keeps one or this write records one.
 * `readText(assetId)` resolves to a module's text, or null when its bytes
 * can't be read; such a module is not checked.
 *
 * A module view with a static import that can't resolve is refused with
 * `invalid_view`, its details listing every one. Otherwise, and for every
 * finding of an anywidget view, returns the warnings the edit carries, each
 * `{ code, view_id, specifier?, in, suggested_action }`.
 *
 * A set_source that changes a module a stored view follows checks that
 * view with `refuse` false, so every finding is a warning, and `assetFor`,
 * which names the asset the write gives a binding (undefined for one it
 * leaves as stored). `saved` names what the write saved.
 */
export async function viewImportCheck(
  op,
  {
    previous,
    catalogRevision,
    sourcesDoc,
    readText,
    assetFor = () => undefined,
    refuse = true,
    saved = "The view was saved.",
  },
) {
  if (!isExecutableView(op.media_type)) return [];
  const hasCatalog = isExecutableView(previous?.media_type)
    ? !!previous.catalog_revision
    : !!catalogRevision;
  const libraries = hasCatalog ? [...standardImports] : [];
  const moduleView = op.media_type === MODULE_MEDIA_TYPE;
  const imports = moduleView ? Object.keys(op.spec.imports ?? {}) : [];
  const files = moduleView ? Object.keys(op.spec.files ?? {}) : [];
  const modules = {};
  // Sequential: each module is at most OUTPUT_MAX_BYTES, and a view names
  // at most 17 of them.
  for (const { source, role, location } of viewDependencies(op)) {
    if (role !== "module" && role !== "import") continue;
    const label = !moduleView
      ? location
      : role === "module"
        ? "entry"
        : location.slice("imports.".length);
    if (Object.hasOwn(modules, label)) continue;
    const assetId = assetFor(source) ?? assetOf(sourcesDoc, source);
    const text = assetId === undefined ? null : await readText(assetId);
    if (typeof text === "string") modules[label] = text;
  }
  const found = checkModuleImports({ modules, libraries, imports, files });
  const allowed = importable(op, { libraries, imports, files });
  const statics = found.unresolved.filter(({ kind }) => kind === "static");
  if (refuse && moduleView && statics.length) {
    const named = statics
      .slice(0, NAMED)
      .map((item) => `${quoted(item.specifier)} in ${where(op, item.in)}`);
    if (statics.length > NAMED) named.push(`${statics.length - NAMED} more`);
    fail(
      "invalid_view",
      `This view's imports can't load in its frame: ${named.join(", ")}. ${allowed} Bind JavaScript under imports and import it by that name, or change the import.`,
      {
        view_id: op.view_id,
        unresolved: statics.slice(0, UNRESOLVED_DETAILS).map((item) => ({
          ...item,
          specifier: String(item.specifier).slice(0, MAX_SPECIFIER),
        })),
      },
    );
  }
  const warnings = [];
  for (const item of found.unresolved) {
    const specifier = String(item.specifier).slice(0, MAX_SPECIFIER);
    const statement =
      item.kind === "static" ? `import ${quoted(specifier)}` : `import(${quoted(specifier)})`;
    warnings.push({
      code: item.kind === "static" ? "unresolved_import" : "unresolved_dynamic_import",
      view_id: op.view_id,
      specifier,
      in: item.in,
      suggested_action: `${statement} in ${where(op, item.in)} can't load in this view's frame, so the view fails when it ${item.kind === "static" ? "loads" : "runs that import"}. ${allowed} ${saved}`,
    });
  }
  for (const item of found.unparsed)
    warnings.push({
      code: "module_unparsed",
      view_id: op.view_id,
      in: item.in,
      suggested_action: `Pages couldn't read ${where(op, item.in)} as a JavaScript module (${String(item.message).slice(0, 80)}), so its imports weren't checked. ${saved} Check that the module parses.`,
    });
  return warnings.slice(0, MAX_WARNINGS);
}

/**
 * The import warnings a set_source batch gives its edits: for each stored
 * executable view in `views` (model/view-record.mjs readView records) whose
 * module or import follows a source the batch points at new JavaScript, the
 * view's check with the batch's assets, every finding a warning. Returns one
 * list per operation; a view's warnings go on the first operation that
 * changed a module it follows. `mediaTypes` maps each asset the batch names
 * to its stored media type.
 */
export async function sourceImportWarnings({
  operations,
  mediaTypes,
  views,
  sourcesDoc,
  readText,
}) {
  const lists = operations.map(() => []);
  const changed = new Map();
  operations.forEach((op, index) => {
    if (op?.op === "set_source" && mediaTypes.get(op.asset_id) === ESM_MEDIA_TYPE)
      changed.set(op.source_id, { assetId: op.asset_id, index });
  });
  if (!changed.size) return lists;
  const follows = (binding) => binding.revision === undefined && changed.get(binding.source_id);
  for (const view of views) {
    if (!view || !isExecutableView(view.media_type)) continue;
    let dependencies;
    try {
      dependencies = viewDependencies(view);
    } catch {
      continue;
    }
    const hits = dependencies
      .filter(({ role, source }) => (role === "module" || role === "import") && follows(source))
      .map(({ source }) => follows(source).index);
    if (!hits.length) continue;
    const warnings = await viewImportCheck(view, {
      previous: view,
      sourcesDoc,
      readText,
      assetFor: (binding) => follows(binding)?.assetId,
      refuse: false,
      saved: "The source was saved; the view fails until the import resolves.",
    });
    lists[Math.min(...hits)].push(...warnings);
  }
  return lists.map((list) => list.slice(0, MAX_WARNINGS));
}
