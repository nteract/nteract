import { compileModuleView } from "./module-view.mjs";
import { ANYWIDGET_MEDIA_TYPE, MODULE_MEDIA_TYPE } from "./anywidget-view.mjs";
import { compileAnywidgetSpec } from "./anywidget-spec.mjs";

/** One dependency inventory for admission, reads and renderer subscriptions.
 * Byte-transfer aliases belong to compilation, not the public reference API. */
export function viewDependencies(view) {
  if ([ANYWIDGET_MEDIA_TYPE, MODULE_MEDIA_TYPE].includes(view.media_type)) {
    const compiled =
      view.media_type === MODULE_MEDIA_TYPE
        ? compileModuleView(view.spec)
        : compileAnywidgetSpec(view.spec);
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
