// The longest Page title an agent may write, in UTF-16 code units, shared by
// create_page and set_title (model/page.mjs, worker/index.mjs), the tool
// schemas (mcp.mjs) and the listings that show a title (worker/catalog.mjs).
export const MAX_PAGE_TITLE = 500;
