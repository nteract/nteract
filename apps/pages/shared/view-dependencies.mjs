import { ANYWIDGET_MEDIA_TYPE } from "./anywidget-view.mjs";
import { compileAnywidgetSpec } from "./anywidget-spec.mjs";

/** One dependency inventory for admission, reads and renderer subscriptions.
 * Byte-transfer aliases belong to compilation, not the public reference API. */
export function viewDependencies(view) {
  if (view.media_type === ANYWIDGET_MEDIA_TYPE) {
    const compiled = compileAnywidgetSpec(view.spec);
    if (!compiled.ok) throw Error(compiled.error);
    return compiled.dependencies.map(({ source, role, location, mediaType }) => ({
      source,
      role,
      location,
      ...(mediaType && { mediaType }),
    }));
  }
  return Object.entries(view.data).map(([name, source]) => ({
    source,
    role: "dataset",
    location: `data.${name}`,
  }));
}
