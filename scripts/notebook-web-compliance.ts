import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type SpdxExpressionNode =
  | { license: string; exception?: string; plus?: boolean }
  | { left: SpdxExpressionNode; conjunction: "and" | "or"; right: SpdxExpressionNode };

const parseSpdxExpression = createRequire(import.meta.url)("spdx-expression-parse") as (
  expression: string,
) => SpdxExpressionNode;

export const NOTEBOOK_WEB_LICENSE = "LICENSE";
export const NOTEBOOK_WEB_NOTICES = "THIRD_PARTY_NOTICES.txt";
export const NOTEBOOK_WEB_SBOM = "notebook-web.spdx.json";
export const NOTEBOOK_WEB_BUILD_PROVENANCE = "notebook-web-build-provenance.json";

const SPDX_EXCLUDED_METADATA = [
  NOTEBOOK_WEB_SBOM,
  "notebook-web-manifest.json",
  "SHA256SUMS",
] as const;

const APPROVED_LICENSE_IDS = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "OFL-1.1",
  "Unicode-3.0",
  "Unlicense",
  "Zlib",
]);

const OPAQUE_RENDERER_COMPONENTS: Record<string, readonly string[]> = {
  "isolated-renderer.css": ["nteract"],
  "isolated-renderer.js": ["nteract"],
  "markdown.css": ["nteract", "katex", "react-markdown"],
  "markdown.js": ["nteract", "katex", "react-markdown"],
  "plotly.js": ["nteract", "plotly.js-dist-min"],
  "bokeh.js": ["nteract"],
  "panel.js": ["nteract"],
  "vega.js": ["nteract", "vega", "vega-embed", "vega-lite"],
  "leaflet.css": ["nteract", "leaflet"],
  "leaflet.js": ["nteract", "leaflet"],
  "sift.css": ["nteract", "@nteract/sift"],
  "sift.js": ["nteract", "@nteract/sift"],
};

export function opaqueRendererAssetNames(): string[] {
  return Object.keys(OPAQUE_RENDERER_COMPONENTS).sort();
}

const LICENSE_SOURCE_PACKAGE_OVERRIDES: Record<string, string> = {
  "react-remove-scroll-bar": "react-remove-scroll",
  "vega-functions": "vega",
  "vega-interpreter": "vega",
  "vega-selections": "vega",
};

const LICENSE_FILE_OVERRIDES: Record<string, string> = {
  "@uiw/react-json-view": "uiwjs-react-json-view-MIT.txt",
  "ansi-to-react": "ansi-to-react-BSD-3-Clause.txt",
  "rehype-katex": "remark-math-MIT.txt",
  "remark-math": "remark-math-MIT.txt",
};

const NOTEBOOK_BUILD_INPUTS = new Set(["@tailwindcss/vite", "tailwindcss", "tw-animate-css"]);

const REQUIRED_NPM_COMPONENTS = [
  "@chenglou/pretext",
  "@codemirror/lang-yaml",
  "@dnd-kit/core",
  "@dnd-kit/sortable",
  "@dnd-kit/utilities",
  "@lezer/yaml",
  "@nteract/notebook-host",
  "@nteract/odometer",
  "@nteract/sift",
  "@tauri-apps/api",
  "@tauri-apps/plugin-dialog",
  "@tauri-apps/plugin-log",
  "@tauri-apps/plugin-process",
  "@tauri-apps/plugin-shell",
  "@tauri-apps/plugin-updater",
  "leaflet",
  "lezer-toml",
  "plotly.js-dist-min",
  "rxjs",
  "runtimed",
  "vega",
  "vega-embed",
  "vega-lite",
] as const;

export function requiredNotebookNpmComponents(): readonly string[] {
  return REQUIRED_NPM_COMPONENTS;
}

