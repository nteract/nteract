import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLiveNotebookFixture } from "../scripts/live-notebook-fixture.mjs";

describe("live notebook fixture", () => {
  it("creates the MathNet live notebook through the expected session lifecycle", async () => {
    const calls = [];
    const session = {
      createCell: async (source, options) => calls.push(["createCell", source, options]),
      approveTrust: async () => calls.push(["approveTrust"]),
      syncEnvironment: async () => calls.push(["syncEnvironment"]),
      runCell: async (source, options) => calls.push(["runCell", source, options]),
    };
    const rt = {
      createNotebook: async (options) => {
        calls.push(["createNotebook", options]);
        return session;
      },
    };

    const result = await createLiveNotebookFixture(rt, { preset: "mathnet" });

    assert.equal(result, session);
    assert.deepEqual(
      calls.slice(0, 4).map(([name]) => name),
      ["createNotebook", "createCell", "approveTrust", "syncEnvironment"],
    );
    assert.deepEqual(calls[0][1].dependencies, [
      "polars",
      "pyarrow",
      "datasets",
      "pillow",
      "numpy",
      "matplotlib",
      "plotly",
    ]);

    const markdownCalls = calls.filter(([name]) => name === "createCell");
    const runCalls = calls.filter(([name]) => name === "runCell");
    assert.equal(markdownCalls.length, 10);
    assert.equal(runCalls.length, 9);
    assert.equal(markdownCalls[0][2].cellType, "markdown");
    assert.match(markdownCalls[0][1], /# MathNet topic visualization/);
    assert.match(markdownCalls[0][1], /## Loading the slice/);
    assert.match(markdownCalls.map(([, source]) => source).join("\n"), /## Topic hierarchy/);
    assert.match(markdownCalls.map(([, source]) => source).join("\n"), /## Treemap/);
    assert.match(
      markdownCalls.map(([, source]) => source).join("\n"),
      /## Where to take this next/,
    );
    assert.match(runCalls[0][1], /ShadenA\/MathNet/);
    assert.match(runCalls.map(([, source]) => source).join("\n"), /plotly\.graph_objects/);
    assert.match(runCalls.map(([, source]) => source).join("\n"), /matplotlib\.pyplot/);
    assert.equal(runCalls[0][2].timeoutMs, 10 * 60 * 1000);
  });

  it("shuts down the created notebook if fixture setup fails", async () => {
    const calls = [];
    const session = {
      createCell: async () => calls.push("createCell"),
      approveTrust: async () => calls.push("approveTrust"),
      syncEnvironment: async () => {
        calls.push("syncEnvironment");
        throw new Error("environment failed");
      },
      runCell: async () => calls.push("runCell"),
      shutdownNotebook: async () => calls.push("shutdownNotebook"),
      close: async () => calls.push("close"),
    };
    const rt = {
      createNotebook: async () => {
        calls.push("createNotebook");
        return session;
      },
    };

    await assert.rejects(
      () => createLiveNotebookFixture(rt, { preset: "mathnet" }),
      /environment failed/,
    );
    assert.deepEqual(calls, [
      "createNotebook",
      "createCell",
      "approveTrust",
      "syncEnvironment",
      "shutdownNotebook",
      "close",
    ]);
  });

  it("creates the lets-edit notebook as a lightweight markdown fixture", async () => {
    const calls = [];
    const session = {
      createCell: async (source, options) => calls.push(["createCell", source, options]),
    };
    const rt = {
      createNotebook: async (options) => {
        calls.push(["createNotebook", options]);
        return session;
      },
    };

    const result = await createLiveNotebookFixture(rt, { preset: "lets-edit" });

    assert.equal(result, session);
    assert.deepEqual(
      calls.map(([name]) => name),
      ["createNotebook", "createCell", "createCell", "createCell"],
    );
    assert.equal(calls[0][1].description, "notebook-cloud shared editing smoke");
    assert.equal(calls[1][2].cellType, "markdown");
    assert.match(calls[1][1], /# Let's edit/);
    assert.match(calls[2][1], /## Notes/);
    assert.match(calls[3][1], /## Scratch space/);
  });

  it("rejects unknown presets before creating a notebook", async () => {
    const rt = {
      createNotebook() {
        throw new Error("createNotebook should not be called for an unknown preset");
      },
    };

    await assert.rejects(
      () => createLiveNotebookFixture(rt, { preset: "unknown" }),
      /Unknown NOTEBOOK_CLOUD_LIVE_PRESET unknown/,
    );
  });
});
