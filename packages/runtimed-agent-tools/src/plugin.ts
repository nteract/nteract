import { z } from "zod";

import { RuntimedSessionRegistry, serializeRunSourceResult } from "./core.js";

export interface ToolExecutionContext {
  sessionID: string;
}

export interface SessionDeletedEvent {
  type: string;
  properties?: {
    info?: {
      id?: string;
    };
  };
}

export function createAgentToolHooks() {
  const registry = new RuntimedSessionRegistry({
    socketPath: process.env.RUNTIMED_SOCKET_PATH,
  });

  return {
    tool: {
      notebook_run_source: {
        description: "Append and execute a synced code cell in an existing nteract notebook.",
        args: {
          notebook_id: z.string().describe("Active nteract notebook ID to attach to"),
          source: z.string().describe("Python source for the new code cell"),
          timeout_ms: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Optional execution timeout in milliseconds"),
        },
        async execute(
          args: { notebook_id: string; source: string; timeout_ms?: number },
          context: ToolExecutionContext,
        ) {
          const result = await registry.runSource({
            agentSessionId: context.sessionID,
            notebookId: args.notebook_id,
            source: args.source,
            timeoutMs: args.timeout_ms,
          });
          return serializeRunSourceResult(result);
        },
      },
    },
    async event({ event }: { event: SessionDeletedEvent }) {
      const sessionId = event.properties?.info?.id;
      if (event.type === "session.deleted" && sessionId) {
        await registry.disposeAgentSession(sessionId);
      }
    },
  };
}
