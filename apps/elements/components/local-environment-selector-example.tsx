"use client";

import { useState } from "react";
import type {
  CondaEnvironmentInventory,
  EnvironmentSelectionSnapshot,
  InstalledKernelspec,
  KernelspecCatalogState,
  LocalCondaEnvironment,
  LocalEnvironmentTarget,
} from "runtimed";
import {
  LocalEnvironmentSelector,
  type LocalEnvironmentSelectorProps,
} from "../../../src/components/environment/LocalEnvironmentSelector";
import { Button } from "../../../src/components/ui/button";

const rankings: LocalCondaEnvironment = {
  id: "conda:rankings",
  name: "rankings",
  prefix: "/opt/conda/envs/rankings",
  python_path: "/opt/conda/envs/rankings/bin/python",
  python_version: "3.12",
};

const julia: InstalledKernelspec = {
  name: "julia-1.11",
  display_name: "Julia 1.11",
  language: "julia",
};
const ir: InstalledKernelspec = { name: "ir", display_name: "R", language: "R" };
const longName: InstalledKernelspec = {
  name: "conda-env-research-platform-forecasting-py312-gpu",
  display_name: "Python 3.12 (research-platform-forecasting, GPU build)",
  language: "python",
};

const condaInventory: CondaEnvironmentInventory = {
  environments: [rankings],
  truncated: false,
  warnings: [],
};

const kernels: KernelspecCatalogState = {
  status: "ready",
  seq: 1,
  inventory: { kernelspecs: [julia, ir, longName], warnings: [], truncated: false },
};

const automaticRunning = { id: null, name: "Managed Python environment", pythonVersion: "3.13" };
const denoRunning = { id: null, name: "Deno", pythonVersion: null };
const juliaRunning = {
  id: "kernelspec:julia-1.11",
  name: "Julia 1.11",
  pythonVersion: null,
  language: "julia",
};

type Fixture = Pick<
  LocalEnvironmentSelectorProps,
  "available" | "selection" | "kernelspecCatalog" | "running" | "error" | "condaAvailable"
> & { label: string; note: string };

function snapshot(
  overrides: Partial<EnvironmentSelectionSnapshot> = {},
): EnvironmentSelectionSnapshot {
  return { revision: 1, selected: null, applied: null, applying: false, ...overrides };
}

