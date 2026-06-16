import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markdownConnectionCopy } from "../viewer/markdown-document-connection-copy";

describe("Markdown document route connection copy", () => {
  it("keeps seeded content stable while live sync connects", () => {
    assert.equal(markdownConnectionCopy("connecting", true), null);
  });

  it("shows body sync copy before any body is ready", () => {
    assert.equal(markdownConnectionCopy("connecting", false), "Syncing Markdown document body.");
  });

  it("keeps meaningful post-load connectivity warnings", () => {
    assert.equal(
      markdownConnectionCopy("reconnecting", true),
      "Reconnecting to the live Markdown document.",
    );
    assert.equal(
      markdownConnectionCopy("offline", true),
      "Markdown document is offline. Local changes will wait for reconnection.",
    );
  });
});
