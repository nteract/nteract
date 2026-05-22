import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authenticateDevRequest } from "../src/identity.ts";
import { rewritePresenceFrame } from "../src/notebook-room.ts";
import {
  FrameType,
  decodeJsonPayload,
  encodeTypedFrame,
  splitTypedFrame,
} from "../src/protocol.ts";

describe("NotebookRoom presence rewrite", () => {
  it("falls back to the authenticated actor for invalid presented actor labels", () => {
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=editor"),
    );
    const frame = splitTypedFrame(
      encodeTypedFrame(
        FrameType.PRESENCE,
        new TextEncoder().encode(JSON.stringify({ actor_label: "/bad", peer_label: "Mallory" })),
      ),
    );

    const rewritten = rewritePresenceFrame(frame, identity);
    const body = decodeJsonPayload<Record<string, unknown>>(rewritten.payload);

    assert.equal(rewritten.type, FrameType.PRESENCE);
    assert.equal(body.actor_label, "user:dev:alice/desktop:a");
    assert.equal(body.peer_label, "Mallory");
  });
});
