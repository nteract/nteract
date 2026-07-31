"use client";

import {
  NotebookDocumentRail,
  NotebookPackageSummaryPanel,
  NotebookWorkstationsPanel,
  projectNotebookWorkstationSelection,
  type NotebookRegisteredWorkstation,
  type NotebookShellCapabilities,
  type NotebookWorkstationUsageSample,
} from "@/components/notebook";
import { cn } from "@/lib/utils";
import { getElementsNotebookScenario } from "@/components/notebook-scenarios";

const noop = () => {};
const GIB = 1024 ** 3;
const baseScenario = getElementsNotebookScenario("cloud-workstation-ready");

// Fixed epoch so every render of this page draws the same series. The rail
// labels sample times relative to the newest sample, so no clock is involved.
const SAMPLE_EPOCH_MS = Date.parse("2026-07-30T16:00:00.000Z");
const SAMPLE_INTERVAL_MS = 30_000;

const detachedCapabilities: NotebookShellCapabilities = {
  ...baseScenario.capabilities,
  canExecute: false,
  runtime: {
    ...baseScenario.capabilities.runtime,
    connected: false,
    executionAvailable: false,
    target: {
      id: "workstation:none",
      kind: "cloud_workstation",
      status: "offline",
      label: "No compute session",
      statusLabel: "Offline",
      detail: "Choose a registered workstation to start compute for this notebook.",
      providerLabel: "Cloud room",
      defaultEnvironmentLabel: "Not running",
    },
  },
};

interface UsageFixture {
  description: string;
  id: string;
  narrow?: boolean;
  samples: readonly NotebookWorkstationUsageSample[] | null;
  title: string;
  workstation: NotebookRegisteredWorkstation;
}

const usageFixtures: readonly UsageFixture[] = [
  {
    id: "kernel-activity",
    title: "Kernel activity (ships today)",
    description:
      "The only series a host can draw right now. Activity is observed from RuntimeStateDoc, so it charts whether the workstation was executing — a step trace, summarized as the share of the window spent busy. It stays neutral because a busy kernel is not a warning.",
    workstation: workstation("ws-activity", "Attached workstation"),
    samples: activitySamples([0, 0, 1, 1, 1, 1, 0, 0, 1, 1]),
  },
  {
    id: "steady-load",
    title: "Steady load",
    description:
      "CPU and memory both reported for every sample, so the rail draws two series under the facts.",
    workstation: workstation("ws-steady", "Analysis workstation"),
    samples: samples(
      [0.18, 0.24, 0.21, 0.36, 0.44, 0.39, 0.47, 0.42, 0.51, 0.46],
      [0.31, 0.33, 0.32, 0.38, 0.41, 0.4, 0.44, 0.43, 0.46, 0.45],
    ),
  },
  {
    id: "sustained-attention",
    title: "Sustained load",
    description:
      "A latest reading at or above 90% takes the warn token. A past spike does not; the tone follows the current value.",
    workstation: workstation("ws-hot", "Training workstation"),
    samples: samples(
      [0.42, 0.55, 0.68, 0.74, 0.81, 0.86, 0.9, 0.93, 0.95, 0.94],
      [0.5, 0.58, 0.63, 0.66, 0.71, 0.74, 0.78, 0.81, 0.83, 0.84],
    ),
  },
  {
    id: "cpu-only",
    title: "CPU only",
    description:
      "Memory usage is reported but total capacity is unknown, so only the CPU series renders. A percentage against unknown capacity would be meaningless.",
    workstation: workstation("ws-cpu-only", "Unknown-capacity workstation", {
      memoryBytes: null,
    }),
    samples: samples(
      [0.12, 0.3, 0.22, 0.41, 0.35, 0.29, 0.44, 0.38, 0.33, 0.4],
      [0.4, 0.42, 0.41, 0.45, 0.44, 0.43, 0.47, 0.46, 0.45, 0.46],
    ),
  },
  {
    id: "reporting-gap",
    title: "Reporting gap",
    description:
      "One sample is missing its memory reading, so the memory series is dropped rather than drawn through time the host never reported on.",
    workstation: workstation("ws-gap", "Intermittent workstation"),
    samples: samples(
      [0.2, 0.28, 0.35, 0.3, 0.42, 0.38, 0.45, 0.4, 0.48, 0.44],
      [0.33, 0.35, null, 0.38, 0.4, 0.42, 0.41, 0.44, 0.43, 0.45],
    ),
  },
  {
    id: "no-samples",
    title: "No reported usage",
    description:
      "An agent that reports no usage gets no chart frame at all. An empty chart would read as idle hardware, which is a claim the rail cannot make.",
    workstation: workstation("ws-quiet", "Quiet workstation"),
    samples: null,
  },
  {
    id: "narrow-rail",
    title: "Narrow rail",
    description:
      "Both series and their peak labels stay legible at the minimum notebook rail width.",
    narrow: true,
    workstation: workstation("ws-narrow", "Constrained workstation", {
      memoryBytes: 128 * GIB,
    }),
    samples: samples(
      [0.55, 0.62, 0.58, 0.71, 0.66, 0.74, 0.69, 0.78, 0.72, 0.8],
      [0.6, 0.63, 0.61, 0.68, 0.66, 0.7, 0.69, 0.73, 0.71, 0.75],
    ),
  },
];

