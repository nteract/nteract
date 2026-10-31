// What the viewer's red banners say, and which of them a screen shows.
//
// A banner is for a failure the person can act on, or one that has lasted
// long enough to matter. A transient failure (isTransientFailure: a restart,
// a gateway error, a lost connection) only changes the Page's save status
// while the session retries. When one outlasts the retries, the banner says
// so in a plain sentence, never with a status code.
import { isTransientFailure } from "./request.mjs";

/** An open Page could not reach the server for longer than its retries. */
export const SERVER_UNREACHABLE =
  "Pages can't reach the server. Your changes are saved on this device.";
/** An action the person asked for failed because the server was unreachable. */
export const SERVER_UNREACHABLE_ACTION = "Pages can't reach the server. Try again in a moment.";

/** The banner sentence for a failed action the person asked for. */
export function failureMessage(error) {
  if (isTransientFailure(error)) return SERVER_UNREACHABLE_ACTION;
  if (error instanceof Error) return error.message;
  return typeof error?.message === "string" ? error.message : String(error);
}

/**
 * The banners one screen shows, in order: each message once, without empty
 * ones or those another notice on the screen already shows (`shown`).
 */
export function bannerMessages(messages, { shown = [] } = {}) {
  const seen = new Set(
    shown.filter((message) => typeof message === "string").map((message) => message.trim()),
  );
  const banners = [];
  for (const message of messages) {
    if (typeof message !== "string") continue;
    const text = message.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    banners.push(text);
  }
  return banners;
}
