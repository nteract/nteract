import path from "node:path";
import { readFile } from "node:fs/promises";
import { session, origin, requirePages, outputDir } from "./shared.mjs";
const { Server } = requirePages("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = requirePages("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = requirePages(
  "@modelcontextprotocol/sdk/types.js",
);
const [id, arm] = process.argv.slice(2);
if (!["old", "new"].includes(arm)) throw Error("Unknown guide");
const { client, tool, browser, page } = await session();
await page.goto(origin + "/p/" + id);
const pageTools = (await client.listTools()).tools.filter((t) =>
  ["read_page", "edit_page"].includes(t.name),
);
const paths = [
  "/llms.txt",
  "/llms/views.txt",
  "/llms/anywidget.txt",
  "/llms/assets-and-sources.txt",
  "/llms/vega-lite.txt",
];
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const tools = [
  ...pageTools,
  {
    name: "read_guide",
    description: "Read a guide from this deployment.",
    inputSchema: object({ path: { type: "string", enum: paths } }, ["path"]),
  },
  {
    name: "upload_text_asset",
    description:
      "Upload UTF-8 text bytes to the assigned Page using a real upload capability and POST. Returns the asset_id for your set_source operation.",
    inputSchema: object(
      {
        content_type: {
          type: "string",
          enum: ["text/javascript", "text/css", "application/octet-stream"],
        },
        text: { type: "string" },
      },
      ["content_type", "text"],
    ),
  },
  {
    name: "inspect_widget",
    description:
      "Inspect the rendered widget in a signed-in reader. Optionally click a named button. Returns visible text, SVG mark titles and controls.",
    inputSchema: object({ button: { type: "string" } }),
  },
];
const server = new Server(
  { name: "Pages authoring", version: "1" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
const report = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});
let dirty = true;
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  if (pageTools.some((t) => t.name === name)) {
    if (a.page_id !== id) throw Error("Use the assigned Page.");
    const result = await client.callTool({ name, arguments: a });
    if (name === "edit_page" && !result.isError) dirty = true;
    return result;
  }
  if (name === "read_guide" && paths.includes(a.path))
    return report(
      await readFile(
        path.join(
          outputDir,
          "guides",
          arm,
          a.path === "/llms.txt" ? "index.txt" : path.basename(a.path),
        ),
        "utf8",
      ),
    );
  if (name === "upload_text_asset") {
    const bytes = Buffer.from(a.text);
    const cap = await tool("create_page_asset_upload", {
      page_id: id,
      content_type: a.content_type,
      size: bytes.length,
    });
    const res = await fetch(cap.upload_url, { method: "POST", headers: cap.headers, body: bytes });
    if (!res.ok) throw Error("Upload failed " + res.status);
    return report(await res.json());
  }
  if (name === "inspect_widget") {
    if (dirty) {
      await page.reload();
      dirty = false;
    }
    const view = page.locator(".pages-anywidget-view").first();
    try {
      await view.scrollIntoViewIfNeeded({ timeout: 5000 });
      await page
        .locator(
          '.pages-anywidget-view:is([data-output-state="ready"],[data-output-state="failed"])',
        )
        .first()
        .waitFor({ timeout: 10000 });
    } catch {
      return report((await page.locator("body").innerText()).slice(-1600));
    }
    if ((await view.getAttribute("data-output-state")) === "failed")
      return report(await view.innerText());
    const f = view.frameLocator("iframe");
    if (a.button)
      await f.getByRole("button", { name: a.button, exact: true }).click({ timeout: 3000 });
    return report({
      text: (await f.locator("body").innerText()).slice(-1600),
      titles: await f.locator("svg title").allTextContents(),
    });
  }
  throw Error("Unknown tool");
});
server.onclose = () => {
  void browser.close();
};
await server.connect(new StdioServerTransport());
