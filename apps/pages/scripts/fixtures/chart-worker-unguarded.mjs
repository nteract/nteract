// A chart Worker with every check and guard off, for scripts/chart-smoke.mjs:
// specs the checks would refuse run here until the page's timer cuts them off.
// Built by the smoke; never part of the viewer build.
import { installTextMetrics, serveCharts } from "../../viewer/chart-dataflow.mjs";

installTextMetrics(self);
serveCharts(self, { checkSpec: false, checkDataflow: false, guard: false });
