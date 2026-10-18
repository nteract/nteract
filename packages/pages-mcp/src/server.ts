import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PagesClient, PagesError } from "@nteract/pages-client";
import { watchPage, type ConnectionFile } from "@nteract/pages-client/node";

import { pageTools as tools } from "@nteract/pages-client/tools";

export async function createPagesServer(config: ConnectionFile) {
  const client = new PagesClient(config.origin, { token: config.token });
  const { connection } = await client.connection();
  if (connection.page_id !== config.page_id)
    throw Error("Connection file targets a different Page");
  const uri = `${client.origin}/?page=${config.page_id}`;
  const server = new Server(
    { name: "nteract-pages", version: "0.1.0" },
    { capabilities: { tools: {}, resources: { subscribe: true } } },
  );
  const permitted = tools.filter((tool) => {
    const permission =
      tool.name.includes("comment") && tool.name !== "list_page_comments"
        ? "comment"
        : ["patch_page", "edit_page"].includes(tool.name)
          ? "edit"
          : "read";
    return connection.permissions.includes(permission);
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: permitted }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (!permitted.some((tool) => tool.name === request.params.name))
        throw new PagesError(
          "Tool is outside this connection's permissions",
          "forbidden",
          403,
          "not_committed",
        );
      const args = request.params.arguments ?? {};
      if (args.page_id !== config.page_id)
        throw new PagesError(
          "Use the explicitly approved Page ID",
          "forbidden",
          403,
          "not_committed",
        );
      const value = await client.call(request.params.name, args);
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
    } catch (error) {
      const value =
        error instanceof PagesError
          ? {
              error: {
                code: error.code,
                message: error.message,
                commit_status: error.commitStatus,
              },
            }
          : { error: { message: "Pages operation failed", commit_status: "unknown" } };
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(value) }] };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri,
        name: config.page_id,
        description: `Page approved for ${connection.driver}`,
        mimeType: "application/json",
      },
    ],
  }));
  const checkUri = (value: string) => {
    if (value !== uri) throw Error("Unknown Page resource");
  };
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    checkUri(request.params.uri);
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(await client.readPage(config.page_id)),
        },
      ],
    };
  });
  let subscription: ReturnType<typeof watchPage> | undefined;
  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    checkUri(request.params.uri);
    if (!subscription)
      subscription = watchPage(
        config,
        () => {
          void server
            .notification({ method: "notifications/resources/updated", params: { uri } })
            .catch(() => {});
        },
        {
          onError: () => {
            /* Reads/tools retain the authoritative auth/error outcome. */
          },
        },
      );
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    checkUri(request.params.uri);
    subscription?.close();
    subscription = undefined;
    return {};
  });
  server.onclose = () => subscription?.close();
  return server;
}
