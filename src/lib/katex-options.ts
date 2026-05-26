import type { KatexOptions } from "katex";

// Prefer Jupyter/MathJax-style permissive rendering for user-authored math.
export const katexStrict = "ignore" satisfies NonNullable<KatexOptions["strict"]>;
