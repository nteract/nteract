"use client";

import { CheckCircle2, FileCode2, PackageCheck } from "lucide-react";
import type { ReactNode } from "react";
import { EnvironmentPackageSummaryPanel } from "@/components/environment";
import { NotebookPackageSummaryPanel } from "@/components/notebook";
import { getElementsNotebookScenario } from "@/components/notebook-scenarios";

const packageSurfaces = [
  {
    name: "EnvironmentPackageSummaryPanel",
    source: "src/components/environment/EnvironmentPackageSummaryPanel.tsx",
    manager: "listing",
    role: "Host-neutral declared-package listing for rails, cloud views, and read-only embeds.",
  },
  {
    name: "NotebookPackageSummaryPanel",
    source: "src/components/notebook/NotebookPackageSummaryPanel.tsx",
    manager: "rail",
    role: "Shared notebook rail wrapper for declared packages.",
  },
];

const packageBoundaryRows = [
  {
    boundary: "Package listing",
    catalogPath: "static package records",
    productionBoundary: "Automerge package state and project files",
    detail:
      "The package rail lists declared packages from the notebook projection. Manager-specific environment details stay out of this surface.",
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
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-fd-muted-foreground">
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
          title="Notebook rail package listing"
          detail="Shared package listing inside the notebook rail wrapper."
        >
          <div className="p-3">
            <NotebookPackageSummaryPanel packages={scenario.viewModel.packages} readOnly />
          </div>
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
