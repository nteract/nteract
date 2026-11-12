// The limits of a Page's named sources, shared by the sources document
// (model/sources-doc.mjs) and the tool schemas (mcp.mjs).

/** The most sources a Page holds. */
export const MAX_SOURCES = 64;
/** The longest source name, in UTF-16 code units. */
export const MAX_SOURCE_NAME = 200;
/** A source id: what an agent names a source by. */
export const SOURCE_ID_PATTERN = "^[a-z][a-z0-9_-]{0,63}$";
/** A source revision: decimal, minted by the host from "1". */
export const SOURCE_REVISION_PATTERN = "^[1-9][0-9]{0,15}$";
