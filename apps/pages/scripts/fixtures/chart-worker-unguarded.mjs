// A chart Worker with every spec check and transform guard off, for
// scripts/chart-smoke.mjs: specs the checks would refuse run here until the
// page's timer cuts them off. Locked down as the real Worker is. Built by the
// smoke; never part of the viewer build.
import "../../viewer/chart-worker-guard.mjs";
import { installTextMetrics, serveCharts } from "../../viewer/chart-dataflow.mjs";
import { freezeScope } from "../../viewer/chart-lockdown.mjs";

installTextMetrics(self);
freezeScope(self);
serveCharts(self, { checkSpec: false, checkDataflow: false, guard: false });
