/**
 * Shared frontend logger.
 *
 * Delegates to the `NotebookHost` installed at boot (`setLoggerHost`). Hosts
 * decide where entries go: Tauri pipes to plugin-log, Cloud can route to the
 * browser console, and tests can install a lightweight sink.
 *
 * All methods are synchronous fire-and-forget so callers do not need to await
 * transport to the sink.
 */

import type { HostLog, NotebookHost } from "@nteract/notebook-host";

/** Serialize arguments to a single log message string. */
function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      // Preserve Error messages and stacks (JSON.stringify(Error) is just "{}").
      if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        // Circular references, proxies, etc.
        return String(a);
      }
    })
    .join(" ");
}

// Host is installed by each shell after it constructs its NotebookHost. Until
// then, and in tests/SSR/Storybook, fall back to the console. Never throw from
// logger; it is used at error-handling boundaries.
let _log: HostLog | null = null;

/** Install the NotebookHost or log sink this logger writes to. */
export function setLoggerHost(host: NotebookHost | HostLog | null): void {
  _log = host && "log" in host ? host.log : host;
}

function emit(level: "debug" | "info" | "warn" | "error", args: unknown[]): void {
  const message = formatArgs(args);
  if (_log) {
    _log[level](message);
  } else {
    // Pre-host or non-host contexts: mirror to console with a level tag.
    // eslint-disable-next-line no-console
    console.log(`[${level}] ${message}`);
  }
}

export const logger = {
  debug: (...args: unknown[]): void => emit("debug", args),
  info: (...args: unknown[]): void => emit("info", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  error: (...args: unknown[]): void => emit("error", args),
};
