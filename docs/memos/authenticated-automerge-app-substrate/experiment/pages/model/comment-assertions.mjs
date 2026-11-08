import * as A from "@automerge/automerge/slim";

// Draft stored contract: descriptive labels, never identity or admission evidence.
// The entire author subtree is immutable after creation. IDs and links are not
// part of this shared snapshot; private request context must be projected first.
export function commentAssertions(value) {
  if (value === undefined) return undefined;
  const invalid = () => {
    throw Object.assign(Error("Invalid comment client assertions"), {
      status: 400,
      code: "invalid_arguments",
    });
  };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    Object.keys(value).some((key) => !["version", "name", "model"].includes(key))
  )
    invalid();
  const out = { version: 1 };
  for (const [key, limit] of [
    ["name", 80],
    ["model", 120],
  ]) {
    if (!Object.hasOwn(value, key)) continue;
    const text = authorScalar(value[key]);
    if (
      typeof text !== "string" ||
      !text.length ||
      text.length > limit ||
      text !== text.trim() ||
      new TextEncoder().encode(text).byteLength > limit ||
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text)
    )
      invalid();
    out[key] = text;
  }
  if (Object.keys(out).length === 1) invalid();
  return out;
}

/** Local publication proposal: explicit per-field MCP assertions on comment
 * creation only. Enablement needs a published opt-in contract; origin alone
 * is not consent. Private legacy telemetry and clientInfo never supply labels. */
export function commentAssertionsFromRequest(context) {
  const claims = context?.explicitAgent;
  const values = { name: claims?.name, model: claims?.model };
  const labels = Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) => value !== undefined && readCommentAssertions({ version: 1, [key]: value }),
    ),
  );
  return Object.keys(labels).length ? commentAssertions({ version: 1, ...labels }) : undefined;
}

/** Reads expose only the known version. Unknown/malformed historical claims
 * stay in native bytes, not accidentally promoted into public metadata. */
export function readCommentAssertions(value) {
  try {
    return commentAssertions(value);
  } catch {
    return undefined;
  }
}

export function readCommentAuthor(author) {
  const fields = Object.fromEntries(
    ["principal", "displayName", "driver"]
      .filter((key) => authorScalar(author?.[key]) !== undefined)
      .map((key) => [key, authorScalar(author[key])]),
  );
  const claims = readCommentAssertions(author?.clientAssertions);
  return { ...fields, ...(claims && { clientAssertions: claims }) };
}

function authorScalar(value) {
  if (typeof value === "string") return value;
  if (A.isImmutableString(value)) return String(value);
  return undefined;
}