export function assertRequiredNotebookNpmComponents(componentNames: Iterable<string>): void {
  const names = new Set(componentNames);
  const missing = REQUIRED_NPM_COMPONENTS.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Notebook npm and renderer license closure is incomplete: ${missing.join(", ")}`);
  }
}

export function pnpmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "pnpm.cmd" : "pnpm";
}

type LicenseText = { name: string; text: string };

export type ComplianceComponent = {
  ecosystem: "asset" | "cargo" | "npm";
  scope: "asset" | "build" | "runtime";
  name: string;
  version: string;
  licenseDeclared: string;
  licenseTexts: LicenseText[];
  homepage?: string;
};

export type OpaqueRendererAsset = {
  path: string;
  bytes: number;
  sha256: string;
  components: readonly string[];
  outputs: Array<{ path: string; sha256: string }>;
};

export type ShippedWebFile = {
  path: string;
  bytes: number;
  sha1: string;
  sha256: string;
};

type PnpmLicenseRecord = {
  name: string;
  versions: string[];
  paths: string[];
  license?: string;
  homepage?: string;
};

type BuildProvenance = {
  schemaVersion: 1;
  inputs: Array<{
    path: string;
    sha256: string;
    outputs: Array<{ path: string; sha256: string }>;
  }>;
};

type CargoMetadata = {
  packages: Array<{
    id: string;
    name: string;
    version: string;
    license: string | null;
    homepage: string | null;
    repository: string | null;
    manifest_path: string;
  }>;
  resolve: {
    nodes: Array<{
      id: string;
      deps: Array<{ pkg: string; dep_kinds: Array<{ kind: string | null }> }>;
    }>;
  };
};

type SpdxPackage = {
  SPDXID: string;
  name: string;
  versionInfo: string;
  downloadLocation: "NOASSERTION";
  filesAnalyzed: boolean;
  packageVerificationCode?: {
    packageVerificationCodeValue: string;
    packageVerificationCodeExcludedFiles: string[];
  };
  licenseConcluded: string;
  licenseDeclared: string;
  copyrightText: string;
  externalRefs: Array<{
    referenceCategory: "PACKAGE-MANAGER";
    referenceType: "purl";
    referenceLocator: string;
  }>;
};

type SpdxFile = {
  SPDXID: string;
  fileName: string;
  checksums: [
    { algorithm: "SHA1"; checksumValue: string },
    { algorithm: "SHA256"; checksumValue: string },
  ];
  licenseConcluded: "NOASSERTION";
  copyrightText: "NOASSERTION";
};

export type NotebookWebSpdxDocument = {
  spdxVersion: "SPDX-2.3";
  dataLicense: "CC0-1.0";
  SPDXID: "SPDXRef-DOCUMENT";
  name: string;
  documentNamespace: string;
  creationInfo: {
    created: string;
    creators: ["Tool: nteract-notebook-web-compliance"];
  };
  documentDescribes: ["SPDXRef-Package-notebook-web"];
  packages: SpdxPackage[];
  files: SpdxFile[];
  relationships: Array<{
    spdxElementId: string;
    relationshipType: "BUILD_DEPENDENCY_OF" | "CONTAINS" | "DEPENDS_ON";
    relatedSpdxElement: string;
  }>;
  annotations: Array<{
    annotationDate: string;
    annotationType: "OTHER";
    annotator: "Tool: nteract-notebook-web-compliance";
    comment: string;
  }>;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha1(value: string | Uint8Array): string {
  return createHash("sha1").update(value).digest("hex");
}

function normalizedLicenseExpression(expression: string): string {
  return expression
    .replaceAll("Apache-2.0/MIT", "Apache-2.0 OR MIT")
    .replaceAll("MIT/Apache-2.0", "MIT OR Apache-2.0")
    .trim();
}

export function validateLicenseExpression(expression: string): string {
  const normalized = normalizedLicenseExpression(expression);
  let parsed: SpdxExpressionNode;
  try {
    parsed = parseSpdxExpression(normalized);
  } catch (error) {
    throw new Error(`Invalid SPDX license expression ${JSON.stringify(expression)}`, {
      cause: error,
    });
  }
  const licenses: string[] = [];
  const visit = (node: SpdxExpressionNode): void => {
    if ("license" in node) {
      licenses.push(node.license);
      if (node.exception || node.plus) licenses.push(node.exception ?? `${node.license}+`);
      return;
    }
    visit(node.left);
    visit(node.right);
  };
  visit(parsed);
  const unknown = licenses.filter((identifier) => !APPROVED_LICENSE_IDS.has(identifier));
  if (unknown.length > 0) {
    throw new Error(
      `Unapproved or unknown license expression ${JSON.stringify(expression)} (${unknown.join(", ")})`,
    );
  }
  return normalized;
}

async function licenseFilesBelow(packageRoot: string): Promise<LicenseText[]> {
  const entries = await readdir(packageRoot, { withFileTypes: true });
  const filenames = entries
    .filter(
      (entry) =>
        entry.isFile() && /^(?:licen[cs]e|copying|notice|unlicense)/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(
    filenames.map(async (name) => ({
      name,
      text: (await readFile(path.join(packageRoot, name), "utf8")).trim(),
    })),
  );
}

async function npmLicenseTexts(
  component: { name: string; packageRoot: string },
  packageRoots: ReadonlyMap<string, string>,
  repoRoot: string,
): Promise<LicenseText[]> {
  let texts = await licenseFilesBelow(component.packageRoot);
  if (texts.length > 0) return texts;

  const sourceName = component.name.startsWith("@radix-ui/")
    ? "@radix-ui/react-accordion"
    : LICENSE_SOURCE_PACKAGE_OVERRIDES[component.name];
  if (sourceName) {
    const sourceRoot = packageRoots.get(sourceName);
    if (!sourceRoot) {
      throw new Error(`License source package ${sourceName} is unavailable for ${component.name}`);
    }
    texts = await licenseFilesBelow(sourceRoot);
    if (texts.length > 0) {
      return texts.map((license) => ({ ...license, name: `${license.name} (from ${sourceName})` }));
    }
  }

  const override = LICENSE_FILE_OVERRIDES[component.name];
  if (override) {
    const text = await readFile(path.join(repoRoot, "scripts/license-overrides", override), "utf8");
    return [{ name: `${override} (reviewed override)`, text: text.trim() }];
  }

  throw new Error(`No license text or reviewed override for npm package ${component.name}`);
}

type NpmPackageRecord = {
  name: string;
  version: string;
  license: string;
  homepage?: string;
  packageRoot: string;
};

async function pnpmLicenseRecords(
  repoRoot: string,
  workspaceFilter: string,
  prod: boolean,
): Promise<NpmPackageRecord[]> {
  const output = execFileSync(
    pnpmExecutable(),
    [
      "--filter",
      workspaceFilter,
      "licenses",
      "list",
      ...(prod ? ["--prod"] : []),
      "--json",
      "--long",
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const grouped = JSON.parse(output) as Record<string, PnpmLicenseRecord[]>;
  const records = Object.entries(grouped).flatMap(([license, packages]) =>
    packages.flatMap((entry) => entry.paths.map((packageRoot) => ({ ...entry, packageRoot, license }))),
  );

  const packageRecords = new Map<string, NpmPackageRecord>();
  for (const record of records) {
    const packageJson = JSON.parse(
      await readFile(path.join(record.packageRoot, "package.json"), "utf8"),
    ) as { name?: string; version?: string; license?: string; homepage?: string };
    if (!packageJson.name || !packageJson.version) {
      throw new Error(`Invalid package metadata under ${record.packageRoot}`);
    }
    const license = packageJson.license ?? record.license;
    packageRecords.set(`${packageJson.name}@${packageJson.version}`, {
      name: packageJson.name,
      version: packageJson.version,
      license,
      homepage: packageJson.homepage ?? record.homepage,
      packageRoot: record.packageRoot,
    });
  }
  return [...packageRecords.values()];
}

type PnpmWorkspaceRecord = { name?: string; version?: string; path: string };

async function collectWorkspaceNpmComponents(repoRoot: string): Promise<ComplianceComponent[]> {
  const output = execFileSync(
    pnpmExecutable(),
    ["list", "--recursive", "--depth", "-1", "--json"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const workspaces = JSON.parse(output) as PnpmWorkspaceRecord[];
  const workspaceByName = new Map(
    workspaces
      .filter((workspace): workspace is Required<PnpmWorkspaceRecord> =>
        Boolean(workspace.name && workspace.version),
      )
      .map((workspace) => [workspace.name, workspace]),
  );
  const entryManifests = [
    path.join(repoRoot, "package.json"),
    path.join(repoRoot, "apps/notebook/package.json"),
  ];
  const pending: string[] = [];
  for (const manifestPath of entryManifests) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (workspaceByName.has(name)) pending.push(name);
    }
  }

  const seen = new Set<string>();
  const manifests = new Map<string, Required<PnpmWorkspaceRecord> & { license?: string }>();
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const workspace = workspaceByName.get(name);
    if (!workspace) throw new Error(`Workspace package ${name} is unavailable`);
    const resolvedRoot = path.resolve(workspace.path);
    if (resolvedRoot !== repoRoot && !resolvedRoot.startsWith(`${repoRoot}${path.sep}`)) {
      throw new Error(`Workspace package ${name} resolves outside the repository`);
    }
    const manifest = JSON.parse(await readFile(path.join(resolvedRoot, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
      license?: string;
      dependencies?: Record<string, string>;
    };
    if (manifest.name !== name || !manifest.version) {
      throw new Error(`Invalid workspace package metadata for ${name}`);
    }
    manifests.set(name, { ...workspace, version: manifest.version, license: manifest.license });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (workspaceByName.has(dependency)) pending.push(dependency);
    }
  }

  const rootLicense = (await readFile(path.join(repoRoot, "LICENSE"), "utf8")).trim();
  return [...manifests.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((workspace) => ({
      ecosystem: "npm" as const,
      scope: "runtime" as const,
      name: workspace.name,
      version: workspace.version,
      licenseDeclared: validateLicenseExpression(workspace.license ?? "BSD-3-Clause"),
      licenseTexts: [{ name: "LICENSE (workspace root)", text: rootLicense }],
      homepage: "https://github.com/nteract/nteract",
    }));
}

async function collectNpmComponents(repoRoot: string): Promise<ComplianceComponent[]> {
  const [notebookRecords, sharedSourceRecords, rendererRecords, allNotebookRecords, workspaceComponents] =
    await Promise.all([
      pnpmLicenseRecords(repoRoot, "notebook-ui", true),
      pnpmLicenseRecords(repoRoot, ".", true),
      pnpmLicenseRecords(repoRoot, "@nteract/sift", true),
      pnpmLicenseRecords(repoRoot, "notebook-ui", false),
      collectWorkspaceNpmComponents(repoRoot),
    ]);
  const runtimeRecords = [...notebookRecords, ...sharedSourceRecords, ...rendererRecords];
  const allRecords = [...runtimeRecords, ...allNotebookRecords];
  const runtimeNames = new Set([
    ...runtimeRecords.map((record) => record.name),
    ...workspaceComponents.map((component) => component.name),
  ]);

  const packageRoots = new Map(allRecords.map((record) => [record.name, record.packageRoot]));
  const selected = new Map<string, NpmPackageRecord>();
  for (const record of runtimeRecords) selected.set(`${record.name}@${record.version}`, record);
  for (const record of allRecords) {
    if (NOTEBOOK_BUILD_INPUTS.has(record.name)) {
      selected.set(`${record.name}@${record.version}`, record);
    }
  }
  const missingBuildInputs = [...NOTEBOOK_BUILD_INPUTS].filter(
    (name) => ![...selected.values()].some((record) => record.name === name),
  );
  if (missingBuildInputs.length > 0) {
    throw new Error(`Notebook CSS build provenance is incomplete: ${missingBuildInputs.join(", ")}`);
  }

  const registryComponents = await Promise.all(
    [...selected.values()]
      .sort((left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
      )
      .map(async (record) => ({
        ecosystem: "npm" as const,
        scope: runtimeNames.has(record.name) ? ("runtime" as const) : ("build" as const),
        name: record.name,
        version: record.version,
        licenseDeclared: validateLicenseExpression(record.license),
        licenseTexts: await npmLicenseTexts(record, packageRoots, repoRoot),
        homepage: record.homepage,
      })),
  );
  const components = [...registryComponents, ...workspaceComponents];
  assertRequiredNotebookNpmComponents(components.map((component) => component.name));
  return components;
}

async function cargoLicenseTexts(
  manifestPath: string,
  repoRoot: string,
): Promise<LicenseText[]> {
  const packageRoot = path.dirname(manifestPath);
  let texts = await licenseFilesBelow(packageRoot);
  if (texts.length > 0) return texts;

  if (packageRoot === repoRoot || packageRoot.startsWith(`${repoRoot}${path.sep}`)) {
    const text = await readFile(path.join(repoRoot, "LICENSE"), "utf8");
    return [{ name: "LICENSE (workspace root)", text: text.trim() }];
  }

  let candidate = path.dirname(packageRoot);
  for (let depth = 0; depth < 5; depth += 1) {
    texts = await licenseFilesBelow(candidate);
    if (texts.length > 0) {
      return texts.map((license) => ({ ...license, name: `${license.name} (source root)` }));
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`No license text available for Cargo package at ${manifestPath}`);
}

async function collectCargoComponents(repoRoot: string): Promise<ComplianceComponent[]> {
  const output = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked", "--filter-platform", "wasm32-unknown-unknown"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const metadata = JSON.parse(output) as CargoMetadata;
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const root = metadata.packages.find((pkg) => pkg.name === "runtimed-wasm");
  if (!root) throw new Error("Cargo metadata has no runtimed-wasm package");

  const seen = new Set<string>();
  const pending = [root.id];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dependency of nodes.get(id)?.deps ?? []) {
      if (dependency.dep_kinds.some((kind) => kind.kind !== "dev")) pending.push(dependency.pkg);
    }
  }

  return Promise.all(
    [...seen]
      .map((id) => packages.get(id))
      .filter((pkg): pkg is NonNullable<typeof pkg> => pkg !== undefined)
      .sort((left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
      )
      .map(async (pkg) => {
        if (!pkg.license) throw new Error(`Cargo package ${pkg.name}@${pkg.version} has no license metadata`);
        return {
          ecosystem: "cargo" as const,
          scope: "runtime" as const,
          name: pkg.name,
          version: pkg.version,
          licenseDeclared: validateLicenseExpression(pkg.license),
          licenseTexts: await cargoLicenseTexts(pkg.manifest_path, repoRoot),
          homepage: pkg.homepage ?? pkg.repository ?? undefined,
        };
      }),
  );
}

function assertSafeRelativePath(filename: string): void {
  if (
    filename.length === 0 ||
    path.isAbsolute(filename) ||
    filename.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe release provenance path ${JSON.stringify(filename)}`);
  }
}

