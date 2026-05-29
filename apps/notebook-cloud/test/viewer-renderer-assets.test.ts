import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rendererAssetBasePathForProvider } from "../viewer/renderer-assets.ts";

describe("cloud viewer renderer asset helpers", () => {
  it("normalizes configured renderer asset bases for IsolatedRendererProvider fetches", () => {
    assert.equal(rendererAssetBasePathForProvider("/renderer-assets/"), "/renderer-assets");
    assert.equal(
      rendererAssetBasePathForProvider("https://assets.example/renderer-assets/"),
      "https://assets.example/renderer-assets",
    );
  });

  it("preserves already-normalized relative and absolute bases", () => {
    assert.equal(rendererAssetBasePathForProvider("/renderer-assets"), "/renderer-assets");
    assert.equal(
      rendererAssetBasePathForProvider("https://assets.example/renderer-assets"),
      "https://assets.example/renderer-assets",
    );
  });
});
