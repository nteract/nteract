import type { LoggingMessageNotification } from "@modelcontextprotocol/sdk/types.js";

export type HostLogParams = LoggingMessageNotification["params"];
export type HostLogLevel = HostLogParams["level"];

export interface HostLogSink {
  sendLog(params: HostLogParams): void | Promise<void>;
}

const DEFAULT_LOGGER = "nteract.mcp-app";
const PREVIEW_LIMIT = 200;

let sink: HostLogSink | null = null;

export function setHostLogSink(nextSink: HostLogSink | null): void {
  sink = nextSink;
}

export function hostLog(
  level: HostLogLevel,
  event: string,
  details: Record<string, unknown> = {},
): void {
  const params: HostLogParams = {
    level,
    logger: DEFAULT_LOGGER,
    data: {
      event,
      ...details,
    },
  };

  if (sink) {
    try {
      void Promise.resolve(sink.sendLog(params)).catch((error) => {
        logToConsole("warning", "host-log-send-failed", {
          originalEvent: event,
          error: errorDetails(error),
        });
      });
      return;
    } catch (error) {
      logToConsole("warning", "host-log-send-threw", {
        originalEvent: event,
        error: errorDetails(error),
      });
    }
  }

  logToConsole(level, event, details);
}

export function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

export function stringDetails(value: string): Record<string, unknown> {
  const truncated = value.length > PREVIEW_LIMIT;
  return {
    length: value.length,
    preview: truncated ? `${value.slice(0, PREVIEW_LIMIT)}...` : value,
    truncated,
  };
}

function logToConsole(
  level: HostLogLevel,
  event: string,
  details: Record<string, unknown>,
): void {
  const consoleLevel =
    level === "error" ||
    level === "critical" ||
    level === "alert" ||
    level === "emergency"
      ? "error"
      : level === "warning"
        ? "warn"
        : level === "debug"
          ? "debug"
          : "log";
  console[consoleLevel](`[${DEFAULT_LOGGER}] ${event}`, details);
}