export async function collectOpaqueRendererAssets(
  repoRoot: string,
  outputDir: string,
): Promise<OpaqueRendererAsset[]> {
  const rendererRoot = path.join(repoRoot, "apps/notebook/src/renderer-plugins");
  const provenance = JSON.parse(
    await readFile(path.join(outputDir, NOTEBOOK_WEB_BUILD_PROVENANCE), "utf8"),
  ) as BuildProvenance;
  if (provenance.schemaVersion !== 1 || !Array.isArray(provenance.inputs)) {
    throw new Error("Notebook web build provenance is invalid");
  }
  const provenanceByPath = new Map(provenance.inputs.map((input) => [input.path, input]));
  return Promise.all(
    Object.entries(OPAQUE_RENDERER_COMPONENTS)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([filename, components]) => {
        const absolute = path.join(rendererRoot, filename);
        let bytes: Uint8Array;
        try {
          bytes = await readFile(absolute);
        } catch (error) {
          throw new Error(`Missing opaque renderer asset ${filename}`, { cause: error });
        }
        if (bytes.byteLength === 0 || new TextDecoder().decode(bytes.subarray(0, 80)).startsWith("version https://git-lfs.github.com/spec/")) {
          throw new Error(`Opaque renderer asset ${filename} has no release payload`);
        }
        const sourcePath = `apps/notebook/src/renderer-plugins/${filename}`;
        const sourceSha256 = sha256(bytes);
        const buildInput = provenanceByPath.get(sourcePath);
        if (!buildInput || buildInput.sha256 !== sourceSha256 || buildInput.outputs.length === 0) {
          throw new Error(`Opaque renderer build provenance is stale or missing for ${filename}`);
        }
        const outputs = await Promise.all(
          buildInput.outputs.map(async (output) => {
            assertSafeRelativePath(output.path);
            const outputBytes = await readFile(
              path.join(outputDir, ...output.path.split(/[\\/]/)),
            );
            const outputSha256 = sha256(outputBytes);
            if (output.sha256 !== outputSha256) {
              throw new Error(`Opaque renderer output provenance is stale for ${output.path}`);
            }
            return { path: output.path, sha256: outputSha256 };
          }),
        );
        return {
          path: sourcePath,
          bytes: bytes.byteLength,
          sha256: sourceSha256,
          components,
          outputs,
        };
      }),
  );
}