const fixtures: Record<string, Fixture> = {
  automatic: {
    label: "Automatic",
    note: "Managed environment running. Nothing staged.",
    available: true,
    selection: snapshot(),
    kernelspecCatalog: kernels,
    running: automaticRunning,
    error: null,
  },
  staged: {
    label: "Kernel staged",
    note: "A kernel is selected for the next start. The managed environment is still running.",
    available: true,
    selection: snapshot({ revision: 2, selected_kernelspec: julia }),
    kernelspecCatalog: kernels,
    running: automaticRunning,
    error: null,
  },
  starting: {
    label: "Starting",
    note: "Apply is in progress. Nothing is reported as running.",
    available: true,
    selection: snapshot({ revision: 3, selected_kernelspec: julia, applying: true }),
    kernelspecCatalog: kernels,
    running: null,
    error: null,
  },
  applied: {
    label: "Kernel running",
    note: "The staged kernel is the running kernel. No apply action is offered.",
    available: true,
    selection: snapshot({ revision: 4, selected_kernelspec: julia, applied_kernelspec: julia }),
    kernelspecCatalog: kernels,
    running: juliaRunning,
    error: null,
  },
  conda: {
    label: "Conda staged",
    note: "A Conda environment replaces the staged kernel. The kernel keeps running until applied.",
    available: true,
    selection: snapshot({ revision: 5, selected: rankings, applied_kernelspec: julia }),
    kernelspecCatalog: kernels,
    running: juliaRunning,
    error: null,
  },
  missing: {
    label: "Kernel missing",
    note: "The staged kernel is no longer installed. It stays selected and the daemon's rejection is shown.",
    available: true,
    selection: snapshot({ revision: 6, selected_kernelspec: julia }),
    kernelspecCatalog: {
      status: "ready",
      seq: 2,
      inventory: { kernelspecs: [ir], warnings: [], truncated: false },
    },
    running: automaticRunning,
    error: "Kernelspec julia-1.11 is not installed",
  },
  listing: {
    label: "Listing failed",
    note: "Kernels could not be listed. Conda choices and Automatic still work.",
    available: true,
    selection: snapshot(),
    kernelspecCatalog: {
      status: "failed",
      seq: 2,
      inventory: null,
      error: "Kernel directory could not be read",
    },
    running: automaticRunning,
    error: null,
  },
  partial: {
    label: "Partial listing",
    note: "A long name, a warning, and a truncated listing.",
    available: true,
    selection: snapshot({ revision: 7, selected_kernelspec: longName }),
    kernelspecCatalog: {
      status: "ready",
      seq: 2,
      inventory: {
        kernelspecs: [longName],
        warnings: ["One kernel directory could not be read."],
        truncated: true,
      },
    },
    running: automaticRunning,
    error: null,
  },
  deno: {
    label: "Deno notebook",
    note: "Conda environments do not apply to a Deno notebook. Automatic and installed kernels remain.",
    available: true,
    condaAvailable: false,
    selection: snapshot(),
    kernelspecCatalog: kernels,
    running: denoRunning,
    error: null,
  },
  old: {
    label: "Older daemon",
    note: "The daemon does not list installed kernels. Conda selection is unchanged.",
    available: true,
    selection: snapshot({ revision: 2, selected: rankings }),
    kernelspecCatalog: { status: "unsupported", seq: 1 },
    running: automaticRunning,
    error: null,
  },
  hosted: {
    label: "Hosted",
    note: "Local selection is unavailable on this connection.",
    available: false,
    selection: null,
    kernelspecCatalog: { status: "unsupported", seq: 0 },
    running: automaticRunning,
    error: null,
  },
};

export function LocalEnvironmentSelectorExample() {
  const [fixtureId, setFixtureId] = useState("staged");
  const [narrow, setNarrow] = useState(false);
  const [lastAction, setLastAction] = useState("None");
  const fixture = fixtures[fixtureId];
  const describe = (target: LocalEnvironmentTarget) =>
    target.kind === "kernelspec"
      ? `Select kernel ${target.name}`
      : target.kind === "conda"
        ? "Select Conda environment"
        : "Select Automatic";

  return (
    <div className="not-prose space-y-6" data-elements-slot="local-environment-selector">
      <div className="flex flex-wrap gap-2" aria-label="Environment fixture state">
        {Object.entries(fixtures).map(([id, entry]) => (
          <Button
            key={id}
            variant={fixtureId === id ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFixtureId(id)}
          >
            {entry.label}
          </Button>
        ))}
        <Button variant="outline" size="sm" onClick={() => setNarrow(!narrow)}>
          {narrow ? "Normal width" : "Narrow width"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{fixture.note}</p>
      <div
        className={
          narrow ? "w-60 border-t border-border py-4" : "max-w-80 border-t border-border py-4"
        }
        data-testid="local-environment-selector-fixture"
      >
        <LocalEnvironmentSelector
          key={fixtureId}
          available={fixture.available}
          condaAvailable={fixture.condaAvailable}
          selection={fixture.selection}
          kernelspecCatalog={fixture.kernelspecCatalog}
          running={fixture.running}
          error={fixture.error}
          inventory={condaInventory}
          loadingSelection={false}
          loadingInventory={false}
          mutating={false}
          blocked={false}
          onLoadInventory={() => undefined}
          onLoadKernelspecs={() => undefined}
          onRetrySelection={() => undefined}
          onSelect={(target) => setLastAction(describe(target))}
          onApply={(revision) => setLastAction(`Apply revision ${revision}`)}
        />
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Last action: {lastAction}
      </p>
    </div>
  );
}
