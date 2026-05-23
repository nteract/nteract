import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cloudSourceLanguage } from "../viewer/source-language.ts";

describe("cloud viewer source language mapping", () => {
  it("uses IPython highlighting for Python code cells", () => {
    assert.equal(cloudSourceLanguage("python"), "ipython");
    assert.equal(cloudSourceLanguage("py"), "ipython");
  });

  it("preserves shared CodeMirror languages instead of collapsing to plain text", () => {
    assert.equal(cloudSourceLanguage("sql"), "sql");
    assert.equal(cloudSourceLanguage("typescript"), "typescript");
    assert.equal(cloudSourceLanguage("js"), "javascript");
    assert.equal(cloudSourceLanguage(".yaml"), "yaml");
  });

  it("falls back to plain text for unsupported languages", () => {
    assert.equal(cloudSourceLanguage("r"), "plain");
    assert.equal(cloudSourceLanguage(""), "plain");
    assert.equal(cloudSourceLanguage(null), "plain");
  });
});
