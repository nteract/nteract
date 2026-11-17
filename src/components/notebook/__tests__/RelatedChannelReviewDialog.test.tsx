import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { RelatedChannelReview } from "runtimed";
import { RelatedChannelReviewDialog } from "../RelatedChannelReviewDialog";
import {
  transitionChannelReviewAction,
  type ChannelReviewActionState,
} from "../related-channel-review-state";

const { host } = vi.hoisted(() => ({
  host: { trust: { approveRelatedChannels: vi.fn(), declineRelatedChannels: vi.fn() } },
}));
vi.mock("@nteract/notebook-host", () => ({ useNotebookHost: () => host }));
const review: RelatedChannelReview = {
  review_id: "review-a",
  owner_label: "environment.yml",
  state: "pending",
  scope: "metadata",
  declared_channels: ["https://example.test/selected/"],
  effective_channels: ["https://example.test/base/", "https://example.test/selected/"],
  uninspected_channels: ["https://example.test/base/"],
  relations: [
    {
      declaring_channel: "https://example.test/selected/",
      subdir: "noarch",
      kind: "base",
      target_channel: "https://example.test/base/",
      ignored_for_priority: false,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("related channel review", () => {
  it("shows source identities and order only after authoritative state loads", () => {
    const { rerender } = render(<RelatedChannelReviewDialog review={review} loaded={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<RelatedChannelReviewDialog review={review} loaded />);
    expect(screen.getByRole("dialog")).toHaveTextContent("environment.yml");
    expect(screen.getByRole("region", { name: "Channel priority" }).textContent).toContain(
      "https://example.test/base/",
    );
    expect(screen.getByText(/Declared by/)).toHaveTextContent(
      "https://example.test/selected/ (noarch); https://example.test/base/ has higher priority",
    );
  });

  it("keeps distinct relationship targets visible when they share a declaring source", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <RelatedChannelReviewDialog
        review={{
          ...review,
          relations: [
            review.relations[0]!,
            { ...review.relations[0]!, target_channel: "https://example.test/another-base/" },
          ],
        }}
        loaded
      />,
    );
    const relationships = screen.getByRole("region", { name: "Channel relationships" });
    expect(relationships).toHaveTextContent("https://example.test/base/");
    expect(relationships).toHaveTextContent("https://example.test/another-base/");
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("requires approval of a complete graph's priority order", () => {
    render(
      <RelatedChannelReviewDialog
        review={{ ...review, scope: "install", uninspected_channels: [] }}
        loaded
      />,
    );
    expect(screen.getByRole("button", { name: "Approve package sources" })).toBeEnabled();
    expect(screen.getByRole("region", { name: "Channel relationships" })).toHaveTextContent(
      "https://example.test/base/",
    );
    expect(screen.getByRole("region", { name: "Channel priority" })).toBeInTheDocument();
  });

  it("submits the rendered review id once and preserves stale errors", async () => {
    host.trust.approveRelatedChannels.mockRejectedValue(
      new Error("Environment changed; review it again"),
    );
    render(<RelatedChannelReviewDialog review={review} loaded />);
    fireEvent.click(screen.getByRole("button", { name: "Allow metadata inspection" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Environment changed"));
    expect(host.trust.approveRelatedChannels).toHaveBeenCalledExactlyOnceWith("review-a");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("requires a separate decision when metadata discovery produces an install review", async () => {
    host.trust.approveRelatedChannels.mockResolvedValue(undefined);
    const { rerender } = render(<RelatedChannelReviewDialog review={review} loaded />);
    fireEvent.click(screen.getByRole("button", { name: "Allow metadata inspection" }));
    await waitFor(() =>
      expect(host.trust.approveRelatedChannels).toHaveBeenCalledExactlyOnceWith("review-a"),
    );
    rerender(
      <RelatedChannelReviewDialog
        review={{
          ...review,
          review_id: "install-review",
          scope: "install",
          uninspected_channels: [],
        }}
        loaded
      />,
    );
    expect(screen.getByRole("button", { name: "Approve package sources" })).toBeEnabled();
    expect(host.trust.approveRelatedChannels).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Approve package sources" }));
    await waitFor(() =>
      expect(host.trust.approveRelatedChannels).toHaveBeenLastCalledWith("install-review"),
    );
  });

  it("does not let a late approval close a newer review", async () => {
    let resolve!: () => void;
    host.trust.approveRelatedChannels.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const { rerender } = render(<RelatedChannelReviewDialog review={review} loaded />);
    fireEvent.click(screen.getByRole("button", { name: "Allow metadata inspection" }));
    await waitFor(() => expect(host.trust.approveRelatedChannels).toHaveBeenCalledTimes(1));
    rerender(
      <RelatedChannelReviewDialog
        review={{ ...review, review_id: "review-b", owner_label: "Updated environment" }}
        loaded
      />,
    );
    await act(async () => resolve());
    expect(screen.getByRole("dialog")).toHaveTextContent("Updated environment");
    expect(screen.getByRole("button", { name: "Allow metadata inspection" })).toBeEnabled();
  });

  it("keeps the result when the runtime clears its review before the response", async () => {
    let resolve!: () => void;
    host.trust.approveRelatedChannels.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const { rerender } = render(<RelatedChannelReviewDialog review={review} loaded />);
    fireEvent.click(screen.getByRole("button", { name: "Allow metadata inspection" }));
    await waitFor(() => expect(host.trust.approveRelatedChannels).toHaveBeenCalledTimes(1));
    rerender(<RelatedChannelReviewDialog review={null} loaded />);
    await act(async () => resolve());
    expect(screen.getByRole("dialog")).toHaveTextContent("Retry the action you started");
    expect(host.trust.approveRelatedChannels).toHaveBeenCalledTimes(1);
  });

  it("declines without approving or reopening the same pending review", async () => {
    host.trust.declineRelatedChannels.mockResolvedValue(undefined);
    const { rerender } = render(<RelatedChannelReviewDialog review={review} loaded />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    rerender(<RelatedChannelReviewDialog review={{ ...review }} loaded />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(host.trust.declineRelatedChannels).toHaveBeenCalledExactlyOnceWith("review-a");
    expect(host.trust.approveRelatedChannels).not.toHaveBeenCalled();
  });

  it.each([undefined, "future-scope"])("does not approve an unrecognized scope: %s", (scope) => {
    render(
      <RelatedChannelReviewDialog
        review={{ ...review, scope } as unknown as RelatedChannelReview}
        loaded
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(host.trust.approveRelatedChannels).not.toHaveBeenCalled();
  });

  it("does not infer installation permission from an empty metadata frontier", () => {
    render(<RelatedChannelReviewDialog review={{ ...review, uninspected_channels: [] }} loaded />);
    expect(screen.getByRole("button", { name: "Allow metadata inspection" })).toBeInTheDocument();
    expect(screen.getByText(/It does not approve package installation/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve package sources" })).toBeNull();
  });

  it("never exposes approval to a cloud client without execution authority", () => {
    render(<RelatedChannelReviewDialog review={review} loaded canApprove={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("channel-review action transitions", () => {
  const scope = {};
  const states: ChannelReviewActionState[] = [
    { phase: "idle", reviewId: "a" },
    { phase: "submitting", reviewId: "a", action: "approve", scope },
    { phase: "approved", reviewId: "a" },
    { phase: "declined", reviewId: "a" },
    { phase: "error", reviewId: "a", message: "old" },
  ];
  it.each(states)("rejects stale completion in $phase and resets on a new review", (state) => {
    expect(transitionChannelReviewAction(state, { type: "succeeded", reviewId: "old" })).toBe(
      state,
    );
    expect(
      transitionChannelReviewAction(state, { type: "failed", reviewId: "old", message: "late" }),
    ).toBe(state);
    expect(transitionChannelReviewAction(state, { type: "review_changed", reviewId: "b" })).toEqual(
      { phase: "idle", reviewId: "b" },
    );
    expect(transitionChannelReviewAction(state, { type: "reset" })).toEqual({
      phase: "idle",
      reviewId: null,
    });
  });
  it("guards duplicate and stale submissions", () => {
    const submitting = states[1]!;
    expect(
      transitionChannelReviewAction(submitting, {
        type: "submit",
        reviewId: "a",
        action: "decline",
        scope,
      }),
    ).toBe(submitting);
    expect(
      transitionChannelReviewAction(states[0]!, {
        type: "submit",
        reviewId: "old",
        action: "approve",
        scope,
      }),
    ).toBe(states[0]);
  });
});
