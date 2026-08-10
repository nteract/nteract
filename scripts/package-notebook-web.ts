import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const NOTEBOOK_WEB_MANIFEST = "notebook-web-manifest.json";
export const NOTEBOOK_WEB_CHECKSUMS = "SHA256SUMS";

type FileRecord = { path: string; bytes: number; sha256: string };

export type NotebookWebManifest = {
  schemaVersion: 1;
  kind: "nteract-notebook-web";
  version: string;
  channel: string;
  sourceRevision: string;
  entrypoint: "index.html";
  runtimeCompatibility: {
    daemonSourceRevision: string;
    rendererAssets: "embedded-in-runtimed";
    transport: "typed-frame-v4";
  };
  files: FileRecord[];
};

export type PackageNotebookWebOptions = {
  distDir: string;
  outputDir: string;
  sourceRevision: string;
  version: string;
  channel: string;
};

async function filesBelow(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(root, absolute)));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files;
}

async function record(root: string, relativePath: string): Promise<FileRecord> {
  const absolute = path.join(root, ...relativePath.split("/"));
  const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute)]);
  return {
    path: relativePath,
    bytes: info.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function assertArtifactShape(files: readonly string[]): void {
  if (!files.includes("index.html")) throw new Error("Notebook web build is missing index.html");
  if (!files.some((file) => file.endsWith(".wasm"))) {
    throw new Error("Notebook web build is missing its generated runtime WASM");
  }
  if (!files.some((file) => /^assets\/.+-[A-Za-z0-9_-]{6,}\.(?:js|css)$/.test(file))) {
    throw new Error("Notebook web build has no content-hashed JavaScript or CSS asset");
  }
}

export async function packageNotebookWeb(
  options: PackageNotebookWebOptions,
): Promise<NotebookWebManifest> {
  const sourceFiles = await filesBelow(options.distDir);
  assertArtifactShape(sourceFiles);

  await rm(options.outputDir, { recursive: true, force: true });
  await mkdir(path.dirname(options.outputDir), { recursive: true });
  await cp(options.distDir, options.outputDir, { recursive: true });

  const files = await Promise.all(sourceFiles.map((file) => record(options.outputDir, file)));
  const manifest: NotebookWebManifest = {
    schemaVersion: 1,
    kind: "nteract-notebook-web",
    version: options.version,
    channel: options.channel,
    sourceRevision: options.sourceRevision,
    entrypoint: "index.html",
    runtimeCompatibility: {
      daemonSourceRevision: options.sourceRevision,
      rendererAssets: "embedded-in-runtimed",
      transport: "typed-frame-v4",
    },
    files,
  };
  await writeFile(
    path.join(options.outputDir, NOTEBOOK_WEB_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const checksummedFiles = [...sourceFiles, NOTEBOOK_WEB_MANIFEST];
  const checksums = await Promise.all(
    checksummedFiles.map(async (file) => {
      const { sha256 } = await record(options.outputDir, file);
      return `${sha256}  ${file}`;
    }),
  );
  await writeFile(path.join(options.outputDir, NOTEBOOK_WEB_CHECKSUMS), `${checksums.join("\n")}\n`);
  return manifest;
}

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value) return value;
  if (fallback) return fallback;
  throw new Error(`Missing required ${name}`);
}

function gitRevision(): string {
  const explicit = process.env.NTERACT_BUILD_GIT_HASH?.trim();
  if (explicit) return explicit.slice(0, 7);
  return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
}

async function packageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(path.resolve("apps/notebook/package.json"), "utf8"),
  ) as { version: string };
  return packageJson.version;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputDir = path.resolve(argument("--output", "target/notebook-web"));
  const manifest = await packageNotebookWeb({
    distDir: path.resolve(argument("--dist", "apps/notebook/dist")),
    outputDir,
    sourceRevision: argument("--revision", gitRevision()),
    version: argument(
      "--version",
      process.env.NTERACT_NOTEBOOK_WEB_VERSION ?? (await packageVersion()),
    ),
    channel: argument("--channel", process.env.RUNT_BUILD_CHANNEL ?? "nightly"),
  });
  console.log(`Packaged ${manifest.files.length} notebook web files in ${outputDir}`);
}
