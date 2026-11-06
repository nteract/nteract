import { AUTH_EVENT } from "./auth-events.mjs";

/** What no auth log line may contain: Pages OAuth tokens, bearer headers,
 * OAuth query parameters, anything email-shaped, and sealed `iv.ct` blobs. */
export const SECRET_SHAPES = Object.freeze([
  /pages_at_/,
  /pages_rt_/,
  /Bearer/,
  /code=/,
  /state=/,
  /@/,
  /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
]);

/** Record every console line for the rest of test `t`. `lines` holds each
 * call's arguments joined as text; `events` holds the parsed `pages.auth.v1`
 * records. Lines still reach the original console. */
export function captureConsole(t) {
  const lines = [];
  const events = [];
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level].bind(console);
    t.mock.method(console, level, (...args) => {
      const text = args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ");
      lines.push(text);
      try {
        const record = JSON.parse(text);
        if (record?.event === AUTH_EVENT) events.push(record);
      } catch {
        // Not a JSON line.
      }
      original(...args);
    });
  }
  return {
    lines,
    events,
    actions: () => events.map((event) => event.action),
    find: (action) => events.filter((event) => event.action === action),
  };
}

/** Lines that match a secret shape, for an assertion message. */
export function secretLines(lines, also = []) {
  return lines.filter(
    (line) =>
      SECRET_SHAPES.some((shape) => shape.test(line)) || also.some((value) => line.includes(value)),
  );
}
