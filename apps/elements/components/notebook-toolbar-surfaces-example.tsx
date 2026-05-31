"use client";

import { BadgeCheck, CircleDot, PanelTop, PlayCircle, TimerReset } from "lucide-react";
import type { ComponentProps } from "react";
import {
  KERNEL_ERROR_REASON,
  KERNEL_STATUS,
  RUNTIME_STATUS,
  type EnvProgressState,
} from "runtimed";
import {
  getElementsNotebookScenario,
  type ElementsNotebookScenario,
  type ElementsNotebookScenarioId,
} from "@/components/notebook-scenarios";
import { NotebookToolbar } from "@/notebook-components/NotebookToolbar";

type ToolbarProps = ComponentProps<typeof NotebookToolbar>;

const noop = () => {};

const runningIdle = { lifecycle: "Running", activity: "Idle" } as const;
const runningBusy = { lifecycle: "Running", activity: "Busy" } as const;
const errorLifecycle = { lifecycle: "Error" } as const;

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

const condaEnvMissingDetails =
  "environment.yml declares conda env 'analysis', which is not built on this machine. Run: conda env create -f /work/notebooks/environment.yml";

interface ToolbarSurface {
  title: string;
  source: string;
  role: string;
  scenario: ElementsNotebookScenario;
  props: ToolbarProps;
}

function toolbarProps(
  scenario: ElementsNotebookScenario,
  overrides: Partial<ToolbarProps> = {},
): ToolbarProps {
  const firstRunnableCell = scenario.cells.find((cell) => cell.cellType === "code");
  const cellIds = scenario.viewModel.cellIds;

  return {
    kernelStatus: KERNEL_STATUS.IDLE,
    statusKey: RUNTIME_STATUS.RUNNING_IDLE,
    lifecycle: runningIdle,
    errorReason: null,
    kernelErrorMessage: null,
    envSource: "uv:inline",
    envTypeHint: "uv",
    envProgress: null,
    runtime: "python",
    focusedCellId: firstRunnableCell?.id ?? cellIds[0] ?? null,
    lastCellId: cellIds[cellIds.length - 1] ?? null,
    canEditStructure: scenario.capabilities.canEditStructure,
    canExecute: scenario.capabilities.canExecute,
    canViewPackages: scenario.capabilities.canViewPackages,
    onStartKernel: noop,
    onInterruptKernel: noop,
    onRestartKernel: noop,
    onRunAllCells: noop,
    onRestartAndRunAll: noop,
    onAddCell: noop,
    onToggleDependencies: noop,
    ...overrides,
  };
}

function scenario(id: ElementsNotebookScenarioId) {
  return getElementsNotebookScenario(id);
}

