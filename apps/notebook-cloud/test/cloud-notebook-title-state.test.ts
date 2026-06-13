import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudNotebookCatalogResponseTitle,
  cloudNotebookDocumentTitle,
  cloudNotebookTitleDisplay,
  cloudNotebookUrlAfterRename,
  type CloudNotebookRouteTitle,
} from "../viewer/cloud-notebook-title-state";

const fallbackTitle: CloudNotebookRouteTitle = {
  label: "Route Fallback",
  detail: null,
  title: "Route Fallback",
};

describe("cloud notebook title state", () => {
  it("uses the route fallback until authenticated catalog title data is loaded", () => {
    assert.deepEqual(cloudNotebookTitleDisplay(undefined, fallbackTitle), fallbackTitle);
  });

  it("projects loaded catalog titles and untitled notebooks for viewer chrome", () => {
    assert.deepEqual(cloudNotebookTitleDisplay("  Research Notes  ", fallbackTitle), {
      label: "Research Notes",
      detail: null,
      title: "Research Notes",
    });
    assert.equal(cloudNotebookTitleDisplay(null, fallbackTitle).label, "Untitled notebook");
    assert.equal(cloudNotebookTitleDisplay("   ", fallbackTitle).title, "Untitled notebook");
  });

  it("keeps the browser document title in the notebook title namespace", () => {
    assert.equal(cloudNotebookDocumentTitle("Research Notes"), "nteract notebook: Research Notes");
    assert.equal(cloudNotebookDocumentTitle("   "), "nteract notebook: Untitled notebook");
  });

  it("reads the catalog title only from the requested notebook row", () => {
    assert.equal(
      cloudNotebookCatalogResponseTitle(
        {
          notebook: {
            id: "demo",
            title: "Demo",
          },
        },
        "demo",
      ),
      "Demo",
    );

    assert.throws(
      () =>
        cloudNotebookCatalogResponseTitle(
          {
            notebook: {
              id: "other",
              title: "Wrong row",
            },
          },
          "demo",
        ),
      /response shape was invalid/,
    );
  });

  it("updates the vanity path after rename while preserving mode and hash", () => {
    assert.equal(
      cloudNotebookUrlAfterRename(
        "https://preview.runt.run/n/abc/old-title?mode=edit#intro",
        "https://worker.example/n/abc/New%20Title",
      ),
      "https://preview.runt.run/n/abc/New%20Title?mode=edit#intro",
    );
  });

  it("ignores non-notebook rename URLs", () => {
    assert.equal(
      cloudNotebookUrlAfterRename(
        "https://preview.runt.run/n/abc/old-title?mode=view",
        "https://worker.example/dashboard",
      ),
      "https://preview.runt.run/n/abc/old-title?mode=view",
    );
  });
});
