import type { NotebookResponse, NotebookTransport } from "runtimed";
import type { HostTrust } from "./types";

/** Identical approval semantics for native relays and hosted transports. */
export function createChannelReviewTrust(
  transport: NotebookTransport,
): Pick<HostTrust, "approveRelatedChannels" | "declineRelatedChannels"> {
  async function request(
    type: "approve_related_channels" | "decline_related_channels",
    reviewId: string,
  ) {
    const response = (await transport.sendRequest({
      type,
      review_id: reviewId,
    })) as NotebookResponse;
    if (response.result === "ok") return;
    if (response.result === "guard_rejected") throw new Error(response.reason);
    if (response.result === "error") throw new Error(response.error);
    throw new Error(`Unexpected channel review response: ${JSON.stringify(response)}`);
  }
  return {
    approveRelatedChannels: (id) => request("approve_related_channels", id),
    declineRelatedChannels: (id) => request("decline_related_channels", id),
  };
}
