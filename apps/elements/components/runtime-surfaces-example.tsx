"use client";

import { NotebookHostProvider } from "@nteract/notebook-host";
import {
  AlertTriangle,
  CircleDot,
  GitBranch,
  PackageCheck,
  RotateCw,
  Server,
  ShieldAlert,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  asyncNoop,
  asyncTrue,
  createFixtureNotebookHost,
  noop,
} from "@/components/fixture-notebook-host";
import { NotebookNotice, NotebookNoticeAction } from "@/components/notebook";
import { DaemonStatusBanner } from "@/notebook-components/DaemonStatusBanner";
import { DebugBanner } from "@/notebook-components/DebugBanner";
import { UvDependencyPanel } from "@/components/environment";
import { EnvBuildDecisionDialog } from "@/notebook-components/EnvBuildDecisionDialog";
import { KernelLaunchErrorBanner } from "@/notebook-components/KernelLaunchErrorBanner";
import { PoolErrorBanner } from "@/notebook-components/PoolErrorBanner";
import { RuntimeDecisionDialog } from "@/notebook-components/RuntimeDecisionDialog";
import { TrustDialog } from "@/notebook-components/TrustDialog";
import { UntrustedBanner } from "@/notebook-components/UntrustedBanner";
import {
  getElementsNotebookScenario,
  type ElementsNotebookScenario,
} from "@/components/notebook-scenarios";

const runtimePieces = [
  {
    name: "NotebookNotice",
    source: "src/components/notebook/NotebookNotice.tsx",
    role: "Shared notice primitive for desktop daemon/runtime notices and cloud room/auth/sync notices.",
    status: "rendered",
  },
  {
    name: "RuntimeDecisionDialog",
    source: "apps/notebook/src/components/RuntimeDecisionDialog.tsx",
    role: "Shared dialog shell for trust, environment build, and launch decisions.",
    status: "rendered",
  },
  {
    name: "TrustDialog",
    source: "apps/notebook/src/components/TrustDialog.tsx",
    role: "Package trust gate with approved packages, typosquat warnings, and trust actions.",
    status: "rendered",
  },
  {
    name: "EnvBuildDecisionDialog",
    source: "apps/notebook/src/components/EnvBuildDecisionDialog.tsx",
    role: "Missing conda environment remediation with copy and create actions.",
    status: "rendered",
  },
  {
    name: "UvDependencyPanel",
    source: "src/components/environment/UvDependencyPanel.tsx",
    role: "Notebook package panel for uv package details, pyproject state, and sync prompts.",
    status: "rendered",
  },
  {
    name: "KernelLaunchErrorBanner",
    source: "apps/notebook/src/components/KernelLaunchErrorBanner.tsx",
    role: "Generic launch failure remediation with stderr details, copy, retry, and dismiss actions.",
    status: "rendered",
  },
  {
    name: "DaemonStatusBanner",
    source: "apps/notebook/src/components/DaemonStatusBanner.tsx",
    role: "Daemon progress and failure state surfaced before the notebook runtime is usable.",
    status: "rendered",
  },
  {
    name: "PoolErrorBanner",
    source: "apps/notebook/src/components/PoolErrorBanner.tsx",
    role: "Package manager pool warming failures with a host-provided settings action.",
    status: "rendered",
  },
  {
    name: "UntrustedBanner",
    source: "apps/notebook/src/components/UntrustedBanner.tsx",
    role: "Inline package approval gate that opens TrustDialog before kernel start.",
    status: "rendered",
  },
  {
    name: "DebugBanner",
    source: "apps/notebook/src/components/DebugBanner.tsx",
    role: "Development branch, commit, and daemon-version chrome for local notebook builds.",
    status: "rendered",
  },
];

const runtimeAdapterRows = [
  {
    boundary: "Desktop host actions",
    previewPath: "NotebookHostProvider fixture",
    notebookOwner: "notebook shell host commands",
    detail:
      "Pool settings, clipboard, and command callbacks stay inert in the preview while the notebook routes them through the host bridge.",
  },
  {
    boundary: "Runtime side effects",
    previewPath: "static decisions with async no-ops",
    notebookOwner: "daemon and kernel lifecycle",
    detail:
      "Trust, environment build, retry, dismiss, and sync actions render with the current components but do not start kernels or change runtime state.",
  },
  {
    boundary: "Package and trust state",
    previewPath: "typed fixture records",
    notebookOwner: "settings, pyproject, and RuntimeStateDoc updates",
    detail:
      "The preview owns deterministic package, typosquat, and pyproject facts; live settings and runtime documents stay outside the docs app.",
  },
];

