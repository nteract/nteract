import { preparePackages } from "./packages.mjs";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = dirname(fileURLToPath(import.meta.resolve("pyodide")));
const lock = JSON.parse(await readFile(resolve(root, "runtime-lock.json"), "utf8"));
for (const [name, expected] of Object.entries(lock.assets)) {
  if (name === "sentinel.wasm") continue;
  const bytes = await readFile(resolve(runtime, name));
  if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
    throw new Error(`Pinned runtime asset differs: ${name}`);
  }
}
const loader = await readFile(resolve(runtime, "pyodide.mjs"), "utf8");
const embedded = [...loader.matchAll(/"(AGFzbQ[A-Za-z0-9+/=]+)"/g)];
if (embedded.length !== 1) throw new Error("Expected one pinned Wasm sentinel");
const sentinel = Buffer.from(embedded[0][1], "base64");
if (createHash("sha256").update(sentinel).digest("hex") !== lock.assets["sentinel.wasm"].sha256) {
  throw new Error("Pinned sentinel differs");
}
await mkdir(resolve(root, "dist"), { recursive: true });
await copyFile(resolve(runtime, "pyodide.asm.wasm"), resolve(root, "dist/pyodide.asm.wasm"));
await writeFile(resolve(root, "dist/sentinel.wasm"), sentinel);
const { wheels, libraries } = await preparePackages(root, runtime);
// Reuse the launcher's transport-independent traceback formatter, not a fork.
const launcher = new URL(
  "../../../python/nteract-kernel-launcher/nteract_kernel_launcher/",
  import.meta.url,
);
const bootstrap = { "__init__.py": "" };
for (const name of ["_traceback.py", "_redact.py"])
  bootstrap[name] = await readFile(new URL(name, launcher), "utf8");
await writeFile(resolve(root, "dist/bootstrap.json"), JSON.stringify(bootstrap));
await build({
  absWorkingDir: root,
  entryPoints: ["runtime/worker.js"],
  outfile: "dist/session.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: [
    "cloudflare:workers",
    "node:*",
    "./pyodide.asm.wasm",
    "./sentinel.wasm",
    "./library-*.wasm",
  ],
  loader: { ".zip": "binary", ".py": "text" },
  define: { process: "undefined", location: '"https://python-runtime.invalid/"' },
  inject: ["runtime/assets.js"],
  plugins: [
    {
      name: "pinned-sentinel",
      setup(builder) {
        builder.onResolve({ filter: /^nteract:python-bootstrap$/ }, () => ({
          path: "bootstrap",
          namespace: "bootstrap",
        }));
        builder.onLoad({ filter: /.*/, namespace: "bootstrap" }, () => ({
          contents: JSON.stringify(bootstrap),
          loader: "json",
        }));
        builder.onResolve({ filter: /^preview-python:packages$/ }, () => ({
          path: "packages",
          namespace: "packages",
        }));
        builder.onLoad({ filter: /.*/, namespace: "packages" }, () => ({
          contents:
            libraries
              .map((item, i) => "import m" + i + ' from "./' + item.filename + '";')
              .join("\n") +
            "export const wheels = " +
            JSON.stringify(
              wheels.map(({ name, version, filename, sha256 }) => ({
                name,
                version,
                filename,
                sha256,
              })),
            ) +
            ";\n" +
            "export const libraries = [" +
            libraries
              .map(
                (item, i) =>
                  "{path:" +
                  JSON.stringify(item.path) +
                  ", module:m" +
                  i +
                  ", sha256:" +
                  JSON.stringify(item.sha256) +
                  "}",
              )
              .join(",") +
            "];",
          loader: "js",
        }));
        builder.onResolve({ filter: /^preview-python:sentinel$/ }, () => ({
          path: "sentinel",
          namespace: "sentinel",
        }));
        builder.onLoad({ filter: /.*/, namespace: "sentinel" }, () => ({
          contents: sentinel,
          loader: "binary",
        }));
      },
    },
  ],
});

await writeFile(
  resolve(root, "dist/library-modules.js"),
  libraries.map((item, i) => `import b${i} from "./${item.filename}";`).join("\n") +
    "\nexport default {" +
    libraries.map((item, i) => JSON.stringify(item.filename) + ": { wasm: b" + i + " }").join(",") +
    "};\n",
);

await writeFile(
  resolve(root, "dist/package-assets.js"),
  wheels
    .map((entry, i) => `import b${i} from "../.scratch/packages/${entry.filename}";`)
    .join("\n") +
    "\nexport default {" +
    wheels.map((entry, i) => JSON.stringify(entry.filename) + ": b" + i).join(",") +
    "};\n",
);
