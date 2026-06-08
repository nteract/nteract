import type { EnvManager, RuntimeKind } from "./derived-state";
import type {
  ProjectContext,
  ProjectFileExtras,
  ProjectFileKind,
  RuntimeState,
} from "./runtime-state";
import { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";
import type {
  NotebookRegisteredWorkstationProjection,
  NotebookWorkstationSelectionProjection,
} from "./notebook-workstation-selection";

export type NotebookLaunchEnvironmentOptionKind =
  | "running_kernel"
  | "kernelspec"
  | "language_info"
  | "notebook_metadata"
  | "project_context"
  | "workstation_default"
  | "workstation_environment";

export type NotebookLaunchEnvironmentSource =
  | EnvManager
  | RuntimeKind
  | "current_python"
  | "kernelspec"
  | "language_info"
  | "managed_project"
  | "unknown"
  | (string & {});

export interface NotebookLaunchKernelSpecProjection {
  displayName: string | null;
  language: string | null;
  name: string;
}

export interface NotebookLaunchEnvironmentOptionProjection {
  available: boolean;
  detail: string | null;
  id: string;
  isDefault: boolean;
  kind: NotebookLaunchEnvironmentOptionKind;
  label: string;
  selected: boolean;
  source: NotebookLaunchEnvironmentSource;
}

export interface NotebookLaunchEnvironmentProjection {
  activeOption: NotebookLaunchEnvironmentOptionProjection | null;
  defaultOption: NotebookLaunchEnvironmentOptionProjection | null;
  kernelSpec: NotebookLaunchKernelSpecProjection | null;
  options: readonly NotebookLaunchEnvironmentOptionProjection[];
  runtimeKind: RuntimeKind | null;
  summary: string | null;
}

export interface ProjectNotebookLaunchEnvironmentOptions {
  metadata?: unknown;
  runtimeState?: Pick<RuntimeState, "kernel" | "project_context"> | null;
  selection?: NotebookWorkstationSelectionProjection | null;
}

const LAUNCH_ENVIRONMENT_CACHE = new Map<string, NotebookLaunchEnvironmentProjection>();
const LAUNCH_ENVIRONMENT_OPTION_CACHE = new Map<
  string,
  NotebookLaunchEnvironmentOptionProjection
>();
const LAUNCH_ENVIRONMENT_CACHE_LIMIT = 256;
const LAUNCH_ENVIRONMENT_OPTION_CACHE_LIMIT = 1024;

export function projectNotebookLaunchEnvironment({
  metadata = null,
  runtimeState = null,
  selection = null,
}: ProjectNotebookLaunchEnvironmentOptions): NotebookLaunchEnvironmentProjection {
  const cacheKey = stableCacheKey([
    metadataCacheKey(metadata),
    runtimeStateCacheKey(runtimeState),
    selectionCacheKey(selection),
  ]);
  const cached = getBoundedCacheValue(LAUNCH_ENVIRONMENT_CACHE, cacheKey);
  if (cached) return cached;

  const kernelSpec = projectKernelSpec(metadata);
  const runtimeKind = inferRuntimeKind({ kernelSpec, metadata, runtimeState });
  const options = dedupeOptions([
    ...runtimeOptions(runtimeState),
    ...notebookMetadataOptions(metadata, kernelSpec),
    ...projectContextOptions(runtimeState?.project_context ?? null),
    ...workstationOptions(selection?.launchCandidate ?? null),
  ]);
  const activeOption = options.find((option) => option.selected) ?? null;
  const defaultOption =
    activeOption ??
    options.find((option) => option.isDefault) ??
    options.find((option) => option.available) ??
    null;
  const summary = activeOption?.label ?? defaultOption?.label ?? null;
  const projection = Object.freeze({
    activeOption,
    defaultOption,
    kernelSpec,
    options: Object.freeze(options),
    runtimeKind,
    summary,
  });
  setBoundedCacheValue(
    LAUNCH_ENVIRONMENT_CACHE,
    cacheKey,
    projection,
    LAUNCH_ENVIRONMENT_CACHE_LIMIT,
  );
  return projection;
}

export function clearNotebookLaunchEnvironmentProjectionCacheForTests(): void {
  LAUNCH_ENVIRONMENT_CACHE.clear();
  LAUNCH_ENVIRONMENT_OPTION_CACHE.clear();
}

function runtimeOptions(
  runtimeState: Pick<RuntimeState, "kernel" | "project_context"> | null,
): NotebookLaunchEnvironmentOptionProjection[] {
  if (!runtimeState) return [];
  const envSource = trimToNull(runtimeState.kernel.env_source);
  const language = normalizeRuntimeKind(runtimeState.kernel.language);
  if (!envSource && !language) return [];
  return [
    launchEnvironmentOption({
      available: true,
      detail: "RuntimeStateDoc active kernel",
      id: `runtime:${envSource ?? language ?? "kernel"}`,
      isDefault: false,
      kind: "running_kernel",
      label: envSource ? envSourceLabel(envSource) : `${language} kernel`,
      selected: true,
      source: envSourceManager(envSource) ?? language ?? "unknown",
    }),
  ];
}

function notebookMetadataOptions(
  metadata: unknown,
  kernelSpec: NotebookLaunchKernelSpecProjection | null,
): NotebookLaunchEnvironmentOptionProjection[] {
  const options: NotebookLaunchEnvironmentOptionProjection[] = [];
  if (kernelSpec) {
    options.push(
      launchEnvironmentOption({
        available: true,
        detail: kernelSpec.language ? `language: ${kernelSpec.language}` : null,
        id: `kernelspec:${kernelSpec.name}`,
        isDefault: false,
        kind: "kernelspec",
        label: kernelSpec.displayName ?? kernelSpec.name,
        selected: false,
        source: "kernelspec",
      }),
    );
  }

  const languageName = trimToNull(metadataRecord(metadataRecord(metadata)?.language_info)?.name);
  if (
    languageName &&
    !sameIdentifier(languageName, kernelSpec?.language) &&
    !sameIdentifier(languageName, kernelSpec?.name)
  ) {
    options.push(
      launchEnvironmentOption({
        available: true,
        detail: null,
        id: `language_info:${languageName}`,
        isDefault: false,
        kind: "language_info",
        label: `${languageName} language`,
        selected: false,
        source: "language_info",
      }),
    );
  }

  const runt = metadataRecord(metadataRecord(metadata)?.runt);
  if (!runt) return options;

  const uv = metadataRecord(runt.uv);
  const uvDependencies = stringArray(uv?.dependencies);
  const uvPython = trimToNull(uv?.["requires-python"]);
  if (uvDependencies.length > 0 || uvPython) {
    options.push(
      launchEnvironmentOption({
        available: true,
        detail: dependencyDetail(uvDependencies.length, uvPython),
        id: "notebook:uv",
        isDefault: false,
        kind: "notebook_metadata",
        label: "uv notebook environment",
        selected: false,
        source: "uv",
      }),
    );
  }

  const conda = metadataRecord(runt.conda);
  const condaDependencies = stringArray(conda?.dependencies);
  const condaPython = trimToNull(conda?.python);
  if (condaDependencies.length > 0 || condaPython || stringArray(conda?.channels).length > 0) {
    options.push(
      launchEnvironmentOption({
        available: true,
        detail: dependencyDetail(condaDependencies.length, condaPython),
        id: "notebook:conda",
        isDefault: false,
        kind: "notebook_metadata",
        label: "conda notebook environment",
        selected: false,
        source: "conda",
      }),
    );
  }

  const pixi = metadataRecord(runt.pixi);
  const pixiDependencies = stringArray(pixi?.dependencies);
  const pixiPypiDependencies = stringArray(pixi?.pypi_dependencies);
  const pixiPython = trimToNull(pixi?.python);
  if (
    pixiDependencies.length > 0 ||
    pixiPypiDependencies.length > 0 ||
    pixiPython ||
    stringArray(pixi?.channels).length > 0
  ) {
    options.push(
      launchEnvironmentOption({
        available: true,
        detail: dependencyDetail(pixiDependencies.length + pixiPypiDependencies.length, pixiPython),
        id: "notebook:pixi",
        isDefault: false,
        kind: "notebook_metadata",
        label: "pixi notebook environment",
        selected: false,
        source: "pixi",
      }),
    );
  }

  const deno = metadataRecord(runt.deno);
  if (
    stringArray(deno?.permissions).length > 0 ||
    trimToNull(deno?.import_map) ||
    trimToNull(deno?.config) ||
    typeof deno?.flexible_npm_imports === "boolean"
  ) {
    options.push(
      launchEnvironmentOption({
        available: true,
        detail: "Deno runtime metadata",
        id: "notebook:deno",
        isDefault: false,
        kind: "notebook_metadata",
        label: "Deno notebook runtime",
        selected: false,
        source: "deno",
      }),
    );
  }

  return options;
}

function projectContextOptions(
  projectContext: ProjectContext | null,
): NotebookLaunchEnvironmentOptionProjection[] {
  if (!projectContext || projectContext.state !== "Detected") return [];
  const manager = projectFileManager(projectContext.project_file.kind);
  const dependencyCount =
    projectContext.parsed.dependencies.length +
    projectContext.parsed.dev_dependencies.length +
    projectExtrasDependencyCount(projectContext.parsed.extras);
  return [
    launchEnvironmentOption({
      available: true,
      detail: dependencyDetail(dependencyCount, projectContext.parsed.requires_python),
      id: `project:${projectContext.project_file.kind}:${projectContext.project_file.relative_to_notebook}`,
      isDefault: false,
      kind: "project_context",
      label: projectFileLabel(projectContext.project_file.kind),
      selected: false,
      source: manager,
    }),
  ];
}

function workstationOptions(
  workstation: NotebookRegisteredWorkstationProjection | null,
): NotebookLaunchEnvironmentOptionProjection[] {
  if (!workstation) return [];
  const options: NotebookLaunchEnvironmentOptionProjection[] = [];
  if (workstation.defaultEnvironmentLabel) {
    options.push(
      launchEnvironmentOption({
        available: workstation.status === "online" || workstation.status === "connecting",
        detail: workstation.workingDirectoryLabel
          ? `working dir: ${workstation.workingDirectoryLabel}`
          : null,
        id: `workstation:${workstation.id}:default`,
        isDefault: true,
        kind: "workstation_default",
        label: workstation.defaultEnvironmentLabel,
        selected: false,
        source: workstation.environmentPolicy ?? "unknown",
      }),
    );
  }
  for (const environment of workstation.environments) {
    options.push(
      launchEnvironmentOption({
        available: environment.available,
        detail: environment.detail,
        id: `workstation:${workstation.id}:environment:${environment.id}`,
        isDefault: environment.isDefault,
        kind: "workstation_environment",
        label: environment.label,
        selected: false,
        source: environment.policy,
      }),
    );
  }
  return options;
}

function launchEnvironmentOption(
  option: NotebookLaunchEnvironmentOptionProjection,
): NotebookLaunchEnvironmentOptionProjection {
  const cacheKey = stableCacheKey([
    option.id,
    option.kind,
    option.label,
    option.detail,
    option.source,
    option.available,
    option.isDefault,
    option.selected,
  ]);
  const cached = getBoundedCacheValue(LAUNCH_ENVIRONMENT_OPTION_CACHE, cacheKey);
  if (cached) return cached;
  const projection = Object.freeze(option);
  setBoundedCacheValue(
    LAUNCH_ENVIRONMENT_OPTION_CACHE,
    cacheKey,
    projection,
    LAUNCH_ENVIRONMENT_OPTION_CACHE_LIMIT,
  );
  return projection;
}

function dedupeOptions(
  options: readonly NotebookLaunchEnvironmentOptionProjection[],
): NotebookLaunchEnvironmentOptionProjection[] {
  const seen = new Set<string>();
  const deduped: NotebookLaunchEnvironmentOptionProjection[] = [];
  for (const option of options) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    deduped.push(option);
  }
  return deduped;
}

