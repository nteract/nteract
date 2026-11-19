import { checkModuleImports, lexModuleImports } from "../shared/module-imports.mjs";
import { standardImports } from "../shared/widget-imports.mjs";
import {
  ESM_MEDIA_TYPE,
  MODULE_MEDIA_TYPE,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_TOTAL_BYTES,
  isExecutableView,
} from "../shared/anywidget-view.mjs";
import { viewDependencies } from "../shared/view-dependencies.mjs";
import { readSource } from "../model/sources-doc.mjs";
import { boundVersion } from "../model/view-doc.mjs";
import { fail } from "../model/view-record.mjs";
import { withTimeout } from "./catalog-index.mjs";

/** How long one write's import check waits on module bytes in total. */
export const MODULE_READ_BUDGET_MS = 5_000;
/** How many module bytes one write's import check reads in total. Lexing is
 * synchronous, so this also bounds the time the check holds the host. */
export const MODULE_CHECK_MAX_BYTES = OUTPUT_MAX_TOTAL_BYTES;

// A refusal's message names at most this many imports; its details hold up
// to UNRESOLVED_DETAILS. A receipt holds at most MAX_WARNINGS of them.
const NAMED = 8;
const UNRESOLVED_DETAILS = 64;
const MAX_WARNINGS = 16;
const MAX_SPECIFIER = 200;

const quoted = (value) => JSON.stringify(String(value).slice(0, MAX_SPECIFIER));

/** At most MAX_WARNINGS of `warnings`, the ones for a module that wasn't
 * checked first: a cut list must never read as a full check. */
function capped(warnings) {
  const rank = ({ code }) => (code === "module_unchecked" ? 0 : code === "module_unparsed" ? 1 : 2);
  return [...warnings].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_WARNINGS);
}

/**
 * A reader of module imports for one write's import check. `get(assetId)`
 * resolves to the asset's stored object (`{ size, text(), body? }`) or null.
 *
 * `read(assetId)` resolves to what lexModuleImports made of the module's
 * text, or to `{ unchecked }` for a module it didn't lex: "unread" when the
 * object is missing, the read fails, or the write's MODULE_READ_BUDGET_MS is
 * spent, and "too_large" when the module is over OUTPUT_MAX_BYTES or would
 * take the write past MODULE_CHECK_MAX_BYTES. It reads each asset once and
 * keeps the import list, never the text.
 */
export function createModuleReader({
  get,
  now = Date.now,
  budgetMs = MODULE_READ_BUDGET_MS,
  maxBytes = MODULE_CHECK_MAX_BYTES,
  onError = () => {},
}) {
  const read = new Map();
  const until = now() + budgetMs;
  let room = maxBytes;
  const one = async (assetId) => {
    const ms = until - now();
    if (typeof get !== "function" || !(ms > 0)) return { unchecked: "unread" };
    try {
      return await withTimeout(
        (async () => {
          const object = await get(assetId);
          if (!object) return { unchecked: "unread" };
          const late = !(until - now() > 0);
          if (late || !(object.size <= OUTPUT_MAX_BYTES && object.size <= room)) {
            // Release the body this check won't read.
            object.body?.cancel?.()?.catch?.(() => {});
            return { unchecked: late ? "unread" : "too_large" };
          }
          room -= object.size;
          const text = await object.text();
          // Text that arrives after the deadline is dropped, not lexed.
          return until - now() > 0 ? lexModuleImports(text) : { unchecked: "unread" };
        })(),
        ms,
        "View module read timed out",
      );
    } catch (error) {
      onError(error);
      return { unchecked: "unread" };
    }
  };
  return (assetId) => {
    if (!read.has(assetId)) read.set(assetId, one(assetId));
    return read.get(assetId);
  };
}

/** The asset id of the version `binding` names. Undefined when the sources
 * document can't answer; the write's binding check owns that refusal. */
function assetOf(sourcesDoc, binding) {
  try {
    return boundVersion(readSource(sourcesDoc, binding.source_id), binding)?.asset_id;
  } catch {
    return undefined;
  }
}

/** How a message names the module an import is in. */
function where(view, label) {
  if (view.media_type !== MODULE_MEDIA_TYPE) return label;
  return label === "entry" ? "the module" : `import ${quoted(label)}`;
}

/** What this view's modules can import. `hostCatalog` is true when the host
 * has a catalog, whether or not this view records one. */
