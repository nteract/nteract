import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const string = { type: "string" };
const page = { ...string, description: "Explicit Page ID returned by list_pages or create_page." };
const guard = {
  page_id: page,
  base_heads: {
    type: "array",
    items: string,
    description:
      "Exact heads from the latest read_page result. Read again after a stale-revision error.",
  },
  idempotency_key: {
    ...string,
    minLength: 8,
    maxLength: 128,
    description: "Unique request key. Reuse the same key and payload after an uncertain result.",
  },
};
const tool = (name, description, properties, required = [], annotations) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  ...(annotations ? { annotations } : {}),
});
export const tools = [
  tool("list_pages", "List private Pages accessible to this account.", {}, [], {
    readOnlyHint: true,
  }),
  tool(
    "create_page",
    "Create an editable rich-text Page. Human and API edits sync into the same document.",
    { title: string, markdown: string, idempotency_key: guard.idempotency_key },
    ["title", "idempotency_key"],
  ),
  tool(
    "read_page",
    "Read a Page as Markdown blocks, comments, and its current heads. Read before editing.",
    { page_id: page },
    ["page_id"],
    { readOnlyHint: true },
  ),
  tool(
    "edit_page",
    "Apply an atomic structural edit batch at the observed heads. Unknown document fields are preserved. Prefer patch_page for targeted prose edits.",
    {
      ...guard,
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            op: {
              enum: [
                "set_title",
                "replace_block_markdown",
                "insert_markdown",
                "move_block",
                "delete_block",
              ],
            },
            block_id: string,
            title: string,
            markdown: string,
            after_block_id: {
              type: ["string", "null"],
              description:
                "For insert or move: put after this block ID; null puts it first; omitted appends.",
            },
          },
          required: ["op"],
        },
      },
    },
    ["page_id", "base_heads", "idempotency_key", "operations"],
  ),
  tool(
    "patch_page",
    "Make literal find-and-replace edits to Markdown. Each old string must match exactly once. Changes use text-aware Automerge mutations and appear in the live editor.",
    {
      ...guard,
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            op: { const: "patch_block_markdown" },
            block_id: string,
            replacements: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: { old: string, new: string },
                required: ["old", "new"],
              },
            },
          },
          required: ["op", "block_id", "replacements"],
        },
      },
    },
    ["page_id", "base_heads", "idempotency_key", "operations"],
  ),
  tool(
    "manage_page_comment",
    "Add, reply to, resolve, reopen, edit or delete a comment message. For a passage comment, supply block_id and selected_text; occurrence is one-based. Comments are editable Page content.",
    {
      ...guard,
      action: { enum: ["add", "reply", "resolve", "reopen", "edit", "delete_message"] },
      block_id: string,
      thread_id: string,
      message_id: string,
      body: string,
      selected_text: string,
      occurrence: { type: "integer", minimum: 1 },
    },
    ["page_id", "base_heads", "idempotency_key", "action"],
  ),
  tool(
    "delete_page",
    "Delete a Page and its comments. This prototype has no restore operation.",
    guard,
    ["page_id", "base_heads", "idempotency_key"],
    { destructiveHint: true },
  ),
];

/** Caller verifies credentials before constructing this request-local server.
 * Every invocation goes through the same authorization and model as HTTP tools.
 */
export async function handleMcp(request, invoke) {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const origin = new URL(request.url).origin;
  const server = new Server(
    { name: "nteract-pages-native", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!tools.some((tool) => tool.name === params.name))
      return { isError: true, content: [{ type: "text", text: "Unknown tool" }] };
    try {
      const result = await invoke(params.name, params.arguments ?? {});
      return {
        ...(result.ok ? {} : { isError: true }),
        content: [{ type: "text", text: await result.text() }],
      };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Request failed; outcome may be unknown. Retry the same key and payload.",
          },
        ],
      };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const result = await invoke("list_pages", {});
    if (!result.ok) throw Error("Page listing failed");
    const { pages } = await result.json();
    return {
      resources: pages.map((page) => ({
        uri: `${origin}/?page=${page.page_id}`,
        name: page.title,
        mimeType: "application/json",
      })),
    };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    const url = new URL(params.uri);
    const pageId = url.searchParams.get("page");
    if (
      url.origin !== origin ||
      url.pathname !== "/" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pageId ?? "") ||
      url.href !== `${origin}/?page=${pageId}`
    )
      throw Error("Unknown Page resource");
    const result = await invoke("read_page", { page_id: pageId });
    if (!result.ok) throw Error("Page access denied");
    return {
      contents: [{ uri: params.uri, mimeType: "application/json", text: await result.text() }],
    };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  } finally {
    await server.close();
  }
}
