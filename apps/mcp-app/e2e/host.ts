import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const iframe = document.createElement("iframe");
iframe.title = "Production MCP widget";
iframe.style.cssText = "border:0;width:100%;height:0;display:block";
iframe.sandbox.value = "allow-scripts allow-downloads allow-forms allow-pointer-lock";
document.body.append(iframe);
const bridge = new AppBridge(
  null,
  { name: "renderer-smoke", version: "1" },
  {
    serverResources: {},
    logging: {},
    sandbox: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } },
  },
  { hostContext: { theme: "light" } },
);
bridge.onreadresource = async ({ uri }) => {
  const response = await fetch("/resource", {
    method: "POST",
    body: JSON.stringify({ uri }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
const diagnostics: unknown[] = [];
Object.assign(window, { diagnostics });
bridge.onloggingmessage = (message) => {
  if (message.level === "error" || message.level === "warning") diagnostics.push(message);
};
bridge.onsizechange = ({ height }) => {
  if (height !== undefined) iframe.style.height = `${height}px`;
};
bridge.oninitialized = async () => {
  await bridge.sendToolInput({ arguments: {} });
  Object.assign(window, {
    sendResult: (result: CallToolResult) => bridge.sendToolResult(result),
  });
};
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
iframe.src = "/widget";
