/** Content receipts for generated assets. Vite supplies the resolved dependency
 * graph, including CSS dependencies; xtask checks these without loading Vite. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite-plus";

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(file);
      return /\.(ts|tsx|js|jsx|css|html|json)$/.test(entry.name) ? [file] : [];
    })
    .sort();
}

function readBytes(file: string, normalize: boolean): Buffer {
  const bytes = fs.readFileSync(file);
  return normalize && /\.(ts|tsx|js|jsx|css|html|json|yaml|toml)$/.test(file)
    ? Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"))
    : bytes;
}

export function digestFile(file: string, normalize = false): string {
  const hash = crypto.createHash("sha256");
  if (fs.statSync(file).isDirectory()) {
    for (const source of sourceFiles(file)) {
      hash.update(path.relative(file, source).split(path.sep).join("/")).update("\0");
      hash.update(readBytes(source, normalize)).update("\0");
    }
  } else hash.update(readBytes(file, normalize));
  return hash.digest("hex");
}

export function writeIfChanged(file: string, contents: string) {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === contents) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, file);
}

export function artifactInputs(root: string, extra: string[] = []) {
  const started = Date.now();
  const files = new Set(extra.map((file) => path.resolve(root, file)));
  if (fs.existsSync(path.join(root, "tsconfig.json"))) files.add(path.join(root, "tsconfig.json"));
  const plugin: Plugin = {
    name: "artifact-inputs",
    buildEnd(error) {
      if (error) return;
      for (const id of [...this.getModuleIds()]) {
        const file = id.split("?")[0];
        if (path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          // Package contents are represented by the lockfile. Keep receipts
          // portable across pnpm's platform-specific node_modules layout.
          if (!file.includes(`${path.sep}node_modules${path.sep}`)) {
            files.add(file);
            let dir = path.dirname(file);
            while (dir.startsWith(root) && dir !== root) {
              for (const name of ["package.json", "tsconfig.json"]) {
                const config = path.join(dir, name);
                if (fs.existsSync(config)) files.add(config);
              }
              dir = path.dirname(dir);
            }
          }
        }
      }
    },
  };
  function snapshot() {
    for (const input of files) {
      const paths = fs.statSync(input).isDirectory() ? sourceFiles(input) : [input];
      if (paths.some((file) => fs.statSync(file).mtimeMs > started)) {
        throw new Error(`Asset input changed during build: ${input}. Retry the build.`);
      }
    }
    return Object.fromEntries(
      [...files]
        .sort()
        .map((file) => [
          path.relative(root, file).split(path.sep).join("/"),
          digestFile(file, true),
        ]),
    );
  }
  return { plugin, snapshot };
}

export function writeArtifactReceipt(
  root: string,
  name: string,
  inputs: Record<string, string>,
  outputs: string[],
) {
  for (const [file, digest] of Object.entries(inputs)) {
    if (digestFile(path.join(root, file), true) !== digest) {
      throw new Error(`Asset input changed before publication: ${file}. Retry the build.`);
    }
  }
  const receipt = {
    version: 2,
    inputs,
    outputs: Object.fromEntries(outputs.map((file) => [file, digestFile(path.join(root, file))])),
  };
  writeIfChanged(
    path.join(root, "target/xtask", `${name}.inputs.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}
