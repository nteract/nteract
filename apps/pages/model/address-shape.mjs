// The shape of an address, and nothing else. A module that only checks
// whether a string could be an address imports this, not addresses.mjs,
// which reads the document.

/** `<counter>@<actor hex>`: the Automerge op id every address is. */
export const ADDRESS_PATTERN = /^[0-9]+@[0-9a-f]+$/;
/** The longest address, in characters. It is the node id limit
 * (MAX_NODE_ID in node-ids.mjs); a test holds the two equal. */
export const MAX_ADDRESS = 192;
