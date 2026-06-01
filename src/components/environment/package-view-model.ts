export type NotebookPackageManager = "uv" | "conda" | "pixi" | "deno";

export interface NotebookPackageSection {
  manager: NotebookPackageManager;
  label: string;
  dependencies: string[];
  details: Array<{
    label: string;
    values: string[];
  }>;
}

export interface NotebookPackageViewModel {
  summary: string | null;
  sections: NotebookPackageSection[];
}

export function notebookMetadataToPackageViewModel(metadata: unknown): NotebookPackageViewModel {
  const runt = metadataRecord(metadata)?.runt;
  const sections: NotebookPackageSection[] = [];

  if (isRecord(runt)) {
    const uv = metadataRecord(runt.uv);
    const uvDependencies = stringArray(uv?.dependencies);
    if (uvDependencies.length > 0 || typeof uv?.["requires-python"] === "string") {
      sections.push({
        manager: "uv",
        label: "uv",
        dependencies: uvDependencies,
        details: [
          detail(
            "Python",
            typeof uv?.["requires-python"] === "string" ? [uv["requires-python"]] : [],
          ),
          detail("Prerelease", typeof uv?.prerelease === "string" ? [uv.prerelease] : []),
        ].filter(hasValues),
      });
    }

    const conda = metadataRecord(runt.conda);
    const condaDependencies = stringArray(conda?.dependencies);
    const condaChannels = stringArray(conda?.channels);
    if (
      condaDependencies.length > 0 ||
      condaChannels.length > 0 ||
      typeof conda?.python === "string"
    ) {
      sections.push({
        manager: "conda",
        label: "conda",
        dependencies: condaDependencies,
        details: [
          detail("Python", typeof conda?.python === "string" ? [conda.python] : []),
          detail("Channels", condaChannels),
        ].filter(hasValues),
      });
    }

    const pixi = metadataRecord(runt.pixi);
    const pixiDependencies = stringArray(pixi?.dependencies);
    const pixiPyPiDependencies = stringArray(pixi?.pypi_dependencies);
    const pixiChannels = stringArray(pixi?.channels);
    if (
      pixiDependencies.length > 0 ||
      pixiPyPiDependencies.length > 0 ||
      pixiChannels.length > 0 ||
      typeof pixi?.python === "string"
    ) {
      sections.push({
        manager: "pixi",
        label: "pixi",
        dependencies: pixiDependencies,
        details: [
          detail("PyPI", pixiPyPiDependencies),
          detail("Python", typeof pixi?.python === "string" ? [pixi.python] : []),
          detail("Channels", pixiChannels),
        ].filter(hasValues),
      });
    }

    const deno = metadataRecord(runt.deno);
    const denoPermissions = stringArray(deno?.permissions);
    if (
      denoPermissions.length > 0 ||
      typeof deno?.import_map === "string" ||
      typeof deno?.config === "string" ||
      typeof deno?.flexible_npm_imports === "boolean"
    ) {
      sections.push({
        manager: "deno",
        label: "Deno",
        dependencies: [],
        details: [
          detail("Permissions", denoPermissions),
          detail("Import map", typeof deno?.import_map === "string" ? [deno.import_map] : []),
          detail("Config", typeof deno?.config === "string" ? [deno.config] : []),
          detail(
            "Flexible npm imports",
            typeof deno?.flexible_npm_imports === "boolean"
              ? [deno.flexible_npm_imports ? "enabled" : "disabled"]
              : [],
          ),
        ].filter(hasValues),
      });
    }
  }

  return {
    summary: packageSummary(sections),
    sections,
  };
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function detail(label: string, values: string[]): NotebookPackageSection["details"][number] {
  return { label, values };
}

function hasValues(detail: NotebookPackageSection["details"][number]): boolean {
  return detail.values.length > 0;
}

function packageSummary(sections: readonly NotebookPackageSection[]): string | null {
  if (sections.length === 0) return null;
  const dependencyCount = sections.reduce(
    (total, section) =>
      total +
      section.dependencies.length +
      section.details
        .filter((detail) => detail.label === "PyPI")
        .reduce((detailTotal, detail) => detailTotal + detail.values.length, 0),
    0,
  );
  if (dependencyCount === 0) {
    return sections.map((section) => section.label).join(" + ");
  }
  const packageLabel = dependencyCount === 1 ? "package" : "packages";
  return `${sections.map((section) => section.label).join(" + ")} · ${dependencyCount} ${packageLabel}`;
}
