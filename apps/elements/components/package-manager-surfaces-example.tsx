"use client";

import {
  CheckCircle2,
  FileCode2,
  Layers3,
  PackageCheck,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import type { EnvProgressState } from "runtimed";
import type { ReactNode } from "react";
import {
  CondaDependencyPanel,
  DenoDependencyPanel,
  EnvironmentSummary,
  EnvironmentPackageSummaryPanel,
  PixiDependencyPanel,
} from "@/components/environment";
import { NotebookPackageSummaryPanel } from "@/components/notebook";
import { getElementsNotebookScenario } from "@/components/notebook-scenarios";

const asyncNoop = async () => {};
const asyncTrue = async () => true;
const noop = () => {};

const condaProgress: EnvProgressState = {
  isActive: true,
  phase: "link_progress",
  envType: "conda",
  error: null,
  statusText: "Installing 17/24 scikit-learn",
  elapsedMs: 18_400,
  progress: { completed: 17, total: 24 },
  bytesPerSecond: null,
  currentPackage: "scikit-learn",
};

const packageSurfaces = [
  {
    name: "EnvironmentPackageSummaryPanel",
    source: "src/components/environment/EnvironmentPackageSummaryPanel.tsx",
    manager: "summary",
    role: "Host-neutral package summary projection for rails, cloud views, and read-only embeds.",
  },
  {
    name: "NotebookPackageSummaryPanel",
    source: "src/components/notebook/NotebookPackageSummaryPanel.tsx",
    manager: "rail",
    role: "Shared notebook rail wrapper for package summary and environment status.",
  },
  {
    name: "CondaDependencyPanel",
    source: "src/components/environment/CondaDependencyPanel.tsx",
    manager: "conda",
    role: "Conda packages, channels, environment.yml details, and solve progress.",
  },
  {
    name: "PixiDependencyPanel",
    source: "src/components/environment/PixiDependencyPanel.tsx",
    manager: "pixi",
    role: "pixi.toml details, Conda and PyPI dependency display, and restart prompts.",
  },
  {
    name: "DenoDependencyPanel",
    source: "src/components/environment/DenoDependencyPanel.tsx",
    manager: "deno",
    role: "deno.json details, npm import behavior, and Deno import examples.",
  },
];

const packageBoundaryRows = [
  {
    boundary: "Package details",
    catalogPath: "static package records",
    productionBoundary: "Automerge package state and project files",
    detail:
      "uv, Conda, Pixi, and Deno headers receive the same prop shapes they use in the notebook app without editing notebook documents.",
  },
  {
    boundary: "Package actions",
    catalogPath: "inert async callbacks",
    productionBoundary: "host commands, daemon sync, and environment solves",
    detail:
      "Add, remove, import, sync, retry, and restart affordances stay visible while side effects remain outside the docs runtime.",
  },
  {
    boundary: "Trust and rebuild flow",
    catalogPath: "rendered status fixtures",
    productionBoundary: "trust re-signing, package pool warming, and kernel restart lifecycle",
    detail:
      "Progress and dirty states are fixture-backed here; live trust decisions and environment rebuilds stay with runtime surfaces.",
  },
];

export function PackageManagerSurfacesExample() {
  const scenario = getElementsNotebookScenario("desktop-local-owner");

  return (
    <div className="not-prose space-y-6" data-elements-slot="package-manager-surfaces">
      <section className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
        {packageSurfaces.map((surface) => (
          <div key={surface.name} className="rounded-lg border border-fd-border bg-fd-card p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="rounded-full border border-fd-border bg-fd-muted px-2 py-1 text-[11px] font-medium uppercase text-fd-muted-foreground">
                {surface.manager}
              </span>
              <CheckCircle2 className="size-4 text-emerald-500" aria-hidden="true" />
            </div>
            <h2 className="break-words text-sm font-semibold [overflow-wrap:anywhere]">
              {surface.name}
            </h2>
            <p className="mt-2 min-h-[3rem] text-xs leading-5 text-fd-muted-foreground">
              {surface.role}
            </p>
            <div className="mt-3 break-words font-mono text-[11px] leading-5 text-fd-muted-foreground [overflow-wrap:anywhere]">
              {surface.source}
            </div>
          </div>
        ))}
      </section>

      <section className="grid items-start gap-4 xl:grid-cols-2">
        <SurfaceFrame
          icon={<PackageCheck className="size-4 text-sky-500" aria-hidden="true" />}
          title="Shared package summary"
          detail="Pure package projection with no rail wrapper or host actions."
        >
          <div className="p-3">
            <EnvironmentPackageSummaryPanel packages={scenario.viewModel.packages} readOnly />
          </div>
        </SurfaceFrame>

        <SurfaceFrame
          icon={<PackageCheck className="size-4 text-fuchsia-500" aria-hidden="true" />}
          title="Notebook rail package summary"
          detail="Shared package summary with the same environment header used by notebook shell fixtures."
        >
          <div className="p-3">
            <NotebookPackageSummaryPanel
              packages={scenario.viewModel.packages}
              readOnly
              header={
                <EnvironmentSummary
                  capabilities={scenario.capabilities}
                  packages={scenario.viewModel.packages}
                  environment={scenario.environment}
                  showPackageDetails={false}
                  className="shadow-none"
                />
              }
            />
          </div>
        </SurfaceFrame>

        <SurfaceFrame
          icon={<RefreshCw className="size-4 text-emerald-500" aria-hidden="true" />}
          title="Conda environment"
          detail="Fixture channels, environment.yml imports, and solve progress."
        >
          <CondaDependencyPanel
            dependencies={["python=3.13", "scikit-learn", "seaborn"]}
            channels={["conda-forge", "nvidia"]}
            python="3.13"
            loading={false}
            envSource="conda:env_yml"
            variant="rail"
            syncState={{ status: "dirty" }}
            onAdd={asyncNoop}
            onRemove={asyncNoop}
            onSetChannels={asyncNoop}
            onSetPython={asyncNoop}
            onSyncNow={asyncTrue}
            onRetryLaunch={asyncTrue}
            envProgress={condaProgress}
            onResetProgress={noop}
            environmentYmlInfo={{
              path: "/Users/kyle/notebooks/environment.yml",
              relative_path: "environment.yml",
              name: "mathnet",
              has_dependencies: true,
              dependency_count: 3,
              has_pip_dependencies: true,
              pip_dependency_count: 1,
              python: "3.13",
              channels: ["conda-forge", "nvidia"],
            }}
            environmentYmlDeps={{
              path: "/Users/kyle/notebooks/environment.yml",
              relative_path: "environment.yml",
              name: "mathnet",
              dependencies: ["python=3.13", "scikit-learn", "seaborn"],
              pip_dependencies: ["datasets"],
              python: "3.13",
              channels: ["conda-forge", "nvidia"],
            }}
            justSynced={false}
          />
        </SurfaceFrame>

        <SurfaceFrame
          icon={<Layers3 className="size-4 text-amber-500" aria-hidden="true" />}
          title="Pixi project"
          detail="Fixture pixi.toml project details with Conda and PyPI dependencies."
        >
          <PixiDependencyPanel
            pixiInfo={{
              path: "/Users/kyle/notebooks/pixi.toml",
              relative_path: "pixi.toml",
              workspace_name: "mathnet",
              dependencies: ["python>=3.13", "numpy", "pandas"],
              has_dependencies: true,
              dependency_count: 3,
              pypi_dependencies: ["altair", "great-tables"],
              has_pypi_dependencies: true,
              pypi_dependency_count: 2,
              python: ">=3.13",
              channels: ["conda-forge"],
            }}
            envSource="pixi:toml"
            variant="rail"
            syncState={{ status: "dirty", added: ["plotly"], removed: [] }}
            onSyncNow={asyncTrue}
            justSynced={false}
          />
        </SurfaceFrame>

        <SurfaceFrame
          icon={<TerminalSquare className="size-4 text-emerald-500" aria-hidden="true" />}
          title="Deno imports"
          detail="Fixture deno.json imports and the flexible npm toggle."
        >
          <DenoDependencyPanel
            denoConfigInfo={{
              path: "/Users/kyle/notebooks/deno.json",
              relative_path: "deno.json",
              name: "notebook-tools",
              has_imports: true,
              has_tasks: true,
            }}
            flexibleNpmImports
            onSetFlexibleNpmImports={noop}
            syncState={{ status: "dirty" }}
            syncing={false}
            onSyncNow={asyncTrue}
            justSynced={false}
          />
        </SurfaceFrame>
      </section>

      <section className="rounded-lg border border-dashed border-fd-border bg-fd-background p-4">
        <div className="mb-3 flex items-center gap-2">
          <FileCode2 className="size-4 text-fd-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Live work stays with the host</h2>
        </div>
        <p className="text-xs leading-5 text-fd-muted-foreground">
          This page owns fixture package details and inert callbacks. The rendered headers come from
          the notebook app, while live package writes, daemon sync, and environment rebuilding stay
          outside the docs runtime.
        </p>
        <div className="mt-4 overflow-hidden rounded-md border border-fd-border bg-fd-card">
          <div className="hidden grid-cols-[190px_210px_240px_minmax(0,1fr)] gap-3 border-b border-fd-border bg-fd-muted/40 px-3 py-2 text-[11px] font-medium uppercase text-fd-muted-foreground xl:grid">
            <span>Boundary</span>
            <span>Catalog path</span>
            <span>Production boundary</span>
            <span>Notes</span>
          </div>
          {packageBoundaryRows.map((row) => (
            <div
              key={row.boundary}
              className="grid gap-2 border-b border-fd-border px-3 py-3 text-xs last:border-b-0 xl:grid-cols-[190px_210px_240px_minmax(0,1fr)] xl:gap-3"
            >
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground xl:hidden">
                  Boundary
                </div>
                <div className="font-semibold">{row.boundary}</div>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground xl:hidden">
                  Catalog path
                </div>
                <div className="font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
                  {row.catalogPath}
                </div>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground xl:hidden">
                  Production boundary
                </div>
                <div className="font-mono text-[11px] text-amber-700 dark:text-amber-300">
                  {row.productionBoundary}
                </div>
              </div>
              <p className="leading-5 text-fd-muted-foreground">{row.detail}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SurfaceFrame({
  children,
  detail,
  icon,
  title,
}: {
  children: ReactNode;
  detail: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div className="border-b border-fd-border p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-fd-border bg-fd-muted">
            {icon}
          </div>
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">{detail}</p>
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}
