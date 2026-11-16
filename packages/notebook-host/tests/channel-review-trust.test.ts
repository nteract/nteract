import { describe, expect, it, vi } from "vite-plus/test";
import type { NotebookTransport } from "runtimed";
import { createChannelReviewTrust } from "../src/channel-review-trust";

describe("channel review transport", () => {
  it("sends only the reviewed server id for approve and decline", async () => {
    const sendRequest = vi.fn().mockResolvedValue({ result: "ok" });
    const trust = createChannelReviewTrust({ sendRequest } as unknown as NotebookTransport);
    await trust.approveRelatedChannels("review-a");
    await trust.declineRelatedChannels("review-b");
    expect(sendRequest.mock.calls).toEqual([
      [{ type: "approve_related_channels", review_id: "review-a" }],
      [{ type: "decline_related_channels", review_id: "review-b" }],
    ]);
  });
  it.each([
    { result: "error", error: "Review changed" },
    { result: "guard_rejected", reason: "Review changed" },
  ])("surfaces stale server rejection: $result", async (response) => {
    const trust = createChannelReviewTrust({
      sendRequest: async () => response,
    } as unknown as NotebookTransport);
    await expect(trust.approveRelatedChannels("old-review")).rejects.toThrow("Review changed");
  });
});