/**
 * Kernel-activity samples on the cadence the viewer actually records at, which
 * is finer than the hardware-telemetry fixtures below.
 */
function activitySamples(
  activityFractions: readonly number[],
): readonly NotebookWorkstationUsageSample[] {
  return activityFractions.map((activityFraction, index) => ({
    at: new Date(SAMPLE_EPOCH_MS + index * 5_000).toISOString(),
    activityFraction,
  }));
}

/** Turn 0-1 fractions into evenly spaced samples off the fixed epoch. */
function samples(
  cpuFractions: readonly number[],
  memoryFractions: readonly (number | null)[],
): readonly NotebookWorkstationUsageSample[] {
  return cpuFractions.map((cpuFraction, index) => {
    const memoryFraction = memoryFractions[index] ?? null;
    return {
      at: new Date(SAMPLE_EPOCH_MS + index * SAMPLE_INTERVAL_MS).toISOString(),
      cpuFraction,
      // The projection charts memory against total capacity, so fixtures carry
      // a fraction of the 64 GiB baseline workstation.
      memoryBytes: memoryFraction === null ? null : memoryFraction * 64 * GIB,
    };
  });
}

function workstation(
  id: string,
  displayName: string,
  overrides: Partial<NotebookRegisteredWorkstation> = {},
): NotebookRegisteredWorkstation {
  return {
    id,
    displayName,
    provider: "runtime_peer",
    providerLabel: "Workstation",
    status: "online",
    statusMessage: null,
    defaultEnvironmentLabel: "Current Python",
    environmentPolicy: "current_python",
    workingDirectory: "/workspace/notebooks",
    cpuCount: 16,
    memoryBytes: 64 * GIB,
    ...overrides,
  };
}

export function WorkstationUsageExample() {
  return (
    <div
      className="not-prose grid items-start gap-6 xl:grid-cols-2"
      data-elements-slot="workstation-usage"
    >
      {usageFixtures.map((fixture) => (
        <UsageFixtureCard key={fixture.id} fixture={fixture} />
      ))}
    </div>
  );
}

function UsageFixtureCard({ fixture }: { fixture: UsageFixture }) {
  const selection = projectNotebookWorkstationSelection({
    canRegisterWorkstation: true,
    canSelectWorkstation: true,
    canSetDefaultWorkstation: true,
    defaultWorkstationId: fixture.workstation.id,
    registeredWorkstations: [fixture.workstation],
    selectedWorkstationId: fixture.workstation.id,
  });

  return (
    <section className="space-y-3" data-usage-fixture={fixture.id}>
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-foreground">{fixture.title}</h2>
        <p className="max-w-prose text-xs leading-5 text-muted-foreground">{fixture.description}</p>
      </div>
      <div
        className={cn(
          "h-[32rem] overflow-hidden rounded-lg border border-border bg-background",
          fixture.narrow ? "w-[21rem] max-w-full" : "w-[23rem] max-w-full",
        )}
        data-elements-viewport={fixture.narrow ? "narrow" : "wide"}
      >
        <NotebookDocumentRail
          viewModel={baseScenario.viewModel}
          activePanelId="workstations"
          collapsed={false}
          packagesPanel={
            <NotebookPackageSummaryPanel packages={baseScenario.viewModel.packages} readOnly />
          }
          workstationsPanel={
            <NotebookWorkstationsPanel
              capabilities={detachedCapabilities}
              selection={selection}
              usageSamples={
                fixture.samples ? { [fixture.workstation.id]: fixture.samples } : undefined
              }
            />
          }
          onActivePanelChange={noop}
          onCollapsedChange={noop}
          className="h-full"
        />
      </div>
    </section>
  );
}
