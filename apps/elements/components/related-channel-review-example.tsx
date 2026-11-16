"use client";

import { useMemo, useState } from "react";
import { NotebookHostProvider } from "@nteract/notebook-host";
import type { RelatedChannelReview } from "runtimed";
import { RelatedChannelReviewDialog } from "@/components/notebook/RelatedChannelReviewDialog";
import { Button } from "@/components/ui/button";
import { createFixtureNotebookHost } from "./fixture-notebook-host";

const fixture: RelatedChannelReview = {
  review_id: "fixture-review",
  owner_label: "analysis/environment.yml",
  state: "pending",
  scope: "metadata",
  declared_channels: ["https://conda.example.org/research/"],
  effective_channels: [
    "https://conda.example.org/foundation/",
    "https://conda.example.org/research/",
  ],
  uninspected_channels: ["https://conda.example.org/foundation/"],
  relations: [
    {
      declaring_channel: "https://conda.example.org/research/",
      subdir: "linux-64",
      kind: "base",
      target_channel: "https://conda.example.org/foundation/",
      ignored_for_priority: false,
    },
  ],
};

export function RelatedChannelReviewExample() {
  const [review, setReview] = useState<RelatedChannelReview | null>(null);
  const host = useMemo(() => {
    const host = createFixtureNotebookHost();
    host.trust.approveRelatedChannels = async () =>
      setReview((current) =>
        current?.uninspected_channels.length
          ? {
              ...current,
              review_id: "fixture-final-review",
              scope: "install",
              uninspected_channels: [],
            }
          : null,
      );
    host.trust.declineRelatedChannels = async () =>
      setReview((current) => (current ? { ...current, state: "declined" } : null));
    return host;
  }, []);
  return (
    <NotebookHostProvider host={host}>
      <Button className="mt-3" size="sm" variant="outline" onClick={() => setReview(fixture)}>
        Review additional channels
      </Button>
      <RelatedChannelReviewDialog review={review} loaded />
    </NotebookHostProvider>
  );
}
