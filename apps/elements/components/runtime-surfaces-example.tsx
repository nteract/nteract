"use client";

import { AlertTriangle, CircleDot, PackageCheck, RotateCw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DependencyHeader } from "@/notebook-components/DependencyHeader";
import { EnvBuildDecisionDialog } from "@/notebook-components/EnvBuildDecisionDialog";
import { RuntimeDecisionDialog } from "@/notebook-components/RuntimeDecisionDialog";
import { TrustDialog } from "@/notebook-components/TrustDialog";

const noop = () => {};
const asyncNoop = async () => {};
const asyncTrue = async () => true;

const runtimePieces = [
  {
    name: "RuntimeDecisionDialog",
    source: "apps/notebook/src/components/RuntimeDecisionDialog.tsx",
    role: "Shared dialog shell for trust, environment build, and launch decisions.",
    status: "rendered",
  },
  {
    name: "TrustDialog",
    source: "apps/notebook/src/components/TrustDialog.tsx",
    role: "Dependency review gate with approved packages, typosquat warnings, and trust actions.",
    status: "rendered",
  },
  {
    name: "EnvBuildDecisionDialog",
    source: "apps/notebook/src/components/EnvBuildDecisionDialog.tsx",
    role: "Missing conda environment remediation with copy and create actions.",
    status: "rendered",
  },
  {
    name: "DependencyHeader",
    source: "apps/notebook/src/components/DependencyHeader.tsx",
    role: "Notebook dependency panel for uv metadata, pyproject state, and sync prompts.",
    status: "rendered",
  },
  {
    name: "KernelLaunchErrorBanner",
    source: "apps/notebook/src/components/KernelLaunchErrorBanner.tsx",
    role: "Launch failure banner is adapter-blocked because it imports runtimed value constants.",
    status: "adapter needed",
  },
];

const trustInfo = {
  status: "untrusted" as const,
  uv_dependencies: ["pandas>=2", "reqeusts[security]>=2.0"],
  approved_uv_dependencies: ["pandas>=2"],
  conda_dependencies: ["python=3.13", "scikit-learn"],
  approved_conda_dependencies: [],
  conda_channels: ["conda-forge"],
  approved_conda_channels: ["conda-forge"],
  pixi_dependencies: ["numpy"],
  approved_pixi_dependencies: [],
  pixi_pypi_dependencies: ["polars"],
  approved_pixi_pypi_dependencies: [],
  pixi_channels: ["conda-forge"],
  approved_pixi_channels: ["conda-forge"],
};

const typosquatWarnings = [
  {
    package: "reqeusts",
    similar_to: "requests",
    distance: 2,
  },
];

const envBuildDetails = `Environment named "mathnet" was not found.

conda env create -f /Users/kyle/notebooks/environment.yml

The declared environment includes Python 3.13, pandas, scikit-learn, and matplotlib.`;

function RuntimeDialogs() {
  const [trustOpen, setTrustOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [genericOpen, setGenericOpen] = useState(false);

  return (
    <div className="grid gap-3 lg:grid-cols-3" data-elements-slot="runtime-dialog-fixtures">
      <div className="rounded-lg border border-fd-border bg-fd-background p-4">
        <ShieldAlert className="mb-3 size-4 text-amber-500" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Trust review</h3>
        <p className="mt-2 min-h-[3rem] text-xs leading-5 text-fd-muted-foreground">
          Opens the current dependency trust dialog with approved and suspicious package fixtures.
        </p>
        <Button className="mt-4" size="sm" onClick={() => setTrustOpen(true)}>
          Open TrustDialog
        </Button>
        <TrustDialog
          open={trustOpen}
          onOpenChange={setTrustOpen}
          trustInfo={trustInfo}
          typosquatWarnings={typosquatWarnings}
          onApprove={asyncTrue}
          onApproveOnly={asyncTrue}
          onDecline={noop}
          daemonMode
          approvalError="Typosquat check completed with one warning. Review before trusting."
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
          Opens the shared runtime decision shell with catalog-owned fixture content.
        </p>
        <Button className="mt-4" size="sm" onClick={() => setGenericOpen(true)}>
          Open RuntimeDecisionDialog
        </Button>
        <RuntimeDecisionDialog
          open={genericOpen}
          onOpenChange={setGenericOpen}
          icon={<PackageCheck className="size-5 text-emerald-600" aria-hidden="true" />}
          title="Use project environment"
          description="This notebook can start with the detected project environment."
          footer={
            <>
              <Button variant="outline" onClick={() => setGenericOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => setGenericOpen(false)}>Use project env</Button>
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

function DependencyHeaderFixture() {
  return (
    <section
      className="overflow-hidden rounded-lg border border-fd-border bg-fd-card"
      data-elements-slot="dependency-header-fixture"
    >
      <div className="border-b border-fd-border p-4">
        <h2 className="text-sm font-semibold">DependencyHeader</h2>
        <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
          Rendered from the notebook app with fixture dependency state and inert async handlers.
        </p>
      </div>
      <DependencyHeader
        dependencies={["pandas>=2", "polars", "matplotlib"]}
        requiresPython=">=3.13"
        loading={false}
        onAdd={asyncNoop}
        onRemove={asyncNoop}
        onSetRequiresPython={asyncNoop}
        syncState={{ status: "dirty", added: ["scikit-learn"], removed: [] }}
        onSyncNow={asyncTrue}
        pyprojectInfo={{
          path: "/Users/kyle/notebooks/pyproject.toml",
          relative_path: "pyproject.toml",
          project_name: "mathnet",
          has_dependencies: true,
          dependency_count: 3,
          has_dev_dependencies: true,
          requires_python: ">=3.13",
          has_venv: true,
        }}
        pyprojectDeps={{
          path: "/Users/kyle/notebooks/pyproject.toml",
          relative_path: "pyproject.toml",
          project_name: "mathnet",
          dependencies: ["pandas>=2", "polars"],
          dev_dependencies: ["pytest"],
          requires_python: ">=3.13",
          index_url: null,
        }}
        onImportFromPyproject={asyncNoop}
        onUseProjectEnv={asyncNoop}
        isUsingProjectEnv={false}
        justSynced={false}
      />
    </section>
  );
}

export function RuntimeSurfacesExample() {
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

      <DependencyHeaderFixture />

      <section className="rounded-lg border border-fd-border bg-fd-card p-4">
        <div className="mb-4">
          <h2 className="text-sm font-semibold">Decision Dialogs</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            Dialogs are interactive fixtures so their fixed-position portals stay owned by the
            existing components.
          </p>
        </div>
        <RuntimeDialogs />
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
            <h2 className="text-sm font-semibold">Adapter Boundary</h2>
          </div>
          <p className="text-xs leading-5 text-fd-muted-foreground">
            Components that import runtime value constants or host-backed hooks should get a small
            fixture adapter before they move from adapter needed to rendered.
          </p>
        </div>
      </section>
    </div>
  );
}
