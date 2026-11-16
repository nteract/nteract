export type ChannelReviewAction = "approve" | "decline";
export type ChannelReviewActionState =
  | { phase: "idle"; reviewId: string | null }
  | { phase: "submitting"; reviewId: string; action: ChannelReviewAction; scope: object }
  | { phase: "approved" | "declined"; reviewId: string }
  | { phase: "error"; reviewId: string; message: string };

export type ChannelReviewActionEvent =
  | { type: "review_changed"; reviewId: string | null }
  | { type: "reset" }
  | { type: "submit"; reviewId: string; action: ChannelReviewAction; scope: object }
  | { type: "succeeded"; reviewId: string }
  | { type: "failed"; reviewId: string; message: string };

export function transitionChannelReviewAction(
  state: ChannelReviewActionState,
  event: ChannelReviewActionEvent,
): ChannelReviewActionState {
  switch (event.type) {
    case "reset":
      return { phase: "idle", reviewId: null };
    case "review_changed":
      if (state.reviewId === event.reviewId) return state;
      // Retain the result while the server removes the completed review.
      if (event.reviewId === null && (state.phase === "approved" || state.phase === "submitting"))
        return state;
      return { phase: "idle", reviewId: event.reviewId };
    case "submit":
      if (state.phase === "submitting" || state.reviewId !== event.reviewId) return state;
      return {
        phase: "submitting",
        reviewId: event.reviewId,
        action: event.action,
        scope: event.scope,
      };
    case "succeeded":
      if (state.phase !== "submitting" || state.reviewId !== event.reviewId) return state;
      return {
        phase: state.action === "approve" ? "approved" : "declined",
        reviewId: state.reviewId,
      };
    case "failed":
      if (state.phase !== "submitting" || state.reviewId !== event.reviewId) return state;
      return { phase: "error", reviewId: event.reviewId, message: event.message };
  }
}
