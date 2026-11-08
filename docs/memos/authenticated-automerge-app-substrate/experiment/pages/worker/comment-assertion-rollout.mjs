// Host-local deployment phase, not a caller-controlled publication flag.
// Readers and journal recovery always retain v1 support. Enable fresh traffic
// only after every receiving/recovery host has reached this compatibility floor.
export const commentAssertionsEnabled = (env) => env?.PAGES_COMMENT_ASSERTIONS === "enabled";

export function requireCommentAssertionsEnabled(env, assertions) {
  if (assertions && !commentAssertionsEnabled(env))
    throw Object.assign(
      Error("Shared comment labels are temporarily unavailable; retry this operation later"),
      {
        status: 503,
        code: "comment_assertions_unavailable",
      },
    );
}
