// The chart Worker: viewer/vega-chart.mjs starts one per chart and cuts it
// off when a draw outlasts its timer. Built as its own classic script into
// public/chunks (scripts/build.mjs), so it loads under the viewer CSP's
// `script-src 'self'` in every engine.
import { installTextMetrics, serveCharts } from "./chart-dataflow.mjs";

installTextMetrics(self);
serveCharts(self);