function importable(view, { libraries, imports, files, hostCatalog }) {
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
  const none = libraries.length
    ? ""
    : hostCatalog
      ? " This view records no library catalog, so the host's libraries don't load in it; a view written under a new view_id records one."
      : " This host offers no libraries.";
  return `A view can import ${list}.${none} Relative paths and subpaths the view doesn't name don't load.`;
}

const UNCHECKED = {
  unbound: "its binding names no stored version",
  unread: "its bytes couldn't be read in time",
  too_large: `the modules of one write are checked up to ${MODULE_CHECK_MAX_BYTES / (1024 * 1024)} MiB`,
};

/**
 * The import check of a set_view `op` (as model/view-doc.mjs
 * validateViewOperation returns it) before it is written. `previous` is the
 * stored view, if any; `catalogRevision` the host's catalog, recorded on the
 * write that makes a view executable (model/view-doc.mjs setView), so the
 * view has libraries when it keeps one or this write records one.
 * `readImports` is a createModuleReader reader.
 *
 * A module view with a static import that can't resolve is refused with
 * `invalid_view`, its details listing every one. Otherwise, and for every
 * finding of an anywidget view, returns the warnings the edit carries, each
 * `{ code, view_id, specifier?, in, suggested_action }`. A module the reader
 * didn't lex, or whose binding names no stored version, is a
 * `module_unchecked` warning. The first import warning says what the view
 * can import; the others don't repeat it. The list is `capped`.
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
    readImports,
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
  const unchecked = [];
  const labelled = new Set();
  // One at a time, so the reader holds one module's text at once.
  for (const { source, role, location } of viewDependencies(op)) {
    if (role !== "module" && role !== "import") continue;
    const label = !moduleView
      ? location
      : role === "module"
        ? "entry"
        : location.slice("imports.".length);
    if (labelled.has(label)) continue;
    labelled.add(label);
    const assetId = assetFor(source) ?? assetOf(sourcesDoc, source);
    const lexed = assetId === undefined ? { unchecked: "unbound" } : await readImports(assetId);
    if (lexed.unchecked) unchecked.push({ in: label, reason: lexed.unchecked });
    else modules[label] = lexed;
  }
  const found = checkModuleImports({ modules, libraries, imports, files });
  const allowed = importable(op, { libraries, imports, files, hostCatalog: !!catalogRevision });
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
  let told = false;
  for (const item of found.unresolved) {
    const specifier = String(item.specifier).slice(0, MAX_SPECIFIER);
    const statement =
      item.kind === "static" ? `import ${quoted(specifier)}` : `import(${quoted(specifier)})`;
    warnings.push({
      code: item.kind === "static" ? "unresolved_import" : "unresolved_dynamic_import",
      view_id: op.view_id,
      specifier,
      in: item.in,
      suggested_action: `${statement} in ${where(op, item.in)} can't load in this view's frame, so the view fails when it ${item.kind === "static" ? "loads" : "runs that import"}.${told ? "" : ` ${allowed}`} ${saved}`,
    });
    told = true;
  }
  for (const item of found.unparsed)
    warnings.push({
      code: "module_unparsed",
      view_id: op.view_id,
      in: item.in,
      suggested_action: `Pages couldn't read ${where(op, item.in)} as a JavaScript module (${String(item.message).slice(0, 80)}), so its imports weren't checked. ${saved} Check that the module parses.`,
    });
  for (const item of unchecked)
    warnings.push({
      code: "module_unchecked",
      view_id: op.view_id,
      in: item.in,
      suggested_action: `Pages didn't check the imports of ${where(op, item.in)}: ${UNCHECKED[item.reason]}. ${saved}`,
    });
  return capped(warnings);
}

/**
 * The import warnings a set_source batch gives its edits: for each stored
 * executable view in `views` (model/view-record.mjs readView records) whose
 * module or import follows a source the batch points at new JavaScript, the
 * view's check with the batch's assets, every finding a warning. Returns one
 * list per operation; a view's warnings go on the first operation that
 * changed a module it follows. `mediaTypes` maps each asset the batch names
 * to its stored media type. A view missing from `views` is not checked.
 */
export async function sourceImportWarnings({
  operations,
  mediaTypes,
  views,
  catalogRevision,
  sourcesDoc,
  readImports,
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
      catalogRevision,
      sourcesDoc,
      readImports,
      assetFor: (binding) => follows(binding)?.assetId,
      refuse: false,
      saved: "The source was saved.",
    });
    lists[Math.min(...hits)].push(...warnings);
  }
  return lists.map(capped);
}
