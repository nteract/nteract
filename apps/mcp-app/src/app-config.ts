import type { McpUiAppCapabilities } from "@modelcontextprotocol/ext-apps";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";

export const NTERACT_MCP_APP_INFO = {
  name: "nteract",
  version: "0.1.0",
} satisfies Implementation;

export const NTERACT_MCP_APP_CAPABILITIES = {
  availableDisplayModes: ["inline"],
} satisfies McpUiAppCapabilities;
