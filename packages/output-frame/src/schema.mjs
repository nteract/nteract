// Pages supplies named assets; AFM code sees the standard model API only.
export const ROOT_MODEL_ID = "root";
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const safeKey = (v) =>
  typeof v === "string" && !["__proto__", "prototype", "constructor"].includes(v);
const name = (v) => safeKey(v) && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(v);
export const widgetDefinitions = (spec) => [
  [ROOT_MODEL_ID, spec],
  ...Object.entries(spec.models ?? {}),
];

export function checkAnywidgetSpec(spec) {
  try {
    const check = (condition, message) => {
      if (!condition) throw Error(message);
    };
    check(object(spec), "Anywidget spec must be an object.");
    check(
      spec.models === undefined || object(spec.models),
      "models must map IDs to widget definitions.",
    );
    check(
      Object.keys(spec.models ?? {}).every(
        (id) => safeKey(id) && /^[A-Za-z0-9_-]{1,128}$/.test(id) && id !== ROOT_MODEL_ID,
      ),
      "Child model IDs must be safe names other than root.",
    );
    const definitions = widgetDefinitions(spec);
    check(definitions.length <= 32, "At most 32 widget models are allowed.");
    const names = new Set();
    for (const [id, definition] of definitions) {
      check(object(definition), `Widget ${id} must be an object.`);
      check(
        Object.keys(definition).every((key) =>
          [
            "_esm",
            "_css",
            "state",
            "buffers",
            "buffer_paths",
            ...(id === ROOT_MODEL_ID ? ["models"] : []),
          ].includes(key),
        ),
        `Unknown field in widget ${id}.`,
      );
      check(name(definition._esm), "_esm must name a JavaScript source binding.");
      names.add(definition._esm);
      if (definition._css !== undefined) {
        check(name(definition._css), "_css must name a CSS source binding.");
        names.add(definition._css);
      }
      const state = definition.state ?? {};
      check(object(state), "state must be a JSON object.");
      check(
        !Object.hasOwn(state, "_esm") && !Object.hasOwn(state, "_css"),
        "Use the _esm and _css bindings outside state.",
      );
      const buffers = definition.buffers ?? [],
        paths = definition.buffer_paths ?? [];
      check(
        Array.isArray(buffers) && buffers.length <= 32 && buffers.every(name),
        "buffers must list at most 32 source binding names.",
      );
      check(
        Array.isArray(paths) && paths.length === buffers.length,
        "buffer_paths must have one path per buffer.",
      );
      const seen = [];
      for (const path of paths) {
        check(
          Array.isArray(path) && path.length > 0 && path.length <= 32,
          "Each buffer path must contain 1–32 keys or indices.",
        );
        check(!["_esm", "_css"].includes(path[0]), "Buffers cannot replace module or CSS traits.");
        check(
          !seen.some((other) =>
            other.slice(0, Math.min(path.length, other.length)).every((key, i) => key === path[i]),
          ),
          "Buffer paths must not overlap.",
        );
        seen.push(path);
        let value = state;
        for (const [index, key] of path.entries()) {
          check(
            Array.isArray(value)
              ? Number.isSafeInteger(key) && key >= 0 && key < value.length
              : object(value) && safeKey(key),
            "Buffer paths must address object keys or existing array indices.",
          );
          if (index < path.length - 1) {
            check(Object.hasOwn(value, key), "Buffer path parents must exist in state.");
            value = value[key];
          }
        }
      }
      for (const binding of buffers) names.add(binding);
    }
    check(names.size <= 32, "A widget view can bind at most 32 sources.");
    return { ok: true, names: [...names] };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Jupyter/anywidget buffer_paths semantics: object leaves may have been removed,
// while list slots remain null placeholders. Never walk an inherited property.
export function widgetState(definition, assets) {
  const state = structuredClone(definition.state ?? {});
  for (const [index, path] of (definition.buffer_paths ?? []).entries()) {
    let parent = state;
    for (const key of path.slice(0, -1)) parent = parent[key];
    const bytes = assets[definition.buffers[index]].bytes;
    parent[path.at(-1)] = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  const decode = (name) => new TextDecoder("utf-8", { fatal: true }).decode(assets[name].bytes);
  state._esm = decode(definition._esm);
  if (definition._css !== undefined) state._css = decode(definition._css);
  return state;
}
