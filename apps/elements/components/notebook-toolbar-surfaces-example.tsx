"use client";

import { BadgeCheck, PanelTop, PlayCircle, TimerReset } from "lucide-react";
import type { ComponentProps } from "react";
import {
  KERNEL_ERROR_REASON,
  KERNEL_STATUS,
  RUNTIME_STATUS,
  type EnvProgressState,
} from "runtimed";
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

function toolbarProps(overrides: Partial<ToolbarProps> = {}): ToolbarProps {
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
    focusedCellId: "cell-clean-columns",
    lastCellId: "cell-findings",
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

const statusSurfaces = [
  {
    title: "Idle Python notebook",
    source: "apps/notebook/src/components/NotebookToolbar.tsx",
    role: "Normal editing state with uv inline dependency metadata and running kernel controls.",
    props: toolbarProps(),
  },
  {
    title: "Busy with dependency restart",
    source: "apps/notebook/src/components/NotebookToolbar.tsx",
    role: "Execution state with the interrupt affordance highlighted and restart-and-run-all marked by dirty dependencies.",
    props: toolbarProps({
      kernelStatus: KERNEL_STATUS.BUSY,
      statusKey: RUNTIME_STATUS.RUNNING_BUSY,
      lifecycle: runningBusy,
      envSource: "conda:inline",
      depsOutOfSync: true,
      isDepsOpen: true,
    }),
  },
  {
    title: "Environment preparation",
    source: "apps/notebook/src/components/NotebookToolbar.tsx",
    role: "Conda solve/install progress shown through the toolbar status slot without live daemon state.",
    props: toolbarProps({
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
    role: "Pre-launch approval state using the same runtime vocabulary as the notebook app.",
    props: toolbarProps({
      kernelStatus: KERNEL_STATUS.STARTING,
      statusKey: RUNTIME_STATUS.AWAITING_TRUST,
      lifecycle: { lifecycle: "AwaitingTrust" },
      envSource: null,
      envTypeHint: "uv",
    }),
  },
  {
    title: "Deno runtime unavailable",
    source: "apps/notebook/src/components/NotebookToolbar.tsx",
    role: "Deno install remediation banner driven by fixture error text and inert callbacks.",
    props: toolbarProps({
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
    role: "Python runtime error branch for pixi.toml notebooks that need an explicit ipykernel dependency.",
    props: toolbarProps({
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
    role: "Copyable environment creation hint surfaced by the toolbar when the declared conda env is absent.",
    props: toolbarProps({
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
    role: "Desktop update action rendered beside runtime status while the notebook remains idle.",
    props: toolbarProps({
      updateStatus: "available",
      updateVersion: "2.5.3",
      onRestartToUpdate: noop,
    }),
  },
];

const contractItems = [
  {
    icon: BadgeCheck,
    title: "Current source",
    body: "Every preview imports NotebookToolbar from the notebook app and feeds it fixture props only.",
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

export function NotebookToolbarSurfacesExample() {
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
    </div>
  );
}
