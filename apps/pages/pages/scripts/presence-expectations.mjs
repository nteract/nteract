// What presence-smoke.mjs waits for before it asserts on read_page_presence.
//
// A browser publishes presence through its outbound queue, so focusing the
// editor sends a caret before the range selection that follows it. A wait on
// "two attached selections" is satisfied by that interim caret. The smoke
// must wait for the state it asserts: one caret and one range with the quote.

/** Whether `participants` from read_page_presence show exactly two attached
 * browser selections: a caret, and a range whose quote is `quote`. */
export function caretAndQuoteAttached(participants, quote) {
  if (!Array.isArray(participants)) return false;
  const attached = participants.filter((peer) => peer?.selection?.status === "attached");
  return (
    attached.length === 2 &&
    attached.some((peer) => peer.selection.kind === "caret") &&
    attached.some((peer) => peer.selection.quote === quote)
  );
}
