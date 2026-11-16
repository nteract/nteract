import { checkAnywidgetSpec } from "@nteract/output-frame/schema";
import { bindingOf } from "./sources.mjs";
import { ESM_MEDIA_TYPE, CSS_MEDIA_TYPE } from "./anywidget-view.mjs";

const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));

/** Compile Pages source references into the output-frame's host-independent
 * named-byte envelope. Generated names are private to this mount, never stored.
 * Dependencies retain every use (including role/path) while equal references
 * share one transfer. A followed reference and a pinned one remain distinct. */
export function compileAnywidgetSpec(spec) {
  try {
    const check = (condition, message) => {
      if (!condition) throw Error(message);
    };
    check(object(spec), "Anywidget spec must be an object.");
    check(
      spec.models === undefined || object(spec.models),
      "models must map IDs to widget definitions.",
    );
    const children = Object.entries(spec.models ?? {});
    check(children.length < 32, "At most 32 widget models are allowed.");
    check(
      children.every(
        ([id]) =>
          /^[A-Za-z0-9_-]{1,128}$/.test(id) &&
          !["root", "__proto__", "prototype", "constructor"].includes(id),
      ),
      "Child model IDs must be safe names other than root.",
    );
    const names = new Map(),
      dependencies = [];
    const bind = (value, role, location) => {
      const source = bindingOf(value);
      check(source, `${location} must be {source_id} or {source_id, revision}.`);
      const key = JSON.stringify(source);
      if (!names.has(key)) names.set(key, `asset_${names.size}`);
      check(names.size <= 32, "A widget view can reference at most 32 distinct source versions.");
      const name = names.get(key);
      const mediaType =
        role === "module" ? ESM_MEDIA_TYPE : role === "stylesheet" ? CSS_MEDIA_TYPE : undefined;
      dependencies.push({ name, source, role, location, ...(mediaType && { mediaType }) });
      return name;
    };
    const definition = (value, location, root = false) => {
      check(object(value), `${location} must be a widget definition.`);
      check(
        keys(value, ["module", "stylesheet", "state", "buffers", ...(root ? ["models"] : [])]),
        `Unknown field in ${location}. Use module, stylesheet, state and paired buffers.`,
      );
      const out = { _esm: bind(value.module, "module", `${location}.module`) };
      if (value.stylesheet !== undefined)
        out._css = bind(value.stylesheet, "stylesheet", `${location}.stylesheet`);
      if (value.state !== undefined) out.state = value.state;
      if (value.buffers !== undefined) {
        check(
          Array.isArray(value.buffers) && value.buffers.length <= 32,
          `${location}.buffers must list at most 32 {source, path} pairs.`,
        );
        out.buffers = [];
        out.buffer_paths = [];
        for (const [index, input] of value.buffers.entries()) {
          const at = `${location}.buffers[${index}]`;
          check(
            object(input) && keys(input, ["source", "path"]) && Object.hasOwn(input, "path"),
            `${at} must be a {source, path} pair.`,
          );
          out.buffers.push(bind(input.source, "buffer", `${at}.source`));
          out.buffer_paths.push(input.path);
        }
      }
      // Reuse the runtime's state/path safety rules, without a second codec.
      const checked = checkAnywidgetSpec(out);
      check(checked.ok, `${location}: ${checked.error}`);
      return out;
    };
    const compiled = definition(spec, "spec", true);
    if (spec.models !== undefined)
      compiled.models = Object.fromEntries(
        children.map(([id, value]) => [id, definition(value, `spec.models.${id}`)]),
      );
    return { ok: true, spec: compiled, dependencies };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