async function filesBelow(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(root, absolute)));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error(`Release artifact contains non-regular entry ${path.relative(root, absolute)}`);
  }
  return files;
}

export async function collectShippedWebFiles(outputDir: string): Promise<ShippedWebFile[]> {
  const paths = (await filesBelow(outputDir)).filter(
    (filename) => !SPDX_EXCLUDED_METADATA.includes(filename as (typeof SPDX_EXCLUDED_METADATA)[number]),
  );
  return Promise.all(
    paths.map(async (filename) => {
      const absolute = path.join(outputDir, ...filename.split("/"));
      const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute)]);
      return { path: filename, bytes: info.size, sha1: sha1(bytes), sha256: sha256(bytes) };
    }),
  );
}

function componentId(component: ComplianceComponent): string {
  const key = `${component.ecosystem}:${component.name}@${component.version}`;
  return `SPDXRef-Package-${component.ecosystem}-${sha256(key).slice(0, 16)}`;
}

function fileId(file: ShippedWebFile): string {
  return `SPDXRef-File-${sha256(file.path).slice(0, 16)}`;
}

function packageUrl(component: ComplianceComponent): string {
  if (component.ecosystem === "cargo") {
    return `pkg:cargo/${encodeURIComponent(component.name)}@${encodeURIComponent(component.version)}`;
  }
  if (component.ecosystem === "asset") {
    return `pkg:generic/${encodeURIComponent(component.name)}@${encodeURIComponent(component.version)}`;
  }
  const npmName = component.name.startsWith("@")
    ? `%40${component.name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(component.name);
  return `pkg:npm/${npmName}@${encodeURIComponent(component.version)}`;
}

function copyrightText(component: ComplianceComponent): string {
  const lines = component.licenseTexts.flatMap((license) =>
    license.text
      .split(/\r?\n/)
      .filter((line) => /copyright|all rights reserved/i.test(line.trim())),
  );
  return [...new Set(lines)].join("\n") || "NOASSERTION";
}

function creationDate(): string {
  const seconds = Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? "0", 10);
  return new Date(Number.isFinite(seconds) ? seconds * 1000 : 0).toISOString().replace(".000Z", "Z");
}

export function buildSpdxDocument(options: {
  components: ComplianceComponent[];
  opaqueRendererAssets: OpaqueRendererAsset[];
  shippedWebFiles: ShippedWebFile[];
  sourceRevision: string;
  version: string;
}): NotebookWebSpdxDocument {
  const created = creationDate();
  const packages: SpdxPackage[] = [
    {
      SPDXID: "SPDXRef-Package-notebook-web",
      name: "nteract-notebook-web",
      versionInfo: options.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: true,
      packageVerificationCode: {
        packageVerificationCodeValue: sha1(
          options.shippedWebFiles
            .map((file) => file.sha1)
            .sort()
            .join(""),
        ),
        packageVerificationCodeExcludedFiles: [...SPDX_EXCLUDED_METADATA],
      },
      licenseConcluded: "BSD-3-Clause",
      licenseDeclared: "BSD-3-Clause",
      copyrightText: "Copyright (c) 2024, runtimed",
      externalRefs: [],
    },
    ...options.components.map((component) => ({
      SPDXID: componentId(component),
      name: component.name,
      versionInfo: component.version,
      downloadLocation: "NOASSERTION" as const,
      filesAnalyzed: false as const,
      licenseConcluded: component.licenseDeclared,
      licenseDeclared: component.licenseDeclared,
      copyrightText: copyrightText(component),
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER" as const,
          referenceType: "purl" as const,
          referenceLocator: packageUrl(component),
        },
      ],
    })),
  ];
  const files: SpdxFile[] = options.shippedWebFiles.map((file) => ({
    SPDXID: fileId(file),
    fileName: file.path,
    checksums: [
      { algorithm: "SHA1", checksumValue: file.sha1 },
      { algorithm: "SHA256", checksumValue: file.sha256 },
    ],
    licenseConcluded: "NOASSERTION",
    copyrightText: "NOASSERTION",
  }));
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `nteract-notebook-web-${options.version}`,
    documentNamespace: `https://github.com/nteract/nteract/notebook-web/${encodeURIComponent(options.version)}/${encodeURIComponent(options.sourceRevision)}`,
    creationInfo: {
      created,
      creators: ["Tool: nteract-notebook-web-compliance"],
    },
    documentDescribes: ["SPDXRef-Package-notebook-web"],
    packages,
    files,
    relationships: [
      ...options.components.map((component) =>
        component.scope === "build"
          ? {
              spdxElementId: componentId(component),
              relationshipType: "BUILD_DEPENDENCY_OF" as const,
              relatedSpdxElement: "SPDXRef-Package-notebook-web",
            }
          : {
              spdxElementId: "SPDXRef-Package-notebook-web",
              relationshipType: "DEPENDS_ON" as const,
              relatedSpdxElement: componentId(component),
            },
      ),
      ...options.shippedWebFiles.map((file) => ({
        spdxElementId: "SPDXRef-Package-notebook-web",
        relationshipType: "CONTAINS" as const,
        relatedSpdxElement: fileId(file),
      })),
    ],
    annotations: [
      {
        annotationDate: created,
        annotationType: "OTHER",
        annotator: "Tool: nteract-notebook-web-compliance",
        comment: `Opaque renderer build inputs: ${JSON.stringify(options.opaqueRendererAssets)}`,
      },
    ],
  };
}

