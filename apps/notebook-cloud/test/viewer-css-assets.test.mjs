import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectViewerCssAssets, writeViewerCssManifest } from "../scripts/viewer-css-assets.mjs";

describe("viewer CSS asset manifest", () => {
  it("keeps the primary viewer stylesheet separate from supplemental lazy CSS", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "notebook-cloud-css-assets-"));
    const assetsUrl = pathToFileURL(`${dir}/`);

    await writeFile(new URL("notebook-cloud-viewer.css", assetsUrl), "");
    await writeFile(new URL("notebook-cloud-viewer2.css", assetsUrl), "");
    await writeFile(new URL("markdown-output.css", assetsUrl), "");
    await writeFile(new URL("notebook-cloud-viewer.js", assetsUrl), "");

    assert.deepEqual(await collectViewerCssAssets(assetsUrl), {
      primary: "/assets/notebook-cloud-viewer.css",
      supplemental: ["/assets/markdown-output.css", "/assets/notebook-cloud-viewer2.css"],
    });
  });

  it("writes a generated manifest beside the built viewer assets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "notebook-cloud-css-manifest-"));
    const assetsUrl = pathToFileURL(`${dir}/`);

    await writeFile(new URL("notebook-cloud-viewer.css", assetsUrl), "");
    await writeFile(new URL("notebook-cloud-viewer2.css", assetsUrl), "");

    const { manifest, manifestUrl } = await writeViewerCssManifest(assetsUrl);
    const written = JSON.parse(await readFile(manifestUrl, "utf8"));

    assert.deepEqual(written, manifest);
    assert.deepEqual(written, {
      primary: "/assets/notebook-cloud-viewer.css",
      supplemental: ["/assets/notebook-cloud-viewer2.css"],
    });
  });
});
