// The chart Worker's first import: it locks the Worker down
// (chart-lockdown.mjs) before Vega, Vega-Lite or anything else in the bundle
// evaluates, so no module can keep a reference to what it removes.
import { lockDown } from "./chart-lockdown.mjs";

lockDown(self);
