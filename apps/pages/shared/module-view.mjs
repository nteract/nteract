import { bindingOf, validSourceId } from "./sources.mjs";
import { ESM_MEDIA_TYPE } from "./anywidget-view.mjs";

// A file binding is a ByteSource, independent of its format or decoder.
// Each alias is local to a single view's iframe.
export function compileModuleView(spec) {
  if (
    Object.keys(spec).some((key) => !["module", "files"].includes(key)) ||
    !bindingOf(spec.module)
  )
    return {
      ok: false,
      error: "A module view requires spec.module as a Page source binding and optional spec.files.",
    };
  const files = spec.files === undefined ? {} : spec.files;
  if (!files || typeof files !== "object" || Array.isArray(files) || Object.keys(files).length > 16)
    return { ok: false, error: "files must map at most 16 import names to Page sources." };
  const dependencies = [
    {
      name: "entry",
      role: "module",
      location: "spec.module",
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
      location: "spec.files." + alias,
      source: bindingOf(binding),
    });
  }
  return { ok: true, dependencies };
}
