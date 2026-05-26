import { describe, expect, it } from "vite-plus/test";
import { McpUiAppCapabilitiesSchema } from "@modelcontextprotocol/ext-apps";
import { NTERACT_MCP_APP_CAPABILITIES, NTERACT_MCP_APP_INFO } from "../app-config";

describe("MCP app configuration", () => {
  it("declares inline display support during ui/initialize", () => {
    expect(NTERACT_MCP_APP_INFO).toEqual({
      name: "nteract",
      version: "0.1.0",
    });
    expect(NTERACT_MCP_APP_CAPABILITIES).toEqual({
      availableDisplayModes: ["inline"],
    });
    expect(McpUiAppCapabilitiesSchema.parse(NTERACT_MCP_APP_CAPABILITIES)).toEqual(
      NTERACT_MCP_APP_CAPABILITIES,
    );
  });
});
