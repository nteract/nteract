import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  humanizeNotebookRouteTitle,
  notebookRouteSegmentTitle,
} from "../src/notebook-route-title.ts";

describe("notebook route title projection", () => {
  it("turns slug-like route segments into readable titles", () => {
    assert.equal(notebookRouteSegmentTitle("topic-viz"), "Topic Viz");
    assert.equal(notebookRouteSegmentTitle("topic_viz"), "Topic Viz");
    assert.equal(notebookRouteSegmentTitle("sup%20quill"), "Sup Quill");
  });

  it("preserves acronym-looking words that are already in the route", () => {
    assert.equal(
      notebookRouteSegmentTitle("Quill%20HF%20workstation%20smoke"),
      "Quill HF Workstation Smoke",
    );
    assert.equal(humanizeNotebookRouteTitle("OAuth API Q2 review"), "OAuth API Q2 Review");
  });

  it("falls back cleanly for empty or malformed route segments", () => {
    assert.equal(notebookRouteSegmentTitle(""), null);
    assert.equal(notebookRouteSegmentTitle("%"), "%");
  });
});
