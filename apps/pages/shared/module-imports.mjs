// The JS build of the lexer: no WebAssembly and no async init, so it runs in
// a Worker and in celld, which refuse to compile WebAssembly from bytes.
import { parse } from "es-module-lexer/js";

// es-module-lexer's import types. 3 is `import.meta`, which loads nothing.
const STATIC = new Set([1, 4, 6]); // `import`/`export … from`, source phase, defer
const DYNAMIC = new Set([2, 5, 7]); // `import(…)`, `import.source(…)`, `import.defer(…)`

/** True for an absolute `https:` URL, which a view loads from the network. */
function isHttps(specifier) {
  try {
    return new URL(specifier).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The imports of one module's text, in source order with repeats dropped:
 * `{ imports: [{ specifier, kind }] }`, `kind` "static" or "dynamic", or
 * `{ unparsed: message }` when the lexer can't read the text. A dynamic
 * import whose argument isn't a string literal names nothing and is left out.
 */
export function lexModuleImports(text) {
  let found;
  try {
    [found] = parse(String(text));
  } catch (error) {
    return { unparsed: String(error?.message ?? error) };
  }
  const imports = [];
  const seen = new Set();
  for (const { t: type, n: specifier } of found) {
    const kind = STATIC.has(type) ? "static" : DYNAMIC.has(type) ? "dynamic" : null;
    if (!kind || typeof specifier !== "string") continue;
    const key = `${kind} ${specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    imports.push({ specifier, kind });
  }
  return { imports };
}

/**
 * Every import in a view's modules that its frame's import map can't
 * resolve. `modules` maps a label (`"entry"`, an import name, or a widget
 * module's location) to its source text or to what lexModuleImports made of
 * it; `libraries` are the catalog names the view can use (none without a
 * catalog); `imports` are the view's own import names; `files` its data
 * aliases, each imported as `data/<alias>`.
 *
 * A specifier resolves when it is exactly a library, exactly one of the
 * view's imports, exactly `data/<alias>` for one of its files, or an absolute
 * `https:` URL. Import maps match exact keys, and the entry runs from a blob
 * URL, so a subpath the map doesn't list and every relative path fail in the
 * reader's browser.
 *
 * Returns `{ unresolved: [{ specifier, in, kind }], external: [{ specifier,
 * in }], unparsed: [{ in, message }] }`. Each list follows the modules in
 * label order with `"entry"` first, then source order within a module, with
 * repeats dropped.
 */
export function checkModuleImports({ modules, libraries = [], imports = [], files = [] }) {
  const known = new Set([...libraries, ...imports, ...files.map((alias) => `data/${alias}`)]);
  const labels = Object.keys(modules).sort((a, b) =>
    a === b ? 0 : a === "entry" ? -1 : b === "entry" ? 1 : a < b ? -1 : 1,
  );
  const unresolved = [],
    external = [],
    unparsed = [];
  for (const label of labels) {
    const lexed =
      typeof modules[label] === "string" ? lexModuleImports(modules[label]) : modules[label];
    if (lexed.unparsed !== undefined) {
      unparsed.push({ in: label, message: lexed.unparsed });
      continue;
    }
    const externals = new Set();
    for (const { specifier, kind } of lexed.imports) {
      if (!isHttps(specifier)) {
        if (!known.has(specifier)) unresolved.push({ specifier, in: label, kind });
      } else if (!externals.has(specifier)) {
        externals.add(specifier);
        external.push({ specifier, in: label });
      }
    }
  }
  return { unresolved, external, unparsed };
}
