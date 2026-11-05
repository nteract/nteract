import * as A from "@automerge/automerge/slim";

// The image codecs carry opaque scalar attrs, never interpret them as DOM
// attributes. Reject values JSON or the native string codec would change.
export function imageAttrs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).map(([key, v]) => [
    key,
    A.isImmutableString(v) ? String(v) : v,
  ]);
  if (
    entries.some(
      ([, v]) =>
        v !== null &&
        typeof v !== "string" &&
        typeof v !== "boolean" &&
        !(typeof v === "number" && Number.isFinite(v) && !Object.is(v, -0)),
    )
  )
    return null;
  return Object.fromEntries(entries);
}
