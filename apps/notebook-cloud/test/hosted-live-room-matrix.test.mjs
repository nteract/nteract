import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  entryLabel,
  parseLiveRoomMatrixEntries,
  safeScreenshotName,
  smokeEnvForMatrixEntry,
} from "../scripts/hosted-live-room-matrix.mjs";
import { buildMatrixFailureReport } from "../scripts/hosted-live-room-matrix-smoke.mjs";

describe("hosted live room matrix smoke helpers", () => {
  it("parses pipe and newline separated URL lists", () => {
    assert.deepEqual(
      parseLiveRoomMatrixEntries(
        "https://preview.runt.run/n/one/notebook | https://preview.runt.run/n/two/notebook\nhttps://preview.runt.run/n/three/notebook",
      ),
      [
        { url: "https://preview.runt.run/n/one/notebook" },
        { url: "https://preview.runt.run/n/two/notebook" },
        { url: "https://preview.runt.run/n/three/notebook" },
      ],
    );
  });

  it("parses JSON object entries with per-notebook expectations", () => {
    assert.deepEqual(
      parseLiveRoomMatrixEntries(
        JSON.stringify([
          {
            url: "https://preview.runt.run/n/topic-viz/topic-viz",
            label: "topic-viz",
            expectedPageTexts: ["MathNet topic visualization"],
            expectedFrameTexts: ["PROBLEM_MARKDOWN"],
            minCells: 20,
            minVisibleIframes: 2,
            minImages: 3,
            requireBlobFetch: true,
            requireImagesLoaded: true,
          },
        ]),
      ),
      [
        {
          url: "https://preview.runt.run/n/topic-viz/topic-viz",
          label: "topic-viz",
          expectedPageTexts: ["MathNet topic visualization"],
          expectedFrameTexts: ["PROBLEM_MARKDOWN"],
          minCells: 20,
          minVisibleIframes: 2,
          minImages: 3,
          requireBlobFetch: true,
          requireImagesLoaded: true,
        },
      ],
    );
  });

  it("builds permissive catalog-sweep defaults", () => {
    const env = smokeEnvForMatrixEntry(
      { url: "https://preview.runt.run/n/empty/notebook" },
      {
        NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_MIN_CELLS: "0",
        NOTEBOOK_CLOUD_LIVE_ROOM_MATRIX_REQUIRE_BLOB_FETCH: "0",
      },
    );

    assert.equal(env.NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_TEXT, "");
    assert.equal(env.NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_PAGE_TEXTS, "");
    assert.equal(env.NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_FRAME_TEXTS, "");
    assert.equal(env.NOTEBOOK_CLOUD_LIVE_ROOM_MIN_CELLS, "0");
    assert.equal(env.NOTEBOOK_CLOUD_LIVE_ROOM_REQUIRE_BLOB_FETCH, "0");
  });

  it("applies strict per-entry output expectations", () => {
    const env = smokeEnvForMatrixEntry(
      {
        url: "https://preview.runt.run/n/topic-viz/topic-viz",
        expectedText: "import plotly.graph_objects as go",
        expectedFrameTexts: ["PROBLEM_MARKDOWN"],
        minCells: 20,
        minVisibleIframes: 2,
        minImages: 3,
        requireBlobFetch: true,
        requireImagesLoaded: true,
      },
      {},
    );

    assert.equal(env.NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_TEXT, "import plotly.graph_objects as go");
    assert.equal(env.NOTEBOOK_CLOUD_LIVE_ROOM_EXPECTED_FRAME_TEXTS, '["PROBLEM_MARKDOWN"]');
    assert.equal(env.NOTEBOOK_CLOUD_LIVE_ROOM_MIN_CELLS, "20");
    assert.equal(env.NOTEBOOK_CLOUD_LIVE_ROOM_MIN_VISIBLE_IFRAMES, "2");
    assert.equal(env.NOTEBOOK_CLOUD_LIVE_ROOM_MIN_IMAGES, "3");
    assert.equal(env.NOTEBOOK_CLOUD_LIVE_ROOM_REQUIRE_BLOB_FETCH, "1");
    assert.equal(env.NOTEBOOK_CLOUD_LIVE_ROOM_REQUIRE_IMAGES_LOADED, "1");
  });

  it("derives stable labels and screenshot filenames", () => {
    const entry = { url: "https://preview.runt.run/n/01ABC/notebook" };

    assert.equal(entryLabel(entry, 0), "01ABC");
    assert.equal(safeScreenshotName("Topic Viz / Old Output", 2), "03-topic-viz-old-output.png");
  });

  it("builds ok:false reports for pre-summary failures", () => {
    const report = buildMatrixFailureReport(new Error("token expired"));

    assert.equal(report.ok, false);
    assert.equal(report.baseUrl, "https://preview.runt.run");
    assert.equal(report.source, "catalog");
    assert.equal(report.checked, 0);
    assert.equal(report.failed, 1);
    assert.deepEqual(report.results, []);
    assert.equal(report.error.name, "Error");
    assert.equal(report.error.message, "token expired");
  });
});
