import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pageTools, accountTools, operationPermission } from "@nteract/pages-client/tools";
import { readAgentAccess } from "./agent-auth.ts";
import { authorizeAgentOperation } from "./agent-access.ts";
import { PageError, readBody } from "./errors.ts";
import type { Env } from "./worker.ts";

/** Fresh authenticated server per request: no process-local account or MCP session state. */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const access = await readAgentAccess(env, request);
  if (!access)
    return new Response("An Anaconda API key or Pages connection is required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="Pages"', "Cache-Control": "no-store" },
    });
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const body = await readBody(request);
  const definitions = [...pageTools, ...(access.page_id === null ? accountTools : [])];
  const permitted = definitions.filter((t) => {
    const p = operationPermission(t.name);
    return p && access.permissions.includes(p);
  });
  const origin = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN!).origin;
  async function call(operation: string, args: Record<string, unknown>) {
    authorizeAgentOperation(access!, { operation, arguments: args });
    const stub = env.PAGES_WORKSPACES.get(env.PAGES_WORKSPACES.idFromName(access!.principal));
    return stub.fetch(
      new Request("https://pages.internal/tools", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pages-principal": access!.principal,
          Authorization: request.headers.get("Authorization")!,
          "X-Pages-Driver": request.headers.get("X-Pages-Driver") ?? "API client",
        },
        body: JSON.stringify({ operation, arguments: args }),
      }),
    );
  }
  const server = new Server(
    { name: "nteract-pages", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: permitted }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      if (!permitted.some((t) => t.name === req.params.name))
        throw new PageError("forbidden", "Tool is outside this credential's permissions", 403);
      let args = req.params.arguments ?? {};
      if (req.params.name === "create_page")
        args = {
          title: args.title,
          idempotency_key: args.idempotency_key,
          block_units: [{ markdown: args.markdown ?? "", format: "automerge-rich-text-v1" }],
        };
      const response = await call(req.params.name, args);
      return {
        ...(response.ok ? {} : { isError: true }),
        content: [{ type: "text" as const, text: await response.text() }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: {
                code: error instanceof PageError ? error.code : "request_failed",
                message: error instanceof PageError ? error.message : "Pages operation failed",
                commit_status: error instanceof PageError ? "not_committed" : "unknown",
              },
            }),
          },
        ],
      };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    let pages: { page_id: string; title?: string }[];
    if (access.page_id) pages = [{ page_id: access.page_id }];
    else {
      const response = await call("list_pages", {});
      if (!response.ok) throw Error("Page listing failed");
      pages = ((await response.json()) as { pages: typeof pages }).pages;
    }
    return {
      resources: pages.map((p) => ({
        uri: `${origin}/?page=${p.page_id}`,
        name: p.title ?? p.page_id,
        mimeType: "application/json",
      })),
    };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const url = new URL(req.params.uri);
    const pageId = url.searchParams.get("page");
    if (
      url.origin !== origin ||
      url.pathname !== "/" ||
      !pageId ||
      url.href !== `${origin}/?page=${pageId}` ||
      !/^page_[a-f0-9]{32}$/.test(pageId)
    )
      throw Error("Unknown Page resource");
    const response = await call("read_page", { page_id: pageId });
    if (!response.ok) throw Error("Page access denied");
    return {
      contents: [
        { uri: req.params.uri, mimeType: "application/json", text: await response.text() },
      ],
    };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request, { parsedBody: body });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  } finally {
    await server.close();
  }
}
