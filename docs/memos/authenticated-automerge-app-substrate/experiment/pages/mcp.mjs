import { pagePath, readPageRoute } from "./shared/routes.mjs";
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
  retry_token: {
    ...string,
    description:
      "Server-issued retry token from read_page for edits, or list_pages for create/delete. Keep the same token, key and payload on retries. Expired requests must be reconciled, never automatically resubmitted.",
  },
  idempotency_key: {
    ...string,
    minLength: 8,
    maxLength: 128,
    description:
      "Append a new UUID to retry_key_prefix returned with retry_token. Reuse the same key, token and payload after an uncertain result.",
  },
};
const matchProperties = {
  match_text: {
    ...string,
    minLength: 1,
    maxLength: 262144,
    description:
      "Exact visible text, without Markdown markup. Must match once within a paragraph or code block; cannot cross block/embed boundaries.",
  },
  replacement: {
    ...string,
    maxLength: 262144,
    description:
      "Literal replacement text, not Markdown. Keeps formatting shared by the entire match (including link destination/title); partial formatting does not spread. Untouched text keeps its CRDT identity.",
  },
  context_before: {
    ...string,
    maxLength: 262144,
    description:
      "Optional literal context in the same text segment before the match, after the previous occurrence.",
  },
  context_after: {
    ...string,
    maxLength: 262144,
    description:
      "Optional literal context in the same text segment after the match, before the next occurrence.",
  },
};
const replaceMatchOperation = {
  type: "object",
  properties: { op: { const: "replace_match" }, block_id: string, ...matchProperties },
  required: ["op", "block_id", "match_text", "replacement"],
  additionalProperties: false,
};
const tool = (name, description, properties, required = [], annotations) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  ...(annotations ? { annotations } : {}),
});
export const tools = [
  tool(
    "list_pages",
    "List Pages accessible to this account and a retry_token for catalog create/delete operations.",
    {},
    [],
    {
      readOnlyHint: true,
    },
  ),
  tool(
    "create_page",
    "Create an editable rich-text Page and return its browser URL. Human and API edits sync into the same document.",
    {
      title: string,
      markdown: string,
      idempotency_key: guard.idempotency_key,
      retry_token: guard.retry_token,
    },
    ["title", "idempotency_key"],
  ),
  tool(
    "read_page",
    "Read a Page as Markdown blocks, comments, current heads, and a retry_token for edits. Read before editing.",
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
    "Apply an atomic targeted edit batch. Prefer replace_match for visible prose: replace one literal range, optionally disambiguated by context, preserving untouched formatting and comment anchors. patch_block_markdown edits Markdown syntax. Zero or multiple matches fail the whole batch. Tool edits arrive atomically, without a typing cursor.",
    {
      ...guard,
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          oneOf: [
            replaceMatchOperation,
            {
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
          ],
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
      const body = await result.json();
      if (result.ok) {
        if (body.page_id && !body.deleted) body.url = new URL(pagePath(body.page_id), origin).href;
        if (Array.isArray(body.pages))
          body.pages = body.pages.map((page) => ({
            ...page,
            url: new URL(pagePath(page.page_id), origin).href,
          }));
      }
      return {
        ...(result.ok ? {} : { isError: true }),
        content: [{ type: "text", text: JSON.stringify(body) }],
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
        uri: `${origin}${pagePath(page.page_id)}`,
        name: page.title,
        mimeType: "application/json",
      })),
    };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    const url = new URL(params.uri);
    const route = readPageRoute(url.href);
    const pageId = route.pageId;
    if (
      url.origin !== origin ||
      route.kind !== "page" ||
      (url.href !== origin + route.path && url.href !== origin + "/?page=" + pageId)
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
