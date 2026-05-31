"use client";

import {
  CheckCircle2,
  FileCode2,
  Layers3,
  PackageCheck,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import dynamic from "next/dynamic";
import type { EnvProgressState } from "runtimed";
import type { ReactNode } from "react";
import { CondaDependencyHeader } from "@/notebook-components/CondaDependencyHeader";
import { DenoDependencyHeader } from "@/notebook-components/DenoDependencyHeader";
import { DependencyHeader } from "@/notebook-components/DependencyHeader";
import { getElementsNotebookScenario } from "@/components/notebook-scenarios";

const PixiDependencyHeader = dynamic(
  () =>
    import("@/notebook-components/PixiDependencyHeader").then((mod) => mod.PixiDependencyHeader),
  {
    ssr: false,
    loading: () => <DependencySurfaceSkeleton label="PixiDependencyHeader" />,
  },
);

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
    name: "DependencyHeader",
    source: "apps/notebook/src/components/DependencyHeader.tsx",
    manager: "uv",
    role: "Inline uv dependencies, project pyproject.toml state, and sync prompts.",
  },
  {
    name: "CondaDependencyHeader",
    source: "apps/notebook/src/components/CondaDependencyHeader.tsx",
    manager: "conda",
    role: "Conda package specs, channels, environment.yml detection, and solve progress.",
  },
  {
    name: "PixiDependencyHeader",
    source: "apps/notebook/src/components/PixiDependencyHeader.tsx",
    manager: "pixi",
    role: "pixi.toml detection, conda and PyPI dependency display, and restart prompts.",
  },
  {
    name: "DenoDependencyHeader",
    source: "apps/notebook/src/components/DenoDependencyHeader.tsx",
    manager: "deno",
    role: "deno.json state, npm import behavior, and Deno import examples.",
  },
];

const packageBoundaryRows = [
  {
    boundary: "Notebook metadata",
    catalogPath: "static package-manager records",
    productionBoundary: "Automerge notebook metadata and pyproject/environment files",
    detail:
      "uv, Conda, Pixi, and Deno headers receive the same prop shapes they use in the notebook app without mutating notebook documents.",
  },
  {
    boundary: "Manager actions",
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
          icon={<PackageCheck className="size-4 text-fuchsia-500" aria-hidden="true" />}
          title="uv inline and project"
          detail="Elements scenario package metadata plus detected pyproject.toml state."
        >
          <DependencyHeader
            dependencies={[...scenario.packageState.dependencies]}
            requiresPython={scenario.packageState.requiresPython}
            loading={false}
            onAdd={asyncNoop}
            onRemove={asyncNoop}
            onSetRequiresPython={asyncNoop}
            syncState={scenario.packageState.syncState}
            onSyncNow={asyncTrue}
            pyprojectInfo={scenario.packageState.pyprojectInfo}
            pyprojectDeps={scenario.packageState.pyprojectDeps}
            onImportFromPyproject={asyncNoop}
            onUseProjectEnv={asyncNoop}
            isUsingProjectEnv={false}
            justSynced={false}
          />
        </SurfaceFrame>

        <SurfaceFrame
          icon={<RefreshCw className="size-4 text-emerald-500" aria-hidden="true" />}
          title="Conda environment"
          detail="Fixture channels, environment.yml imports, and environment preparation progress."
        >
          <CondaDependencyHeader
            dependencies={["python=3.13", "scikit-learn", "seaborn"]}
            channels={["conda-forge", "nvidia"]}
            python="3.13"
            loading={false}
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
          detail="Fixture pixi.toml state with Conda and PyPI dependencies."
        >
          <PixiDependencyHeader
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
            syncState={{ status: "dirty", added: ["plotly"], removed: [] }}
            onSyncNow={asyncTrue}
            justSynced={false}
          />
        </SurfaceFrame>

        <SurfaceFrame
          icon={<TerminalSquare className="size-4 text-emerald-500" aria-hidden="true" />}
          title="Deno imports"
          detail="Fixture deno.json state and the flexible npm imports toggle."
        >
          <DenoDependencyHeader
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
          <h2 className="text-sm font-semibold">Adapter boundary</h2>
        </div>
        <p className="text-xs leading-5 text-fd-muted-foreground">
          This page owns only fixture metadata and inert callbacks. The rendered headers come from
          the notebook app, while live notebook metadata writes, daemon sync, and environment
          rebuilding stay outside the docs runtime.
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

function DependencySurfaceSkeleton({ label }: { label: string }) {
  return (
    <div className="border-b bg-fd-muted/30 px-3 py-3">
      <div className="mb-2 h-5 w-20 rounded bg-fd-muted" />
      <div className="rounded border border-fd-border bg-fd-background p-3">
        <div className="mb-2 h-4 w-44 rounded bg-fd-muted" />
        <div className="h-3 w-64 max-w-full rounded bg-fd-muted" />
      </div>
      <div className="mt-3 text-xs text-fd-muted-foreground">{label} loads on the client.</div>
    </div>
  );
}