function projectKernelSpec(metadata: unknown): NotebookLaunchKernelSpecProjection | null {
  const kernelspec = metadataRecord(metadata)?.kernelspec;
  const name = trimToNull(metadataRecord(kernelspec)?.name);
  if (!name) return null;
  return Object.freeze({
    displayName: trimToNull(metadataRecord(kernelspec)?.display_name),
    language: trimToNull(metadataRecord(kernelspec)?.language),
    name,
  });
}

function inferRuntimeKind({
  kernelSpec,
  metadata,
  runtimeState,
}: {
  kernelSpec: NotebookLaunchKernelSpecProjection | null;
  metadata: unknown;
  runtimeState: Pick<RuntimeState, "kernel" | "project_context"> | null;
}): RuntimeKind | null {
  const runtimeLanguage = normalizeRuntimeKind(runtimeState?.kernel.language);
  if (runtimeLanguage) return runtimeLanguage;
  const languageName = normalizeRuntimeKind(
    metadataRecord(metadataRecord(metadata)?.language_info)?.name,
  );
  if (languageName) return languageName;
  const kernelLanguage = normalizeRuntimeKind(kernelSpec?.language);
  if (kernelLanguage) return kernelLanguage;
  const kernelName = normalizeRuntimeKind(kernelSpec?.name);
  if (kernelName) return kernelName;
  if (metadataRecord(metadataRecord(metadata)?.runt)?.deno) return "deno";
  if (runtimeState?.project_context.state === "Detected") return "python";
  return null;
}

