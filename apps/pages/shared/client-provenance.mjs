/** Request assertions only. These fields establish neither authority nor
 * durable attribution. No server-generated agent/session identity belongs here. */
export function normalizeAgentAssertions(value) {
  if (value === undefined) return undefined;
  const invalid = (field) => {
    throw Object.assign(new Error(`Invalid _meta.agent${field ? `.${field}` : ""}`), {
      status: 400,
      code: "invalid_arguments",
    });
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const keys = Object.keys(value);
  if (keys.length > 3 || keys.some((key) => !["name", "id", "model"].includes(key))) invalid();
  const result = {};
  for (const [field, limit] of [
    ["name", 80],
    ["id", 128],
    ["model", 120],
  ]) {
    if (!Object.hasOwn(value, field)) continue;
    const text = value[field];
    if (
      typeof text !== "string" ||
      text.length > limit ||
      !text.trim() ||
      new TextEncoder().encode(text).byteLength > limit ||
      // Control and bidi formatting characters cannot masquerade as labels.
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text)
    )
      invalid(field);
    result[field] = text.trim();
  }
  return Object.keys(result).length ? Object.freeze(result) : undefined;
}
