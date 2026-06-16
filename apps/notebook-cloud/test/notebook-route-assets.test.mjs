import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectMarkdownDocumentRouteAssets,
  collectNotebookRouteAssets,
  writeMarkdownDocumentRouteAssetsManifest,
  writeNotebookRouteAssetsManifest,
} from "../scripts/notebook-route-assets.mjs";

describe("notebook route asset manifest", () => {
  it("collects route-load chunks without pulling lazy output renderers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "notebook-cloud-route-assets-"));
    const assetsUrl = pathToFileURL(`${dir}/`);

    await writeFile(new URL("notebook-route-abc123.js", assetsUrl), "");
    await writeFile(new URL("notebook-route-abc123.css", assetsUrl), "");
    await writeFile(new URL("MarkdownText-def456.js", assetsUrl), "");
    await writeFile(new URL("markdown-ghi789.js", assetsUrl), "");
    await writeFile(new URL("markdown-document-route-doc001.js", assetsUrl), "");
    await writeFile(new URL("markdown-document-live-sync-doc002.js", assetsUrl), "");
    await writeFile(new URL("markdown-projection-doc003.js", assetsUrl), "");
    await writeFile(new URL("katex.min-jkl012.js", assetsUrl), "");
    await writeFile(new URL("katex-mno345.css", assetsUrl), "");
    await writeFile(new URL("plotly-pqr678.js", assetsUrl), "");
    await writeFile(new URL("notebook-cloud-viewer.js", assetsUrl), "");

    assert.deepEqual(await collectNotebookRouteAssets(assetsUrl), {
      modulepreload: [
        "notebook-route-abc123.js",
        "MarkdownText-def456.js",
        "markdown-ghi789.js",
        "katex.min-jkl012.js",
      ],
      stylepreload: ["notebook-route-abc123.css", "katex-mno345.css"],
    });
  });

  it("collects Markdown document route chunks without pulling the editor or live sync", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "notebook-cloud-markdown-route-assets-"));
    const assetsUrl = pathToFileURL(`${dir}/`);

    await writeFile(new URL("markdown-document-route-doc001.js", assetsUrl), "");
    await writeFile(new URL("markdown-document-live-sync-doc002.js", assetsUrl), "");
    await writeFile(new URL("markdown-projection-doc003.js", assetsUrl), "");
    await writeFile(new URL("codemirror-editor-doc004.js", assetsUrl), "");
    await writeFile(new URL("cloud-notebook-title-doc005.js", assetsUrl), "");
    await writeFile(new URL("cloud-response-doc006.js", assetsUrl), "");
    await writeFile(new URL("use-cloud-auth-doc007.js", assetsUrl), "");
    await writeFile(new URL("MarkdownText-def456.js", assetsUrl), "");
    await writeFile(new URL("katex.min-jkl012.js", assetsUrl), "");
    await writeFile(new URL("katex-mno345.css", assetsUrl), "");
    await writeFile(new URL("notebook-route-abc123.js", assetsUrl), "");

    assert.deepEqual(await collectMarkdownDocumentRouteAssets(assetsUrl), {
      modulepreload: [
        "markdown-document-route-doc001.js",
        "markdown-projection-doc003.js",
        "MarkdownText-def456.js",
        "katex.min-jkl012.js",
        "cloud-notebook-title-doc005.js",
        "cloud-response-doc006.js",
        "use-cloud-auth-doc007.js",
      ],
      stylepreload: ["katex-mno345.css"],
    });
  });

  it("writes a generated manifest beside the built viewer assets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "notebook-cloud-route-manifest-"));
    const assetsUrl = pathToFileURL(`${dir}/`);

    await writeFile(new URL("notebook-route-abc123.js", assetsUrl), "");
    await writeFile(new URL("katex.min-jkl012.js", assetsUrl), "");
    await writeFile(new URL("katex-mno345.css", assetsUrl), "");

    const { manifest, manifestUrl } = await writeNotebookRouteAssetsManifest(assetsUrl);
    const written = JSON.parse(await readFile(manifestUrl, "utf8"));

    assert.deepEqual(written, manifest);
    assert.deepEqual(written, {
      modulepreload: ["notebook-route-abc123.js", "katex.min-jkl012.js"],
      stylepreload: ["katex-mno345.css"],
    });
  });

  it("writes the Markdown document route manifest beside the built viewer assets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "notebook-cloud-markdown-route-manifest-"));
    const assetsUrl = pathToFileURL(`${dir}/`);

    await writeFile(new URL("markdown-document-route-doc001.js", assetsUrl), "");
    await writeFile(new URL("markdown-projection-doc003.js", assetsUrl), "");
    await writeFile(new URL("katex.min-jkl012.js", assetsUrl), "");
    await writeFile(new URL("katex-mno345.css", assetsUrl), "");

    const { manifest, manifestUrl } = await writeMarkdownDocumentRouteAssetsManifest(assetsUrl);
    const written = JSON.parse(await readFile(manifestUrl, "utf8"));

    assert.deepEqual(written, manifest);
    assert.deepEqual(written, {
      modulepreload: [
        "markdown-document-route-doc001.js",
        "markdown-projection-doc003.js",
        "katex.min-jkl012.js",
      ],
      stylepreload: ["katex-mno345.css"],
    });
  });

  it("keeps a split notebook-route stylesheet optional but preloaded when present", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "notebook-cloud-route-manifest-css-"));
    const assetsUrl = pathToFileURL(`${dir}/`);

    await writeFile(new URL("notebook-route-abc123.js", assetsUrl), "");
    await writeFile(new URL("notebook-route-abc123.css", assetsUrl), "");
    await writeFile(new URL("katex.min-jkl012.js", assetsUrl), "");
    await writeFile(new URL("katex-mno345.css", assetsUrl), "");

    const { manifest } = await writeNotebookRouteAssetsManifest(assetsUrl);

    assert.deepEqual(manifest, {
      modulepreload: ["notebook-route-abc123.js", "katex.min-jkl012.js"],
      stylepreload: ["notebook-route-abc123.css", "katex-mno345.css"],
    });
  });

  it("fails loudly when required route preload chunks are missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "notebook-cloud-route-manifest-missing-"));
    const assetsUrl = pathToFileURL(`${dir}/`);

    await writeFile(new URL("MarkdownText-def456.js", assetsUrl), "");
    await writeFile(new URL("markdown-ghi789.js", assetsUrl), "");

    await assert.rejects(
      writeNotebookRouteAssetsManifest(assetsUrl),
      /missing required route preload assets: notebook-route\.js, katex\.min\.js, katex\.css/,
    );
  });
});
