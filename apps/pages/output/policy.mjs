// The output Worker's fixed answers: its /health text and the frame CSP.
// They live beside output/worker.mjs, not in it, because that module is the
// Worker's entry and may export only its handler: workerd refuses an entry
// module with any other export.
import { PAGES_BUILD } from "../shared/build-identity.mjs";

// The bundle names its build: scripts/build.mjs defines __PAGES_BUILD__ as the
// build receipt's build_id, so a deployer can match the deployed shell to a
// package. Unbundled (scripts/output-smoke.mjs, unit tests) PAGES_BUILD is
// "dev" and /health reports the bare version, with no id.
export const HEALTH_TEXT =
  PAGES_BUILD === "dev" ? "pages-output-v2" : `pages-output-v2 ${PAGES_BUILD}`;

export const FRAME_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval' https: blob:",
  "style-src 'unsafe-inline' https:",
  "connect-src *",
  "img-src * data: blob:",
  "media-src * data: blob:",
  "font-src https: data:",
  "worker-src blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
