// The chart Worker with the recorder in front (chart-globals-recorder.mjs)
// and no lockdown: it draws what the page sends and, on `{ type: "recorded"
// }`, answers with every host name its code read. Built by the smoke; never
// part of the viewer build.
import { used } from "./chart-globals-recorder.mjs";
import { installTextMetrics, serveCharts } from "../../viewer/chart-dataflow.mjs";

installTextMetrics(self);
serveCharts(self);
self.addEventListener("message", ({ data }) => {
  if (data?.type === "recorded") self.postMessage({ type: "recorded", names: [...used].sort() });
});