function envSourceManager(value: string | null): NotebookLaunchEnvironmentSource | null {
  if (!value) return null;
  if (value.startsWith("uv:")) return "uv";
  if (value.startsWith("conda:")) return "conda";
  if (value.startsWith("pixi:")) return "pixi";
  if (value === "current_python" || value.startsWith("current_python:")) return "current_python";
  return "unknown";
}

function envSourceLabel(value: string): string {
  if (value.startsWith("uv:")) return `uv ${value.slice(3)}`;
  if (value.startsWith("conda:")) return `conda ${value.slice(6)}`;
  if (value.startsWith("pixi:")) return `pixi ${value.slice(5)}`;
  if (value === "current_python") return "Current Python";
  return value;
}

function projectFileManager(kind: ProjectFileKind): EnvManager {
  switch (kind) {
    case "PyprojectToml":
      return "uv";
    case "PixiToml":
      return "pixi";
    case "EnvironmentYml":
      return "conda";
  }
}

function projectFileLabel(kind: ProjectFileKind): string {
  switch (kind) {
    case "PyprojectToml":
      return "pyproject.toml environment";
    case "PixiToml":
      return "pixi.toml environment";
    case "EnvironmentYml":
      return "environment.yml environment";
  }
}

function projectExtrasDependencyCount(extras: ProjectFileExtras): number {
  switch (extras.kind) {
    case "Pixi":
      return extras.pypi_dependencies.length;
    case "EnvironmentYml":
      return extras.pip.length;
    default:
      return 0;
  }
}

