import type { StrictFunction } from "katex";

const SUPPRESSED_KATEX_STRICT_CODES = new Set(["newLineInDisplayMode"]);

export const katexStrict: StrictFunction = (errorCode) =>
  SUPPRESSED_KATEX_STRICT_CODES.has(errorCode) ? "ignore" : "warn";
