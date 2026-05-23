import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export function loadRuntimedNode() {
  try {
    return require("@runtimed/node");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") {
      throw error;
    }
    return require(
      fileURLToPath(new URL("../../../packages/runtimed-node/src/index.cjs", import.meta.url)),
    );
  }
}
