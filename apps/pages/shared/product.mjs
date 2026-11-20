/** The product name people and agents see: tab titles, the page header,
 * /connect, the agent guide and the MCP serverInfo name. */
export const PRODUCT_NAME = "Pages";

/** A tab title: `<page title> · <product>`, or the product alone. */
export const tabTitle = (title) => (title ? `${title} · ${PRODUCT_NAME}` : PRODUCT_NAME);

/** What a link preview says about the product when a page has nothing more
 * specific: the line under the title in a shared link. */
export const PRODUCT_DESCRIPTION = "Realtime documents for people and agents.";
