#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConnection } from "@nteract/pages-client/node";
import { createPagesServer } from "./server.js";
try {
  const path = process.env.PAGES_CONNECTION_FILE;
  if (!path) throw Error("Set PAGES_CONNECTION_FILE to a private file created by pages-connect");
  const server = await createPagesServer(await loadConnection(path));
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(error instanceof Error ? error.message : "Pages MCP could not start");
  process.exitCode = 1;
}
