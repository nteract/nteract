import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inlineWidgetBlobUrls } from "../viewer/widget-blob-inlining.ts";

describe("cloud widget blob inlining", () => {
  it("inlines allowed text blob URLs and binary blob URLs", async () => {
    const state: Record<string, unknown> & { nested: Record<string, unknown> } = {
      code: "https://cloud.test/api/n/demo/blobs/text-hash",
      nested: {
        value: "https://cloud.test/api/n/demo/blobs/binary-hash",
      },
    };
    const fetches: string[] = [];

    await inlineWidgetBlobUrls(
      state,
      { textPaths: [["code"]], bufferPaths: [["nested", "value"]] },
      {
        isAllowedBlobUrl: (url) => url.startsWith("https://cloud.test/api/n/demo/blobs/"),
        fetchImpl: async (url) => {
          fetches.push(String(url));
          if (String(url).endsWith("text-hash")) {
            return new Response("export default {}");
          }
          return new Response(new Uint8Array([1, 2, 3]));
        },
      },
    );

    assert.equal(state.code, "export default {}");
    assert.ok(state.nested.value instanceof DataView);
    assert.equal(state.nested.value.byteLength, 3);
    assert.deepEqual(fetches, [
      "https://cloud.test/api/n/demo/blobs/text-hash",
      "https://cloud.test/api/n/demo/blobs/binary-hash",
    ]);
  });

  it("leaves rejected or failed fetch paths unchanged", async () => {
    const state = {
      allowed: "https://cloud.test/api/n/demo/blobs/missing",
      rejected: "https://example.invalid/track",
      missingParent: "unchanged",
    };

    await inlineWidgetBlobUrls(
      state,
      {
        textPaths: [["allowed"], ["rejected"], ["missing", "child"], []],
      },
      {
        isAllowedBlobUrl: (url) => url.startsWith("https://cloud.test/api/n/demo/blobs/"),
        fetchImpl: async () => new Response("not found", { status: 404 }),
      },
    );

    assert.equal(state.allowed, "https://cloud.test/api/n/demo/blobs/missing");
    assert.equal(state.rejected, "https://example.invalid/track");
    assert.equal(state.missingParent, "unchanged");
  });

  it("leaves paths unchanged when response body reads fail", async () => {
    const state: Record<string, unknown> & { nested: Record<string, unknown> } = {
      text: "https://cloud.test/api/n/demo/blobs/text",
      nested: {
        binary: "https://cloud.test/api/n/demo/blobs/binary",
      },
    };

    await inlineWidgetBlobUrls(
      state,
      { textPaths: [["text"]], bufferPaths: [["nested", "binary"]] },
      {
        isAllowedBlobUrl: () => true,
        fetchImpl: async (url) =>
          String(url).endsWith("text")
            ? failingBodyResponse("text body failed")
            : failingBodyResponse("binary body failed"),
      },
    );

    assert.equal(state.text, "https://cloud.test/api/n/demo/blobs/text");
    assert.equal(state.nested.binary, "https://cloud.test/api/n/demo/blobs/binary");
  });
});

function failingBodyResponse(message: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error(message));
      },
    }),
  );
}
