// The inline mark registry. Every writer, validator and projection reads mark
// names, value shapes and expand rules from marks.json. Rendering stays in each
// editor's code, keyed by mark name.
import registry from "./marks.json" with { type: "json" };

export const MARK_REGISTRY = registry;
const specs = new Map(registry.marks.map((spec) => [spec.name, spec]));
export const MARK_NAMES = Object.freeze(registry.marks.map((spec) => spec.name));
export const HIGHLIGHT_COLORS = Object.freeze([...specs.get("highlight").value.enum]);
export const DEFAULT_HIGHLIGHT = HIGHLIGHT_COLORS[0];

export const isKnownMark = (name) => specs.has(name);
export function markSpec(name) {
  const spec = specs.get(name);
  if (!spec) throw Error(`Unsupported rich mark: ${name}`);
  return spec;
}

// Marks a newer build wrote keep their characters but do not spread: expanding
// an unknown mark over new typing would invent formatting this build can't show.
export const markExpand = (name) => specs.get(name)?.expand ?? "none";
// Automerge `updateSpans` configuration. Equivalent to Wordgard's `expand`.
export const updateSpansConfig = Object.freeze({
  defaultExpand: "both",
  perMarkExpand: Object.freeze(
    Object.fromEntries(
      registry.marks
        .filter((spec) => spec.expand !== "both")
        .map((spec) => [spec.name, spec.expand]),
    ),
  ),
});

export function safeUrl(value) {
  return (
    typeof value === "string" &&
    ![...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value.replace(/^(https?|mailto|tel):/i, ""))
  );
}

function fieldValid(field, value) {
  if (value === undefined) return !field.required;
  if (value === null) return !!field.nullable && !field.required;
  if (field.type === "url") return safeUrl(value);
  if (field.type === "string") return typeof value === "string";
  return false;
}

function stringValid(rule, value) {
  return (
    typeof value === "string" &&
    ((rule.enum ?? []).includes(value) || (!!rule.pattern && new RegExp(rule.pattern).test(value)))
  );
}

/** Decode one stored Automerge mark value. Throws when the value is not the
 * registry's shape. Flags decode to `true`, JSON objects to plain objects. */
export function decodeMarkValue(name, value) {
  const rule = markSpec(name).value;
  if (rule.type === "flag") {
    if (value !== true) throw Error(`Invalid ${name} mark value`);
    return true;
  }
  if (rule.type === "string") {
    if (!stringValid(rule, value)) throw Error(`Invalid ${name} mark value`);
    return value;
  }
  if (rule.type === "json-object") {
    let parsed;
    try {
      parsed = typeof value === "string" ? JSON.parse(value) : null;
    } catch {
      parsed = null;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some((key) => !Object.hasOwn(rule.fields, key)) ||
      Object.entries(rule.fields).some(([key, field]) => !fieldValid(field, parsed[key]))
    )
      throw Error(`Invalid ${name} mark value`);
    return parsed;
  }
  throw Error(`Unsupported ${name} mark value type`);
}

/** Encode a decoded value for Automerge storage. JSON objects are written with
 * every registry field in registry order, absent optional fields as null. */
export function encodeMarkValue(name, value) {
  const rule = markSpec(name).value;
  if (rule.type === "flag") return decodeMarkValue(name, value === true ? true : value);
  if (rule.type === "string") return decodeMarkValue(name, value);
  if (rule.type === "json-object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error(`Invalid ${name} mark value`);
    const encoded = JSON.stringify(
      Object.fromEntries(Object.keys(rule.fields).map((key) => [key, value[key] ?? null])),
    );
    decodeMarkValue(name, encoded);
    return encoded;
  }
  throw Error(`Unsupported ${name} mark value type`);
}

/** Validate a stored value without decoding it. */
export function validateMarkValue(name, value) {
  decodeMarkValue(name, value);
}

/** Normalize caller input (API or Markdown import) for a highlight color. */
export function normalizeHighlight(value) {
  const color = typeof value === "string" ? value.trim().toLowerCase() : value;
  return decodeMarkValue("highlight", color);
}

/** JSON Schema for one format_match `add` object, derived from the registry. */
export function formatAddSchema() {
  const properties = {};
  for (const spec of registry.marks) {
    const rule = spec.value;
    if (rule.type === "flag") properties[spec.name] = { const: true };
    else if (rule.type === "string")
      properties[spec.name] = {
        type: "string",
        anyOf: [{ enum: rule.enum }, { pattern: rule.pattern }],
      };
    else if (rule.type === "json-object")
      properties[spec.name] = {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(rule.fields).map(([key, field]) => [
            key,
            { type: field.nullable ? ["string", "null"] : "string" },
          ]),
        ),
        required: Object.entries(rule.fields)
          .filter(([, field]) => field.required)
          .map(([key]) => key),
        additionalProperties: false,
      };
  }
  return { type: "object", properties, additionalProperties: false, minProperties: 1 };
}
