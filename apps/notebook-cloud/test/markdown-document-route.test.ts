import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markdownConnectionCopy } from "../viewer/markdown-document-connection-copy";
import {
  selectMarkdownInstantPaintRecord,
  shouldLoadMarkdownInstantPaintSnapshot,
} from "../viewer/markdown-document-live-sync";

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

describe("Markdown document instant paint persistence selection", () => {
  it("does not let local instant paint displace a server body seed", () => {
    assert.equal(
      shouldLoadMarkdownInstantPaintSnapshot({
        bootstrap: {
          render_seed: {
            body: "server body",
          },
        },
      }),
      false,
    );
    assert.equal(shouldLoadMarkdownInstantPaintSnapshot({ bootstrap: null }), true);
    assert.equal(
      shouldLoadMarkdownInstantPaintSnapshot({
        bootstrap: {
          render_seed: null,
        },
      }),
      true,
    );
  });

  it("selects only same-principal Markdown document snapshots", () => {
    const selected = selectMarkdownInstantPaintRecord(
      [
        {
          key: ["markdown-doc", "doc-1", "user:anaconda:other", "snapshot"],
          data: new Uint8Array([1]),
        },
        {
          key: ["markdown-doc", "doc-1", "user:anaconda:kyle", "snapshot"],
          data: new Uint8Array([2, 3]),
        },
      ],
      (principal) => principal === "user:anaconda:kyle",
    );

    assert.deepEqual(selected, new Uint8Array([2, 3]));
  });

  it("ignores malformed or foreign records", () => {
    const selected = selectMarkdownInstantPaintRecord(
      [
        {
          key: ["markdown-doc", "doc-1", "user:anaconda:kyle", "not-snapshot"],
          data: new Uint8Array([1]),
        },
        {
          key: ["markdown-doc", "doc-1", "user:anaconda:kyle", "snapshot", "extra"],
          data: new Uint8Array([2]),
        },
        {
          key: ["not-markdown", "doc-1", "user:anaconda:kyle", "snapshot"],
          data: new Uint8Array([3]),
        },
        {
          key: ["markdown-doc", "doc-1", "user:anaconda:other", "snapshot"],
          data: new Uint8Array([4]),
        },
      ],
      (principal) => principal === "user:anaconda:kyle",
    );

    assert.equal(selected, undefined);
  });
});
