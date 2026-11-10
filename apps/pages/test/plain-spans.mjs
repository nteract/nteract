// Stored spans as comparable JSON data.
import * as A from "@automerge/automerge";

/** Spans as JSON data: strings instead of ImmutableStrings, one text span per
 * run of equal marks. Two forms of the same content compare equal here only
 * when they store the same characters, markers and marks. */
export function plainSpans(spans) {
  const out = [];
  for (const span of spans) {
    const last = out.at(-1);
    if (span.type === "text") {
      const marks = Object.fromEntries(
        Object.entries(span.marks ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      );
      if (last?.type === "text" && JSON.stringify(last.marks) === JSON.stringify(marks))
        last.value += span.value;
      else if (span.value) out.push({ type: "text", value: span.value, marks });
      continue;
    }
    out.push({
      type: "block",
      value: {
        type: String(span.value.type),
        parents: span.value.parents.map(String),
        attrs: Object.fromEntries(
          Object.entries(span.value.attrs ?? {}).map(([key, value]) => [
            key,
            A.isImmutableString(value) ? String(value) : value,
          ]),
        ),
        isEmbed: !!span.value.isEmbed,
      },
    });
  }
  return out;
}