function createStatusSurfaces(): ToolbarSurface[] {
  const desktopOwner = scenario("desktop-local-owner");
  const cloudViewer = scenario("cloud-public-viewer");
  const cloudEditor = scenario("cloud-editor");
  const runtimeUnavailable = scenario("runtime-unavailable");

  return [
    {
      title: "Idle Python notebook",
      source: "apps/notebook/src/components/NotebookToolbar.tsx",
      scenario: desktopOwner,
      role: `${desktopOwner.runtimeLabel}; normal editing state with uv inline dependency metadata and running kernel controls.`,
      props: toolbarProps(desktopOwner),
    },
    {
      title: "Busy with dependency restart",
      source: "apps/notebook/src/components/NotebookToolbar.tsx",
      scenario: desktopOwner,
      role: `Execution state from ${desktopOwner.title}; restart-and-run-all is marked by ${desktopOwner.packageState.syncState.status} dependency metadata.`,
      props: toolbarProps(desktopOwner, {
        kernelStatus: KERNEL_STATUS.BUSY,
        statusKey: RUNTIME_STATUS.RUNNING_BUSY,
        lifecycle: runningBusy,
        envSource: "conda:inline",
        depsOutOfSync: desktopOwner.packageState.syncState.status === "dirty",
        isDepsOpen: desktopOwner.capabilities.canViewPackages,
      }),
    },
    {
      title: "Environment preparation",
      source: "apps/notebook/src/components/NotebookToolbar.tsx",
      scenario: cloudEditor,
      role: `${cloudEditor.title} can edit markdown, but this fixture keeps execution detached while conda solve/install progress renders.`,
      props: toolbarProps(cloudEditor, {
        kernelStatus: KERNEL_STATUS.STARTING,
        statusKey: RUNTIME_STATUS.PREPARING_ENV,
        lifecycle: { lifecycle: "PreparingEnv" },
        envSource: null,
        envTypeHint: "conda",
        envProgress: condaProgress,
      }),
    },
    {
      title: "Awaiting trust approval",
      source: "apps/notebook/src/components/NotebookToolbar.tsx",
      scenario: runtimeUnavailable,
      role: `${runtimeUnavailable.title} reuses the shared trust fixture before launch instead of opening a live runtime.`,
      props: toolbarProps(runtimeUnavailable, {
        kernelStatus: KERNEL_STATUS.STARTING,
        statusKey: RUNTIME_STATUS.AWAITING_TRUST,
        lifecycle: { lifecycle: "AwaitingTrust" },
        envSource: null,
        envTypeHint: "uv",
      }),
    },
    {
      title: "Published viewer with no kernel",
      source: "apps/notebook/src/components/NotebookToolbar.tsx",
      scenario: cloudViewer,
      role: `${cloudViewer.title} uses the same fixture notebook IDs while exposing read-only, published access context.`,
      props: toolbarProps(cloudViewer, {
        kernelStatus: KERNEL_STATUS.ERROR,
        statusKey: RUNTIME_STATUS.ERROR,
        lifecycle: errorLifecycle,
        envSource: null,
        envTypeHint: null,
        kernelErrorMessage: cloudViewer.runtimeLabel,
      }),
    },
    {
      title: "Deno runtime unavailable",
      source: "apps/notebook/src/components/NotebookToolbar.tsx",
      scenario: runtimeUnavailable,
      role: "Deno install remediation banner driven by fixture error text and inert callbacks.",
      props: toolbarProps(runtimeUnavailable, {
        kernelStatus: KERNEL_STATUS.ERROR,
        statusKey: RUNTIME_STATUS.ERROR,
        lifecycle: errorLifecycle,
        runtime: "deno",
        envSource: "deno:imports",
        envTypeHint: null,
        kernelErrorMessage: "deno executable not found on PATH",
      }),
    },
    {
      title: "Pixi missing ipykernel",
      source: "apps/notebook/src/components/NotebookToolbar.tsx",
      scenario: runtimeUnavailable,
      role: "Python runtime error branch for pixi.toml notebooks that need an explicit ipykernel dependency.",
      props: toolbarProps(runtimeUnavailable, {
        kernelStatus: KERNEL_STATUS.ERROR,
        statusKey: RUNTIME_STATUS.ERROR,
        lifecycle: errorLifecycle,
        errorReason: KERNEL_ERROR_REASON.MISSING_IPYKERNEL,
        envSource: "pixi:toml",
        envTypeHint: "pixi",
      }),
    },
    {
      title: "Conda environment.yml missing",
      source: "apps/notebook/src/components/NotebookToolbar.tsx",
      scenario: runtimeUnavailable,
      role: "Copyable environment creation hint surfaced by the toolbar when the declared conda env is absent.",
      props: toolbarProps(runtimeUnavailable, {
        kernelStatus: KERNEL_STATUS.ERROR,
        statusKey: RUNTIME_STATUS.ERROR,
        lifecycle: errorLifecycle,
        errorReason: KERNEL_ERROR_REASON.CONDA_ENV_YML_MISSING,
        envSource: "conda:env_yml",
        envTypeHint: "conda",
        kernelErrorMessage: condaEnvMissingDetails,
      }),
    },
    {
      title: "Update ready",
      source: "apps/notebook/src/components/NotebookToolbar.tsx",
      scenario: desktopOwner,
      role: "Desktop update action rendered beside runtime status while the notebook remains idle.",
      props: toolbarProps(desktopOwner, {
        updateStatus: "available",
        updateVersion: "2.5.3",
        onRestartToUpdate: noop,
      }),
    },
  ];
}

const contractItems = [
  {
    icon: BadgeCheck,
    title: "Current source",
    body: "Every preview imports NotebookToolbar from the notebook app and starts from a shared Elements scenario.",
  },
  {
    icon: PlayCircle,
    title: "Runtime-free",
    body: "Kernel actions, dependency toggles, update clicks, and cell insertion callbacks are inert.",
  },
  {
    icon: TimerReset,
    title: "Status vocabulary",
    body: "Fixtures cover idle, busy, preparing, trust, error, and update states from the real runtime labels.",
  },
];

