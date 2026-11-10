// Text a read shows in place of a node Markdown can't hold: an unknown node's
// notice and a dataframe's read-back label.

/** What a read shows for a node this build doesn't know. The type is stored
 * data, so only a short identifier is quoted. */
export function unknownNodeNotice(type) {
  const name = quotableNodeType(type);
  return name ? `[Unsupported node: ${name}]` : "[Unsupported node]";
}
/** A stored node type safe to quote: a short identifier, or null. */
export function quotableNodeType(type) {
  const name = String(type ?? "");
  return /^[a-z][a-z0-9-]{0,63}$/.test(name) ? name : null;
}
/** The read-back line of a dataframe: `[Dataframe: <title>](<src>)`. */
export const dataframeLabel = (title) => {
  // One line, whatever the stored title holds, so the read-back line always
  // matches itself on a rewrite.
  const line = title?.replace(/\s+/g, " ").trim();
  return line ? `Dataframe: ${line}` : "Dataframe";
};
