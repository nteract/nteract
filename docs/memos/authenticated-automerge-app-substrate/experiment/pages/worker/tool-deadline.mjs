import { HttpError } from "./auth.mjs";

/** Bound on one tool request to a Catalog or Page host. A host keeps running
 * work it accepted; a retry with the same idempotency_key and retry_token
 * returns that work's receipt. */
export const TOOL_REQUEST_TIMEOUT_MS = 60_000;

export async function withinToolDeadline(pending, ms = TOOL_REQUEST_TIMEOUT_MS) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new HttpError(
            504,
            "Pages did not answer this request in time. It may still complete: retry with the same idempotency_key and retry_token to get its result.",
            "request_timeout",
          ),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
