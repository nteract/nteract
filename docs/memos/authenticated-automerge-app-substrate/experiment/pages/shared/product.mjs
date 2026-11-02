/** The product name people and agents see: tab titles, the page header,
 * /connect, the agent guide and the MCP serverInfo name. */
export const PRODUCT_NAME = "Pages";

/** A tab title: `<page title> · <product>`, or the product alone. */
export const tabTitle = (title) => (title ? `${title} · ${PRODUCT_NAME}` : PRODUCT_NAME);
