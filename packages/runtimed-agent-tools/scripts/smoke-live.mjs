const socketPath = process.env.RUNTIMED_SOCKET_PATH;
if (!socketPath) {
  throw new Error("RUNTIMED_SOCKET_PATH is required for the live smoke test");
}

const imported = await import("@runtimed/node");
const runtimed = typeof imported.createNotebook === "function" ? imported : imported.default;
if (typeof runtimed?.createNotebook !== "function") {
  throw new Error("@runtimed/node did not expose createNotebook");
}

const { createAgentToolHooks } = await import("../dist/plugin.js");
const owner = await runtimed.createNotebook({
  socketPath,
  workingDir: process.cwd(),
  peerLabel: "runtimed-agent-tools:live-smoke-owner",
  description: "@runtimed/agent-tools live smoke notebook",
});
const hooks = createAgentToolHooks();

try {
  const serialized = await hooks.tool.notebook_run_source.execute(
    {
      notebook_id: owner.notebookId,
      source: "answer = 6 * 7\nanswer",
      timeout_ms: 30_000,
    },
    { sessionID: "runtimed-agent-tools-live-smoke" },
  );
  const result = JSON.parse(serialized);
  if (!result.success || !JSON.stringify(result.outputs).includes("42")) {
    throw new Error(`unexpected live execution result: ${serialized}`);
  }
  console.log(`executed ${result.cell_id} as ${result.execution_id} in ${result.notebook_id}`);
} finally {
  console.log("closing agent-tool session");
  await hooks.event({
    event: {
      type: "session.deleted",
      properties: { info: { id: "runtimed-agent-tools-live-smoke" } },
    },
  });
  console.log("shutting down smoke notebook");
  await owner.shutdownNotebook();
  console.log("smoke notebook shut down");
}

// OpenCode and Kilo are long-lived hosts. End this one-shot harness explicitly
// after the same session cleanup the hosts perform.
process.exit(0);