export function buildThirdPartyNotices(
  components: ComplianceComponent[],
  opaqueRendererAssets: OpaqueRendererAsset[],
): string {
  const sections = [
    "NTERACT NOTEBOOK WEB THIRD-PARTY NOTICES",
    "",
    "This conservative inventory covers the notebook-ui production npm dependency closure, explicit CSS build inputs, the non-dev runtimed-wasm Cargo dependency closure, shipped asset license families, and the opaque renderer build inputs listed below.",
    "",
    "OPAQUE RENDERER BUILD INPUTS",
    ...opaqueRendererAssets.map(
      (asset) =>
        `${asset.path}  ${asset.sha256}  ${asset.bytes} bytes  components=${asset.components.join(",")}  outputs=${asset.outputs.map((output) => `${output.path}:${output.sha256}`).join(",")}`,
    ),
    "",
  ];
  for (const component of components) {
    sections.push(
      `================================================================================`,
      `${component.ecosystem}:${component.name}@${component.version}`,
      `Scope: ${component.scope}`,
      `Declared license: ${component.licenseDeclared}`,
    );
    if (component.homepage) sections.push(`Homepage: ${component.homepage}`);
    for (const license of component.licenseTexts) {
      sections.push("", `--- ${license.name} ---`, license.text);
    }
    sections.push("");
  }
  return `${sections.join("\n").trimEnd()}\n`;
}