function dependencyDetail(dependencyCount: number, python: string | null): string | null {
  const parts: string[] = [];
  if (dependencyCount > 0) {
    parts.push(`${dependencyCount} ${dependencyCount === 1 ? "package" : "packages"}`);
  }
  if (python) {
    parts.push(`Python ${python}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function normalizeRuntimeKind(value: unknown): RuntimeKind | null {
  const normalized = trimToNull(value)?.toLowerCase();
  if (normalized === "python" || normalized === "python3") return "python";
  if (normalized === "deno" || normalized === "typescript" || normalized === "javascript") {
    return "deno";
  }
  return null;
}

function sameIdentifier(left: string, right: unknown): boolean {
  const normalizedRight = trimToNull(right);
  return Boolean(normalizedRight && left.toLowerCase() === normalizedRight.toLowerCase());
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function trimToNull(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function metadataCacheKey(metadata: unknown): string {
  const record = metadataRecord(metadata);
  if (!record) return "null";
  const kernelspec = metadataRecord(record.kernelspec);
  const languageInfo = metadataRecord(record.language_info);
  const runt = metadataRecord(record.runt);
  const uv = metadataRecord(runt?.uv);
  const conda = metadataRecord(runt?.conda);
  const pixi = metadataRecord(runt?.pixi);
  const deno = metadataRecord(runt?.deno);
  return stableCacheKey([
    trimToNull(kernelspec?.name),
    trimToNull(kernelspec?.display_name),
    trimToNull(kernelspec?.language),
    trimToNull(languageInfo?.name),
    stringArray(uv?.dependencies).length,
    trimToNull(uv?.["requires-python"]),
    stringArray(conda?.dependencies).length,
    trimToNull(conda?.python),
    stringArray(conda?.channels).length,
    stringArray(pixi?.dependencies).length,
    stringArray(pixi?.pypi_dependencies).length,
    trimToNull(pixi?.python),
    stringArray(pixi?.channels).length,
    stringArray(deno?.permissions).length,
    Boolean(trimToNull(deno?.import_map)),
    Boolean(trimToNull(deno?.config)),
    typeof deno?.flexible_npm_imports === "boolean" ? deno.flexible_npm_imports : null,
  ]);
}

function runtimeStateCacheKey(
  runtimeState: Pick<RuntimeState, "kernel" | "project_context"> | null,
): string {
  if (!runtimeState) return "null";
  return stableCacheKey([
    runtimeState.kernel.language ?? null,
    runtimeState.kernel.env_source ?? null,
    runtimeState.project_context,
  ]);
}

function selectionCacheKey(selection: NotebookWorkstationSelectionProjection | null): string {
  const candidate = selection?.launchCandidate;
  if (!candidate) return "null";
  return stableCacheKey([
    candidate.id,
    candidate.displayName,
    candidate.status,
    candidate.defaultEnvironmentLabel,
    candidate.environmentPolicy,
    candidate.workingDirectoryLabel,
    ...candidate.environments.map((environment) =>
      stableCacheKey([
        environment.id,
        environment.label,
        environment.policy,
        environment.available,
        environment.detail,
        environment.isDefault,
      ]),
    ),
  ]);
}
