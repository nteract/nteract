import { createHash } from "node:crypto";
import { cp, readFile, readdir, unlink } from "node:fs/promises";
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
  if (worker.name !== "renderer-assets") return {};

  // Stable URLs remain valid through the generated celld Worker aliases. Work
  // from the copied bytes, so a source rebuild cannot invalidate this pairing.
  const entries = await readdir(assetsDir, { withFileTypes: true });
  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const aliases = {};
  for (const name of [...names].sort()) {
    const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{12,64})\.(js|css|wasm)$/.exec(name);
    if (!match) continue;
    const stable = `${match[1]}.${match[3]}`;
    if (!names.has(stable) || Object.hasOwn(aliases, stable)) continue;
    const [hashedBytes, stableBytes] = await Promise.all([
      readFile(path.join(assetsDir, name)),
      readFile(path.join(assetsDir, stable)),
    ]);
    if (
      !hashedBytes.equals(stableBytes) ||
      !createHash("sha256").update(hashedBytes).digest("hex").startsWith(match[2])
    )
      continue;
    aliases[stable] = name;
    await unlink(path.join(assetsDir, stable));
  }
  return aliases;
}
