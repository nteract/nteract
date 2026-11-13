// The chart Worker: viewer/chart-pool.mjs hands it one job at a time and cuts
// it off when a job outlasts its timer. Built as its own classic script into
// public/chunks (scripts/build.mjs), so it loads under the viewer CSP's
// `script-src 'self'` in every engine, and served under its own CSP
// (shared/chart-worker-csp.mjs). It locks itself down before anything else
// evaluates (chart-worker-guard.mjs), and freezes its global before it reads
// a message.
import "./chart-worker-guard.mjs";
import { installTextMetrics, serveCharts } from "./chart-dataflow.mjs";
import { freezeScope } from "./chart-lockdown.mjs";

installTextMetrics(self);
freezeScope(self);
serveCharts(self);
