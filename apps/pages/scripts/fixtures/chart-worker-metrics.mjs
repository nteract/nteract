// The real chart Worker, started as it always starts, with a listener after
// it that measures text with Vega's own text metrics, as the Worker's layout
// does. Built by scripts/chart-smoke.mjs; never part of the viewer build.
import "../../viewer/chart-worker.mjs";
import * as vega from "vega";

self.addEventListener("message", ({ data }) => {
  if (data?.type === "measure")
    self.postMessage({
      type: "measured",
      widths: data.items.map(({ item, text }) => vega.textMetrics.width(item, text)),
    });
});