async function collectAssetComponents(
  repoRoot: string,
  outputDir: string,
  npmComponents: ComplianceComponent[],
): Promise<ComplianceComponent[]> {
  const shippedPaths = await filesBelow(outputDir);
  if (!shippedPaths.some((filename) => /\/KaTeX_.+\.(?:ttf|woff2?)$/.test(filename))) {
    throw new Error("Notebook Web build is missing its KaTeX font assets");
  }
  const katex = npmComponents.find((component) => component.name === "katex");
  if (!katex) throw new Error("Notebook runtime license closure is missing KaTeX");
  const ofl = await readFile(
    path.join(repoRoot, "scripts/license-overrides/katex-fonts-OFL-1.1.txt"),
    "utf8",
  );
  return [
    {
      ecosystem: "asset",
      scope: "asset",
      name: "KaTeX-fonts",
      version: katex.version,
      licenseDeclared: "OFL-1.1",
      licenseTexts: [{ name: "OFL-1.1 (KaTeX font assets)", text: ofl.trim() }],
      homepage: `https://github.com/KaTeX/KaTeX/tree/v${katex.version}/src/fonts`,
    },
  ];
}

export async function generateNotebookWebCompliance(options: {
  outputDir: string;
  repoRoot: string;
  sourceRevision: string;
  version: string;
}): Promise<void> {
  const [npmComponents, cargoComponents, opaqueRendererAssets, rootLicense] = await Promise.all([
    collectNpmComponents(options.repoRoot),
    collectCargoComponents(options.repoRoot),
    collectOpaqueRendererAssets(options.repoRoot, options.outputDir),
    readFile(path.join(options.repoRoot, "LICENSE"), "utf8"),
  ]);
  const assetComponents = await collectAssetComponents(
    options.repoRoot,
    options.outputDir,
    npmComponents,
  );
  const components = [...assetComponents, ...npmComponents, ...cargoComponents].sort((left, right) =>
    left.ecosystem.localeCompare(right.ecosystem) ||
    left.name.localeCompare(right.name) ||
    left.version.localeCompare(right.version),
  );
  const notices = buildThirdPartyNotices(components, opaqueRendererAssets);
  await Promise.all([
    writeFile(path.join(options.outputDir, NOTEBOOK_WEB_LICENSE), rootLicense),
    writeFile(path.join(options.outputDir, NOTEBOOK_WEB_NOTICES), notices),
  ]);
  const shippedWebFiles = await collectShippedWebFiles(options.outputDir);
  const spdx = buildSpdxDocument({
    components,
    opaqueRendererAssets,
    shippedWebFiles,
    sourceRevision: options.sourceRevision,
    version: options.version,
  });

  await writeFile(
    path.join(options.outputDir, NOTEBOOK_WEB_SBOM),
    `${JSON.stringify(spdx, null, 2)}\n`,
  );
}

