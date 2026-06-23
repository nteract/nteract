import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CommentsProjection } from "@/components/notebook";
import {
  commentAuthorActorLabels,
  commentAuthorProfilePeers,
  commentAuthorProfileUrls,
  commentAuthorProfilesUrl,
  mergeCommentAuthorPeers,
} from "../viewer/comment-author-profiles.ts";

describe("cloud comment author profiles", () => {
  it("collects unique thread, message, and resolution actor labels", () => {
    const projection: CommentsProjection = {
      comments_doc_id: "comments:demo",
      threads: [
        {
          id: "thread-1",
          anchor: { kind: "notebook" },
          position: "1",
          status: "resolved",
          messages: [
            {
              id: "message-1",
              position: "1",
              body: "hello",
              created_at: "2026-06-23T00:00:00.000Z",
              created_by_actor_label: "user:anaconda:greg/browser:tab",
            },
          ],
          badge_cell_ids: [],
          created_at: "2026-06-23T00:00:00.000Z",
          created_by_actor_label: "user:anaconda:kyle/browser:tab",
          resolved_at: "2026-06-23T00:01:00.000Z",
          resolved_by_actor_label: "user:anaconda:greg/browser:tab",
        },
      ],
    };

    assert.deepEqual(commentAuthorActorLabels(projection), [
      "user:anaconda:greg/browser:tab",
      "user:anaconda:kyle/browser:tab",
    ]);
  });

  it("builds a bounded profile lookup URL from actor labels", () => {
    assert.equal(
      commentAuthorProfilesUrl("/api/n/nb-1/author-profiles", ["user:anaconda:greg/browser:tab"]),
      "/api/n/nb-1/author-profiles?actor_label=user%3Aanaconda%3Agreg%2Fbrowser%3Atab",
    );
  });

  it("batches profile lookup URLs under the server principal limit", () => {
    const labels = Array.from(
      { length: 205 },
      (_, index) => `user:anaconda:author-${index}/browser:tab`,
    );
    const urls = commentAuthorProfileUrls("/api/n/nb-1/author-profiles", labels);

    assert.equal(urls.length, 3);
    assert.deepEqual(
      urls.map((url) => new URL(url, "http://localhost").searchParams.getAll("actor_label").length),
      [100, 100, 5],
    );
  });

  it("projects profile rows into author peers and keeps profile labels over generic presence", () => {
    const profilePeers = commentAuthorProfilePeers({
      profiles: [
        {
          principal: "user:anaconda:greg",
          label: "Greg Jennings",
          image_url: "https://profiles.example/greg.png",
        },
        {
          principal: "user:anaconda:bad",
          label: "",
        },
      ],
    });

    assert.deepEqual(profilePeers, [
      {
        participantKey: "user:anaconda:greg",
        label: "Greg Jennings",
        imageUrl: "https://profiles.example/greg.png",
      },
    ]);
    assert.deepEqual(
      mergeCommentAuthorPeers(profilePeers, [
        {
          participantKey: "user:anaconda:greg",
          label: "Anaconda user",
        },
      ]),
      profilePeers,
    );
  });

  it("lets specific live presence refresh a stored profile label", () => {
    assert.deepEqual(
      mergeCommentAuthorPeers(
        [{ participantKey: "user:anaconda:greg", label: "Greg Jennings" }],
        [{ participantKey: "user:anaconda:greg", label: "Greg J." }],
      ),
      [{ participantKey: "user:anaconda:greg", label: "Greg J." }],
    );
  });
});
