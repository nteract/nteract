#!/usr/bin/env node
import { prepareConnection, saveConnection } from "@nteract/pages-client/node";
import { PagesClient, PagesError } from "@nteract/pages-client";
const [origin, pageId, driver, path] = process.argv.slice(2);
try {
  if (!origin || !pageId || !driver || !path)
    throw Error(
      "Usage: pages-connect <service-origin> <page-id> <connection-name> <new-private-file>",
    );
  const pending = prepareConnection(origin, pageId, driver);
  console.error(
    `Approve this connection in your signed-in browser:\n${pending.approvalUrl}\nWaiting up to ten minutes. No credential is included in this URL.`,
  );
  const client = new PagesClient(origin, { token: pending.config.token });
  const deadline = Date.now() + 600000;
  for (;;) {
    try {
      await client.connection();
      break;
    } catch (error) {
      if (!(error instanceof PagesError) || error.status !== 401 || Date.now() >= deadline)
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await saveConnection(path, pending.config);
  console.error(`Connected. Set PAGES_CONNECTION_FILE=${path} when starting pages-mcp.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Connection failed");
  process.exitCode = 1;
}
