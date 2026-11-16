import { useEffect, useReducer } from "react";
import { GlobeIcon } from "lucide-react";
import { useNotebookHost } from "@nteract/notebook-host";
import type { RelatedChannelReview } from "runtimed";
import { Button } from "@/components/ui/button";
import { RuntimeDecisionDialog } from "./RuntimeDecisionDialog";
import { transitionChannelReviewAction } from "./related-channel-review-state";

export interface RelatedChannelReviewDialogProps {
  review: RelatedChannelReview | null | undefined;
  loaded: boolean;
  canApprove?: boolean;
}

/** The daemon owns review contents and authorization; this owns dialog actions. */
export function RelatedChannelReviewDialog({
  review,
  loaded,
  canApprove = true,
}: RelatedChannelReviewDialogProps) {
  const host = useNotebookHost();
  const reviewId = loaded && canApprove ? (review?.review_id ?? null) : null;
  const [action, dispatch] = useReducer(transitionChannelReviewAction, { phase: "idle", reviewId });

  useEffect(() => {
    dispatch({ type: "reset" });
  }, [host]);

  useEffect(() => {
    dispatch(loaded && canApprove ? { type: "review_changed", reviewId } : { type: "reset" });
  }, [loaded, canApprove, reviewId, host]);

  useEffect(() => {
    if (action.phase !== "submitting" || action.scope !== host.trust || !loaded || !canApprove)
      return;
    const controller = new AbortController();
    const capturedId = action.reviewId;
    const request =
      action.action === "approve"
        ? host.trust.approveRelatedChannels(capturedId)
        : host.trust.declineRelatedChannels(capturedId);
    void request.then(
      () => {
        if (!controller.signal.aborted) dispatch({ type: "succeeded", reviewId: capturedId });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          dispatch({
            type: "failed",
            reviewId: capturedId,
            message: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => controller.abort();
  }, [action, loaded, canApprove, host]);

  if (!loaded || !canApprove) return null;
  const isCurrent = action.reviewId === reviewId;
  const submitting = isCurrent && action.phase === "submitting";
  const completed = !review && action.phase === "approved";
  const pending = review?.state === "pending" && !(isCurrent && action.phase === "declined");
  const waitingForDiscovery = isCurrent && action.phase === "approved";
  const error = isCurrent && action.phase === "error" ? action.message : null;

  function submit(kind: "approve" | "decline") {
    if (!reviewId || !pending || submitting || waitingForDiscovery) return;
    dispatch({ type: "submit", reviewId, action: kind, scope: host.trust });
  }

  return (
    <RuntimeDecisionDialog
      open={Boolean(pending || completed)}
      onOpenChange={(open) => {
        if (!open) completed ? dispatch({ type: "reset" }) : submit("decline");
      }}
      title={completed ? "Channels approved" : "Review additional channels"}
      description={
        completed
          ? "Retry the action you started to continue with the approved channels."
          : `${review?.owner_label ?? "This environment"} uses repositories that declare additional package channels. Review their sources and priority order before continuing.`
      }
      icon={<GlobeIcon className="size-5" />}
      testId="related-channel-review-dialog"
      footer={
        completed ? (
          <Button onClick={() => dispatch({ type: "reset" })}>Close</Button>
        ) : (
          <>
            <Button
              variant="outline"
              disabled={submitting || waitingForDiscovery}
              onClick={() => submit("decline")}
            >
              Cancel
            </Button>
            <Button disabled={submitting || waitingForDiscovery} onClick={() => submit("approve")}>
              {submitting || waitingForDiscovery ? "Checking channels…" : "Allow and continue"}
            </Button>
          </>
        )
      }
    >
      {!completed && review && (
        <div className="max-h-[55vh] space-y-4 overflow-y-auto text-sm">
          {review.uninspected_channels.length > 0 && (
            <section aria-label="Additional channels">
              <h3 className="mb-2 font-medium">Additional channels to inspect</h3>
              <ul className="space-y-2">
                {review.uninspected_channels.map((channel) => (
                  <li key={channel} className="font-mono break-all">
                    {channel}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-label="Channel relationships">
            <h3 className="mb-2 font-medium">Why these channels are included</h3>
            <ul className="space-y-2">
              {review.relations.map((relation) => (
                <li
                  key={`${relation.declaring_channel}:${relation.subdir}:${relation.kind}:${relation.target_channel}`}
                  className="break-all text-xs text-muted-foreground"
                >
                  Declared by {relation.declaring_channel} ({relation.subdir});{" "}
                  {relation.target_channel} has {relation.kind === "base" ? "higher" : "lower"}{" "}
                  priority.
                  {relation.ignored_for_priority &&
                    " Your explicit channel order takes precedence."}
                </li>
              ))}
            </ul>
          </section>
          <section aria-label="Channel priority">
            <h3 className="mb-2 font-medium">Channel order, highest priority first</h3>
            <ol className="list-inside list-decimal space-y-1 font-mono break-all">
              {review.effective_channels.map((channel) => (
                <li key={channel}>
                  {channel}
                  {review.declared_channels.includes(channel) && (
                    <span className="font-sans text-xs text-muted-foreground break-normal">
                      {" "}
                      — selected in your environment
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </section>
          <p className="text-muted-foreground">
            Allowing these sources lets nteract read their metadata and use their packages. Further
            sources will need another review. Your notebook and project channel lists stay
            unchanged.
          </p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </RuntimeDecisionDialog>
  );
}