const toolbarBoundaryRows = [
  {
    boundary: "Runtime status projection",
    catalogPath: "ElementsNotebookScenario -> toolbarProps(status overrides)",
    productionBoundary: "RuntimeStateDoc + kernel lifecycle",
    detail:
      "The catalog starts with deterministic scenario facts, then applies runtime status overrides. Production derives those fields from runtime state, kernel lifecycle, environment progress, and launch errors.",
  },
  {
    boundary: "Kernel actions",
    catalogPath: "inert callbacks",
    productionBoundary: "Notebook action handlers",
    detail:
      "Start, interrupt, restart, run-all, and restart-and-run-all buttons render here without side effects. The notebook app wires them to execution and runtime control paths.",
  },
  {
    boundary: "Dependency drawer",
    catalogPath: "scenario.packageState + inert toggle",
    productionBoundary: "Package rail and notebook metadata",
    detail:
      "The fixture reads package sync state from the shared scenario and toggles visual dependency state only. Production opens package UI, writes notebook metadata, and coordinates environment rebuild decisions.",
  },
  {
    boundary: "Cell insertion",
    catalogPath: "scenario.viewModel.cellIds",
    productionBoundary: "NotebookView focus and CRDT mutation",
    detail:
      "The add-cell affordance receives stable IDs from the shared scenario projection. Production inserts new cells through the notebook document and restores editor focus.",
  },
  {
    boundary: "Desktop update restart",
    catalogPath: "updateStatus + onRestartToUpdate",
    productionBoundary: "Tauri updater host action",
    detail:
      "The update-ready surface renders with a no-op restart callback. Desktop builds still own update installation and app restart behavior outside the docs runtime.",
  },
];

export function NotebookToolbarSurfacesExample() {
  const statusSurfaces = createStatusSurfaces();

  return (
    <div className="not-prose space-y-6" data-elements-slot="notebook-toolbar-surfaces">
      <section className="grid gap-3 md:grid-cols-3">
        {contractItems.map((item) => (
          <div key={item.title} className="rounded-lg border border-fd-border bg-fd-card p-4">
            <item.icon className="mb-3 size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">{item.title}</h2>
            <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{item.body}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-4">
        {statusSurfaces.map((surface) => (
          <article
            key={surface.title}
            className="overflow-hidden rounded-lg border border-fd-border bg-fd-card"
          >
            <div className="flex flex-col gap-3 border-b border-fd-border p-4 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2">
                  <PanelTop
                    className="size-4 shrink-0 text-fd-muted-foreground"
                    aria-hidden="true"
                  />
                  <h2 className="text-sm font-semibold">{surface.title}</h2>
                </div>
                <p className="max-w-3xl text-xs leading-5 text-fd-muted-foreground">
                  {surface.role}
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-fd-muted-foreground">
                  <ScenarioPill label={surface.scenario.title} />
                  <ScenarioPill
                    label={`${surface.scenario.capabilities.access.source}:${surface.scenario.capabilities.access.level}`}
                  />
                  <ScenarioPill
                    label={
                      surface.scenario.capabilities.canExecute
                        ? "execution available"
                        : "execution disabled"
                    }
                  />
                  <ScenarioPill label={`${surface.scenario.viewModel.codeCellCount} code cells`} />
                </div>
              </div>
              <div className="break-words font-mono text-[11px] leading-5 text-fd-muted-foreground [overflow-wrap:anywhere] md:max-w-72 md:text-right">
                {surface.source}
              </div>
            </div>
            <div className="overflow-hidden bg-fd-background">
              <div className="min-w-[760px]">
                <NotebookToolbar {...surface.props} />
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className="rounded-lg border border-dashed border-fd-border bg-fd-background p-4">
        <div className="mb-3 flex items-center gap-2">
          <CircleDot className="size-4 text-fd-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Adapter boundary</h2>
        </div>
        <p className="text-xs leading-5 text-fd-muted-foreground">
          NotebookToolbar renders from the production component, but this page owns only static
          status props and inert callbacks. Runtime state, kernel controls, dependency writes, cell
          insertion, and desktop update restarts stay behind the notebook app adapters.
        </p>
        <div className="mt-4 grid gap-2">
          {toolbarBoundaryRows.map((row) => (
            <div
              key={row.boundary}
              className="rounded-md border border-fd-border bg-fd-card p-3 text-xs"
            >
              <div className="grid gap-3 md:grid-cols-[150px_minmax(0,1fr)]">
                <div className="font-semibold">{row.boundary}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                      Catalog path
                    </div>
                    <div className="mt-1 break-words font-mono text-[11px] leading-4 text-emerald-700 dark:text-emerald-300">
                      {row.catalogPath}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                      Production boundary
                    </div>
                    <div className="mt-1 break-words font-mono text-[11px] leading-4 text-amber-700 dark:text-amber-300">
                      {row.productionBoundary}
                    </div>
                  </div>
                </div>
              </div>
              <p className="mt-3 leading-5 text-fd-muted-foreground">{row.detail}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ScenarioPill({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-fd-border bg-fd-background px-2 py-0.5">
      {label}
    </span>
  );
}
