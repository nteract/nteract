// The real chart Worker, started as it always starts, with code after it that
// tries every way out (chart-escapes.mjs). Built by the smoke; never part of
// the viewer build.
import "../../viewer/chart-worker.mjs";
import { answerEscapes } from "./chart-escapes.mjs";

answerEscapes(self);
