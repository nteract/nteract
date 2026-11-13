// A Worker with no lockdown that tries every way out (chart-escapes.mjs), so
// the smoke can show what the Worker's CSP closes on its own. Built by the
// smoke; never part of the viewer build.
import { answerEscapes } from "./chart-escapes.mjs";

answerEscapes(self);
