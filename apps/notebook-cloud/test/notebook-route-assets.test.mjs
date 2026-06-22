import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectNotebookRouteAssets,
  writeNotebookRouteAssetsManifest,
} from "../scripts/notebook-route-assets.mjs";

describe("notebook route asset manifest", () => {
  it("collects route-load chunks without pulling lazy output renderers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "notebook-cloud-route-assets-"));
    const assetsUrl = pathToFileURL(`${dir}/`);

    await writeFile(new URL("notebook-route-CEuezVx_.js", assetsUrl), "");
    await writeFile(new URL("notebook-route-BlD6jbkE.css", assetsUrl), "");
    await writeFile(new URL("MarkdownText-BGIeLgzy.js", assetsUrl), "");
    await writeFile(new URL("markdown-CAXS4P_N.js", assetsUrl), "");
    await writeFile(new URL("markdown-output-lazy.js", assetsUrl), "");
    await writeFile(new URL("markdown-__esModule.js", assetsUrl), "");
    await writeFile(new URL("katex.min-CaqIvES0.js", assetsUrl), "");
    await writeFile(new URL("katex-D_EmowkL.css", assetsUrl), "");
    await writeFile(new URL("plotly-DPOVnGYq.js", assetsUrl), "");
    await writeFile(new URL("notebook-cloud-viewer.js", assetsUrl), "");

    assert.deepEqual(await collectNotebookRouteAssets(assetsUrl), {
      modulepreload: [
        "notebook-route-CEuezVx_.js",
        "MarkdownText-BGIeLgzy.js",
        "markdown-CAXS4P_N.js",
      ],
      stylepreload: ["notebook-route-BlD6jbkE.css"],
    });
  });

  it("writes a generated manifest beside the built viewer assets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "notebook-cloud-route-manifest-"));
    const assetsUrl = pathToFileURL(`${dir}/`);

    await writeFile(new URL("notebook-route-CEuezVx_.js", assetsUrl), "");
    await writeFile(new URL("notebook-route-BlD6jbkE.css", assetsUrl), "");
    await writeFile(new URL("MarkdownText-BGIeLgzy.js", assetsUrl), "");
    await writeFile(new URL("markdown-CAXS4P_N.js", assetsUrl), "");

    const { manifest, manifestUrl } = await writeNotebookRouteAssetsManifest(assetsUrl);
    const written = JSON.parse(await readFile(manifestUrl, "utf8"));

    assert.deepEqual(written, manifest);
    assert.deepEqual(written, {
      modulepreload: [
        "notebook-route-CEuezVx_.js",
        "MarkdownText-BGIeLgzy.js",
        "markdown-CAXS4P_N.js",
      ],
      stylepreload: ["notebook-route-BlD6jbkE.css"],
    });
  });

  it("fails loudly when required route preload chunks are missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "notebook-cloud-route-manifest-missing-"));
    const assetsUrl = pathToFileURL(`${dir}/`);

    await writeFile(new URL("MarkdownText-def456.js", assetsUrl), "");
    await writeFile(new URL("markdown-ghi789.js", assetsUrl), "");

    await assert.rejects(
      writeNotebookRouteAssetsManifest(assetsUrl),
      /missing required route preload assets: notebook-route\.js, notebook-route\.css/,
    );
  });
});
