// Times a reload of a Page with a chart on its first screen, in Chromium:
// from navigation to the Page body visible, the chart chunk requested, the
// chart Worker ready (its `ready` and font probe answered), the chart's
// sources decoded (the chart mounts with its data) and the chart rendered.
// `workerCreated` and `posted` (the first draw job sent with its data) are
// reported beside them. Each reload runs with the browser cache on (warm) or disabled
// through the DevTools protocol (cold). The tab's stored documents stay in
// both. views-stored-smoke.mjs runs it when PAGES_CHART_START_RUNS is set.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** The milestones a reload reports, in path order. */
export const MILESTONES = Object.freeze(["body", "chunk", "worker", "decoded", "rendered"]);

/** The chunk under `dist/public/chunks` that holds the chart's page code. */
export async function chartChunkName(dist) {
  const dir = path.join(dist, "public/chunks");
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".js")) continue;
    if ((await readFile(path.join(dir, name), "utf8")).includes("This build has no chart Worker"))
      return name;
  }
  throw new Error("No chart chunk in this build");
}

// Runs in the page before its own scripts. Records each milestone once, in
// ms from navigation start.
const recorder = (bodyText) => {
  const times = {};
  const mark = (name) => {
    if (times[name] === undefined) times[name] = performance.now();
  };
  window.__chartStart = times;
  performance.setResourceTimingBufferSize?.(2000);
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(url, options) {
      super(url, options);
      if (options?.name !== "chart") return;
      mark("workerCreated");
      this.addEventListener("message", ({ data }) => {
        if (data?.type === "probed") mark("worker");
      });
    }
    postMessage(message, transfer) {
      if (message?.type === "draw" && message.datasets) mark("posted");
      return super.postMessage(message, transfer);
    }
  };
  const check = () => {
    if (
      times.body === undefined &&
      document.querySelector("wg-content")?.textContent?.includes(bodyText)
    )
      mark("body");
    if (document.querySelector("figure.pages-chart:not(.pages-view-placeholder)")) mark("decoded");
    if (document.querySelector("figure.pages-chart[data-chart-status=rendered]")) mark("rendered");
  };
  new MutationObserver(check).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-chart-status"],
    characterData: true,
  });
};

/** Install the recorder on `context`'s pages; `bodyText` marks the body. */
export const installRecorder = (context, bodyText) => context.addInitScript(recorder, bodyText);

/** Reload `page` once, `cold` with the cache disabled, and read its times. */
export async function timeReload(page, { cold, chunk }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: cold });
  await page.reload({ waitUntil: "commit" });
  await page.waitForFunction(() => window.__chartStart?.rendered !== undefined, null, {
    timeout: 30000,
  });
  const times = await page.evaluate((chunk) => {
    const entries = performance.getEntriesByType("resource");
    const first = (test) => entries.find((entry) => test(entry.name));
    const script = first((name) => name.endsWith(`/chunks/${chunk}`));
    const wasm = first((name) => /\/sift-[A-Z2-7]{8}\.wasm$/.test(name));
    return {
      ...window.__chartStart,
      chunk: script?.startTime,
      siftWasm: wasm?.startTime,
      // Script and WASM URLs this load requested more than once.
      repeated: entries
        .map((entry) => entry.name)
        .filter((name, i, names) => /\.(js|wasm)$/.test(name) && names.indexOf(name) !== i).length,
    };
  }, chunk);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  await cdp.detach();
  return Object.fromEntries(
    Object.entries(times).map(([key, value]) => [
      key,
      value === undefined ? null : Math.round(value),
    ]),
  );
}

/** Median, min and max of each milestone over `runs`. */
export function summarize(runs) {
  const keys = [...new Set(runs.flatMap((run) => Object.keys(run)))];
  return Object.fromEntries(
    keys.map((key) => {
      const values = runs
        .map((run) => run[key])
        .filter((value) => typeof value === "number")
        .sort((a, b) => a - b);
      if (!values.length) return [key, null];
      const middle = values.length >> 1;
      const median =
        values.length % 2 ? values[middle] : Math.round((values[middle - 1] + values[middle]) / 2);
      return [key, { median, min: values[0], max: values.at(-1), n: values.length }];
    }),
  );
}
