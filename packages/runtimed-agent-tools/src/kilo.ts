import { createAgentToolHooks } from "./plugin.js";

const server = async () => createAgentToolHooks();

export default {
  id: "@runtimed/agent-tools",
  server,
};
