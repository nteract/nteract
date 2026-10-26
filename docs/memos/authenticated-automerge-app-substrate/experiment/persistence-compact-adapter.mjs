/** The benchmark supplies an atomic in-memory byte store. Its accepted writes
 * are the fixture's durability boundary; deployed code must supply a real flush. */
export function compact({ peer, tree }) {
  return peer.backend.compact(tree, { durable: async () => {} });
}
