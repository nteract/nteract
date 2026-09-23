import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPyodide } from "pyodide";

// Package identity comes from the hash-verified Pyodide lock, not floating PyPI.
export async function preparePackages(root, runtime) {
  const lock = JSON.parse(await readFile(resolve(runtime, "pyodide-lock.json"), "utf8"));
  const selected = new Map();
  function visit(raw) {
    const name = raw.toLowerCase().replaceAll("_", "-");
    if (selected.has(name)) return;
    const entry = lock.packages[name];
    if (!entry) throw new Error(`Unknown pinned package: ${name}`);
    selected.set(name, entry);
    entry.depends.forEach(visit);
  }
  ["ipython", "pandas"].forEach(visit);
  const cache = resolve(root, ".scratch/packages");
  await mkdir(cache, { recursive: true });
  const wheels = [];
  for (const [name, entry] of selected) {
    const path = resolve(cache, entry.file_name);
    let bytes;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const response = await fetch(
        `https://cdn.jsdelivr.net/pyodide/v0.28.3/full/${entry.file_name}`,
        { signal: AbortSignal.timeout(60000) },
      );
      if (!response.ok) throw new Error(`Package download failed: ${name} (${response.status})`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error(`Package hash mismatch: ${name}`);
    await writeFile(path, bytes);
    wheels.push({ name, filename: entry.file_name, sha256: entry.sha256, bytes });
  }
  const python = await loadPyodide({ indexURL: runtime + "/" });
  for (const wheel of wheels)
    python.unpackArchive(new Uint8Array(wheel.bytes), "zip", { extractDir: "/packages" });
  const paths = JSON.parse(
    python.runPython(
      "import os, json\njson.dumps(sorted(os.path.join(d, n) for d, _, names in os.walk('/packages') for n in names if n.endswith('.so')))",
    ),
  );
  const libraries = [];
  for (const path of paths) {
    const bytes = python.FS.readFile(path);
    new WebAssembly.Module(bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const filename = `library-${hash}.wasm`;
    await writeFile(resolve(root, "dist", filename), bytes);
    libraries.push({ path, filename, sha256: hash, bytes });
  }
  await writeFile(
    resolve(root, "dist/packages.json"),
    JSON.stringify(
      wheels.map(({ bytes: _bytes, ...entry }) => entry),
      null,
      2,
    ),
  );
  return { wheels, libraries };
}