const fixtureHost = createFixtureNotebookHost();

const envBuildDetails = `Environment named "mathnet" was not found.

conda env create -f /Users/kyle/notebooks/environment.yml

The declared environment includes Python 3.13, pandas, scikit-learn, and matplotlib.`;

const kernelLaunchError = [
  "Kernel process exited immediately: exit status: 1",
  "stderr tail:",
  "/Users/kyle/notebooks/.venv/bin/python: No module named nteract_kernel_launcher",
  "hint: rebuild the environment or verify the project interpreter.",
].join("\n");

function RuntimeDialogs({ scenario }: { scenario: ElementsNotebookScenario }) {
  const [trustOpen, setTrustOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [decisionShellOpen, setDecisionShellOpen] = useState(false);

  return (
    <div className="grid gap-3 lg:grid-cols-3" data-elements-slot="runtime-dialog-fixtures">
      <div className="rounded-lg border border-fd-border bg-fd-background p-4">
        <ShieldAlert className="mb-3 size-4 text-amber-500" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Trust review</h3>
        <p className="mt-2 min-h-[3rem] text-xs leading-5 text-fd-muted-foreground">
          Opens the current package trust dialog with approved and suspicious package fixtures.
        </p>
        <Button className="mt-4" size="sm" onClick={() => setTrustOpen(true)}>
          Open TrustDialog
        </Button>
        <TrustDialog
          open={trustOpen}
          onOpenChange={setTrustOpen}
          trustInfo={scenario.trustState.trustInfo}
          typosquatWarnings={[...scenario.trustState.typosquatWarnings]}
          onApprove={asyncTrue}
          onApproveOnly={asyncTrue}
          onDecline={noop}
          daemonMode
          approvalError={scenario.trustState.approvalError}
        />
      </div>

      <div className="rounded-lg border border-fd-border bg-fd-background p-4">
        <RotateCw className="mb-3 size-4 text-amber-500" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Environment build</h3>
        <p className="mt-2 min-h-[3rem] text-xs leading-5 text-fd-muted-foreground">
          Opens the current environment.yml remediation dialog with a fixture daemon error.
        </p>
        <Button className="mt-4" size="sm" onClick={() => setEnvOpen(true)}>
          Open EnvBuildDecisionDialog
        </Button>
        <EnvBuildDecisionDialog
          open={envOpen}
          onOpenChange={setEnvOpen}
          errorDetails={envBuildDetails}
          onCreate={noop}
        />
      </div>

      <div className="rounded-lg border border-fd-border bg-fd-background p-4">
        <PackageCheck className="mb-3 size-4 text-emerald-600" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Decision shell</h3>
        <p className="mt-2 min-h-[3rem] text-xs leading-5 text-fd-muted-foreground">
          Opens the shared runtime decision shell with preview-owned fixture content.
        </p>
        <Button className="mt-4" size="sm" onClick={() => setDecisionShellOpen(true)}>
          Open RuntimeDecisionDialog
        </Button>
        <RuntimeDecisionDialog
          open={decisionShellOpen}
          onOpenChange={setDecisionShellOpen}
          icon={<PackageCheck className="size-5 text-emerald-600" aria-hidden="true" />}
          title="Use project environment"
          description="This notebook can start with the detected project environment."
          footer={
            <>
              <Button variant="outline" onClick={() => setDecisionShellOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => setDecisionShellOpen(false)}>Use project env</Button>
            </>
          }
        >
          <div className="rounded-md border bg-muted/50 p-3 text-sm">
            <div className="font-mono text-xs">pyproject.toml · Python &gt;=3.13</div>
            <div className="mt-2 text-muted-foreground">
              pandas, polars, scikit-learn, matplotlib
            </div>
          </div>
        </RuntimeDecisionDialog>
      </div>
    </div>
  );
}

function DependencyHeaderFixture({ scenario }: { scenario: ElementsNotebookScenario }) {
  return (
    <section
      className="overflow-hidden rounded-lg border border-fd-border bg-fd-card"
      data-elements-slot="dependency-header-fixture"
    >
      <div className="border-b border-fd-border p-4">
        <h2 className="text-sm font-semibold">UvDependencyPanel</h2>
        <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
          Rendered from the notebook app in the same rail-sized package surface used by the notebook
          shell.
        </p>
      </div>
      <div className="bg-fd-muted/20 p-4">
        <div className="mx-auto w-[clamp(15rem,20vw,17rem)] max-w-full">
          <UvDependencyPanel
            dependencies={[...scenario.packageState.dependencies]}
            requiresPython={scenario.packageState.requiresPython}
            loading={false}
            variant="rail"
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
        </div>
      </div>
    </section>
  );
}

function RuntimeBanners() {
  return (
    <section
      className="overflow-hidden rounded-lg border border-fd-border bg-fd-card"
      data-elements-slot="runtime-banner-fixtures"
    >
      <div className="border-b border-fd-border p-4">
        <h2 className="text-sm font-semibold">Runtime Banners</h2>
        <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
          Rendered from notebook app components with inert callbacks and a fixture notebook host
          where a settings action would otherwise reach the desktop shell.
        </p>
      </div>
      <div className="divide-y divide-fd-border">
        <BannerFixture
          icon={<AlertTriangle className="size-4" aria-hidden="true" />}
          name="NotebookNotice"
          description="Host-neutral notice shell; desktop and cloud decide policy and actions."
        >
          <NotebookNotice
            tone="warning"
            icon={<AlertTriangle className="h-4 w-4" />}
            title="Document attention needed."
            actions={<NotebookNoticeAction onClick={noop}>Review</NotebookNoticeAction>}
          >
            The host owns what happened; the notebook shell owns how the notice sits with the
            document.
          </NotebookNotice>
        </BannerFixture>

        <BannerFixture
          icon={<GitBranch className="size-4" aria-hidden="true" />}
          name="DebugBanner"
          description="Development build chrome for branch, commit, and daemon version."
        >
          <DebugBanner
            branch="quod/elements-runtime-banners"
            commit="755b6f6d"
            description="docs catalog"
            daemonVersion="2.5.2-nightly+755b6f6d"
            isDevMode
          />
        </BannerFixture>

        <BannerFixture
          icon={<Server className="size-4" aria-hidden="true" />}
          name="DaemonStatusBanner"
          description="Startup progress and daemon failure states."
        >
          <div className="space-y-2">
            <DaemonStatusBanner
              status={{ status: "waiting_for_ready", attempt: 2, max_attempts: 8 }}
            />
            <DaemonStatusBanner
              status={{
                status: "failed",
                error: "Socket connection timed out",
                guidance: "Check that the dev daemon is running for this worktree.",
              }}
              onDismiss={noop}
              onRetry={noop}
            />
          </div>
        </BannerFixture>

        <BannerFixture
          icon={<AlertTriangle className="size-4" aria-hidden="true" />}
          name="PoolErrorBanner"
          description="Pool warming warnings for package manager defaults."
        >
          <NotebookHostProvider host={fixtureHost}>
            <PoolErrorBanner
              uvError={{
                message: "Failed to warm uv environment",
                failed_package: "reqeusts",
                error_kind: "invalid_package",
                consecutive_failures: 3,
                retry_in_secs: 60,
                receivedAt: Date.now(),
              }}
              condaError={{
                message: "Conda solve timed out",
                failed_package: "scikit-learn",
                error_kind: "timeout",
                consecutive_failures: 1,
                retry_in_secs: 30,
                receivedAt: Date.now(),
              }}
              pixiError={null}
              onDismissUv={noop}
              onDismissConda={noop}
              onDismissPixi={noop}
            />
          </NotebookHostProvider>
        </BannerFixture>

        <BannerFixture
          icon={<ShieldAlert className="size-4" aria-hidden="true" />}
          name="UntrustedBanner"
          description="Inline trust gate before package-backed kernel start."
        >
          <UntrustedBanner onReviewClick={noop} />
        </BannerFixture>

        <BannerFixture
          icon={<AlertTriangle className="size-4" aria-hidden="true" />}
          name="KernelLaunchErrorBanner"
          description="Generic launch failure details after typed remediation cases are excluded."
        >
          <KernelLaunchErrorBanner
            errorDetails={kernelLaunchError}
            onRetry={noop}
            onDismiss={noop}
          />
        </BannerFixture>
      </div>
    </section>
  );
}

function BannerFixture({
  children,
  description,
  icon,
  name,
}: {
  children: ReactNode;
  description: string;
  icon: ReactNode;
  name: string;
}) {
  return (
    <div className="grid gap-3 p-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <div>
        <div className="flex items-center gap-2 text-fd-muted-foreground">
          {icon}
          <h3 className="text-sm font-semibold text-fd-foreground">{name}</h3>
        </div>
        <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0 overflow-hidden rounded-md border border-fd-border bg-fd-background">
        {children}
      </div>
    </div>
  );
}

export function RuntimeSurfacesExample() {
  const scenario = getElementsNotebookScenario("runtime-unavailable");

  return (
    <div className="not-prose space-y-6">
      <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-900 dark:text-emerald-900">
        <div className="flex items-start gap-3">
          <PackageCheck className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Runtime-free fixture rule</h2>
            <p className="mt-1 text-xs leading-5">
              This page imports current runtime decision components and feeds them fixture props. It
              does not import notebook runtime hooks, sync state, generated WASM, or daemon host
              state.
            </p>
          </div>
        </div>
      </section>

      <DependencyHeaderFixture scenario={scenario} />

      <RuntimeBanners />

      <section className="rounded-lg border border-fd-border bg-fd-card p-4">
        <div className="mb-4">
          <h2 className="text-sm font-semibold">Decision Dialogs</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            Dialogs are interactive fixtures so their fixed-position portals stay owned by the
            existing components.
          </p>
        </div>
        <RuntimeDialogs scenario={scenario} />
      </section>

      <section className="grid gap-3">
        <div className="rounded-lg border border-fd-border bg-fd-card">
          <div className="border-b border-fd-border p-4">
            <h2 className="text-sm font-semibold">Current Pieces</h2>
          </div>
          <div className="divide-y divide-fd-border">
            {runtimePieces.map((piece) => (
              <div
                key={piece.name}
                className="grid gap-3 p-4 md:grid-cols-[210px_minmax(0,1fr)_130px]"
              >
                <div>
                  <div className="text-sm font-semibold">{piece.name}</div>
                  <div className="mt-1 break-words font-mono text-xs text-fd-muted-foreground [overflow-wrap:anywhere]">
                    {piece.source}
                  </div>
                </div>
                <p className="text-xs leading-5 text-fd-muted-foreground">{piece.role}</p>
                <div>
                  <span className="inline-flex items-center gap-1 rounded-full border border-fd-border bg-fd-background px-2 py-1 text-[11px] text-fd-muted-foreground">
                    {piece.status === "rendered" ? (
                      <PackageCheck className="size-3 text-emerald-600" aria-hidden="true" />
                    ) : (
                      <AlertTriangle className="size-3 text-amber-600" aria-hidden="true" />
                    )}
                    {piece.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-fd-border bg-fd-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <CircleDot className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Live work stays with the notebook</h2>
          </div>
          <p className="text-xs leading-5 text-fd-muted-foreground">
            Components that need runtime values, daemon actions, or host-backed hooks should name
            the notebook-owned work first, then move through a small preview fixture before joining
            the rendered catalog.
          </p>
          <div className="mt-4 overflow-hidden rounded-md border border-fd-border">
            <div className="hidden grid-cols-[190px_210px_230px_minmax(0,1fr)] gap-3 border-b border-fd-border bg-fd-muted/40 px-3 py-2 text-[11px] font-medium uppercase text-fd-muted-foreground xl:grid">
              <span>Boundary</span>
              <span>Preview uses</span>
              <span>Notebook owns</span>
              <span>Notes</span>
            </div>
            {runtimeAdapterRows.map((row) => (
              <div
                key={row.boundary}
                className="grid gap-2 border-b border-fd-border px-3 py-3 text-xs last:border-b-0 xl:grid-cols-[190px_210px_230px_minmax(0,1fr)] xl:gap-3"
              >
                <div>
                  <div className="text-[11px] font-medium uppercase text-fd-muted-foreground xl:hidden">
                    Boundary
                  </div>
                  <div className="font-semibold">{row.boundary}</div>
                </div>
                <div>
                  <div className="text-[11px] font-medium uppercase text-fd-muted-foreground xl:hidden">
                    Preview uses
                  </div>
                  <div className="font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
                    {row.previewPath}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-medium uppercase text-fd-muted-foreground xl:hidden">
                    Notebook owns
                  </div>
                  <div className="font-mono text-[11px] text-amber-700 dark:text-amber-300">
                    {row.notebookOwner}
                  </div>
                </div>
                <p className="leading-5 text-fd-muted-foreground">{row.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
