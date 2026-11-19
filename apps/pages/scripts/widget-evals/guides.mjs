import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { outputDir, pages, origin } from "./shared.mjs";
const root = path.join(outputDir, "guides");
const old = "653657663",
  current = "a2e63d9cd",
  site = "https://page12.runtimed.run",
  frame = "https://page12-output.runtimed.run/frame/v2/";
if (process.env.EVAL_GUIDE === "module") {
  const dir = path.join(root, "module");
  await mkdir(dir, { recursive: true });
  for (const name of ["index", "views", "anywidget", "assets-and-sources", "vega-lite"]) {
    const pathname = name === "index" ? "/llms.txt" : `/llms/${name}.txt`;
    const response = await fetch(origin + pathname);
    if (!response.ok) throw Error(`Could not load ${pathname}: ${response.status}`);
    await writeFile(path.join(dir, name + ".txt"), await response.text());
  }
} else {
  for (const [arm, rev] of [
    ["old", old],
    ["new", current],
  ]) {
    await mkdir(path.join(root, arm), { recursive: true });
    const src = execFileSync(
      "git",
      ["-C", pages, "show", rev + ":apps/pages/agent-media-guides.mjs"],
      { encoding: "utf8" },
    ).replaceAll('from "./', 'from "' + pathToFileURL(pages).href + "/");
    const { mediaGuide, MEDIA_GUIDES } = await import(
      "data:text/javascript;base64," + Buffer.from(src).toString("base64")
    );
    for (const { path: p } of MEDIA_GUIDES) {
      const content = mediaGuide(p, site, arm === "new" ? { catalogEnabled: true } : frame);
      await writeFile(path.join(root, arm, path.basename(p)), content.replaceAll(site, origin));
    }
    const index = await fetch(origin + "/llms.txt");
    if (!index.ok) throw Error("Local celld unavailable");
    await writeFile(path.join(root, arm, "index.txt"), await index.text());
  }
}