export async function assertNotebookWebCompliance(outputDir: string): Promise<void> {
  const [license, notices, spdxText, shippedWebFiles] = await Promise.all([
    readFile(path.join(outputDir, NOTEBOOK_WEB_LICENSE), "utf8"),
    readFile(path.join(outputDir, NOTEBOOK_WEB_NOTICES), "utf8"),
    readFile(path.join(outputDir, NOTEBOOK_WEB_SBOM), "utf8"),
    collectShippedWebFiles(outputDir),
  ]);
  if (!license.includes("BSD 3-Clause License")) throw new Error("Notebook Web LICENSE is invalid");
  if (!notices.includes("OPAQUE RENDERER BUILD INPUTS")) {
    throw new Error("Notebook Web third-party notices omit renderer provenance");
  }
  const spdx = JSON.parse(spdxText) as NotebookWebSpdxDocument;
  if (spdx.spdxVersion !== "SPDX-2.3" || spdx.packages.length < 2) {
    throw new Error("Notebook Web SPDX document is incomplete");
  }
  for (const pkg of spdx.packages) validateLicenseExpression(pkg.licenseDeclared);
  const expectedFiles = shippedWebFiles.map((file) => `${file.path}:${file.sha256}`).sort();
  const actualFiles = spdx.files
    .map(
      (file) =>
        `${file.fileName}:${file.checksums.find((checksum) => checksum.algorithm === "SHA256")?.checksumValue ?? ""}`,
    )
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Notebook Web SPDX file provenance is incomplete");
  }
  const containedFiles = spdx.relationships
    .filter(
      (relationship) =>
        relationship.spdxElementId === "SPDXRef-Package-notebook-web" &&
        relationship.relationshipType === "CONTAINS",
    )
    .map((relationship) => relationship.relatedSpdxElement)
    .sort();
  const expectedContainedFiles = spdx.files.map((file) => file.SPDXID).sort();
  if (JSON.stringify(containedFiles) !== JSON.stringify(expectedContainedFiles)) {
    throw new Error("Notebook Web SPDX file relationships are incomplete");
  }
  const rootPackage = spdx.packages.find(
    (pkg) => pkg.SPDXID === "SPDXRef-Package-notebook-web",
  );
  const expectedVerificationCode = sha1(shippedWebFiles.map((file) => file.sha1).sort().join(""));
  if (
    !rootPackage?.filesAnalyzed ||
    rootPackage.packageVerificationCode?.packageVerificationCodeValue !==
      expectedVerificationCode ||
    JSON.stringify(rootPackage.packageVerificationCode.packageVerificationCodeExcludedFiles) !==
      JSON.stringify(SPDX_EXCLUDED_METADATA)
  ) {
    throw new Error("Notebook Web SPDX package verification code is invalid");
  }
  const rendererAnnotation = spdx.annotations.find((annotation) =>
    annotation.comment.startsWith("Opaque renderer build inputs: "),
  );
  if (!rendererAnnotation) throw new Error("Notebook Web SPDX document omits renderer provenance");
  const assets = JSON.parse(rendererAnnotation.comment.slice(rendererAnnotation.comment.indexOf(": ") + 2)) as OpaqueRendererAsset[];
  const expected = Object.keys(OPAQUE_RENDERER_COMPONENTS).sort();
  const actual = assets.map((asset) => path.basename(asset.path)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Notebook Web SPDX renderer provenance is incomplete");
  }
  const spdxFileHashes = new Map(
    spdx.files.map((file) => [
      file.fileName,
      file.checksums.find((checksum) => checksum.algorithm === "SHA256")?.checksumValue,
    ]),
  );
  for (const asset of assets) {
    if (asset.outputs.length === 0) {
      throw new Error(`Notebook Web SPDX renderer output provenance is empty for ${asset.path}`);
    }
    for (const output of asset.outputs) {
      if (spdxFileHashes.get(output.path) !== output.sha256) {
        throw new Error(`Notebook Web SPDX renderer output provenance is stale for ${output.path}`);
      }
    }
  }
}
