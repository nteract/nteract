import { cp } from "node:fs/promises";
import path from "node:path";

// celld runs a separate renderer-assets service. Main's compatibility routes
// redirect there, so only that service needs the stable and hashed sidecars.
// The original dist stays intact for Cloudflare's main-Worker fallback.
export async function copyCelldProjectAssets(worker, appDir, assetsDir) {
  const source = path.join(appDir, worker.assets);
  const plugins = path.join(source, "plugins");
  await cp(source, assetsDir, {
    recursive: true,
    dereference: true,
    filter: (file) => worker.name !== "main" || file !== plugins,
  });
}
