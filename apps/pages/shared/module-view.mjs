import { bindingOf, validSourceId } from "./sources.mjs";
import { standardImports } from "./widget-imports.mjs";
import { ESM_MEDIA_TYPE } from "./anywidget-view.mjs";

// A file binding names a Page source, whatever its format. The viewer
// decides how its bytes reach the view (viewer/anywidget-view.mjs dataShape).
// Each alias is local to a single view's iframe.
export function compileModuleView(spec) {
  if (
    Object.keys(spec).some((key) => !["module", "files", "imports"].includes(key)) ||
    !bindingOf(spec.module)
  )
    return {
      ok: false,
      error: "A module view needs a module source binding and optional data and imports.",
    };
  const files = spec.files === undefined ? {} : spec.files;
  if (!files || typeof files !== "object" || Array.isArray(files) || Object.keys(files).length > 16)
    return { ok: false, error: "data must map at most 16 import names to Page sources." };
  const dependencies = [
    {
      name: "entry",
      role: "module",
      location: "module",
      source: bindingOf(spec.module),
      mediaType: ESM_MEDIA_TYPE,
    },
  ];
  for (const [alias, binding] of Object.entries(files)) {
    if (!validSourceId(alias) || !bindingOf(binding))
      return {
        ok: false,
        error: "Each file needs a safe alias and a source_id with optional revision.",
      };
    dependencies.push({
      name: "data/" + alias,
      role: "file",
      location: "data." + alias,
      source: bindingOf(binding),
    });
  }
  const imports = spec.imports === undefined ? {} : spec.imports;
  if (
    !imports ||
    typeof imports !== "object" ||
    Array.isArray(imports) ||
    Object.keys(imports).length > 16
  )
    return { ok: false, error: "imports must map at most 16 names to JavaScript sources." };
  for (const [name, binding] of Object.entries(imports)) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
      name in Object.prototype ||
      standardImports.includes(name) ||
      !bindingOf(binding)
    )
      return {
        ok: false,
        error:
          "Each import needs a unique bare name outside the standard libraries and a source binding.",
      };
    dependencies.push({
      name: "import/" + name,
      role: "import",
      location: "imports." + name,
      source: bindingOf(binding),
      mediaType: ESM_MEDIA_TYPE,
    });
  }
  return { ok: true, dependencies };
}
