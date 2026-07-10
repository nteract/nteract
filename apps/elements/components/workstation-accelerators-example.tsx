"use client";

import {
  NotebookDocumentRail,
  NotebookPackageSummaryPanel,
  NotebookWorkstationsPanel,
  projectNotebookWorkstationSelection,
  type NotebookRegisteredWorkstation,
  type NotebookShellCapabilities,
} from "@/components/notebook";
import { cn } from "@/lib/utils";
import { getElementsNotebookScenario } from "@/components/notebook-scenarios";

const noop = () => {};
const GIB = 1024 ** 3;
const baseScenario = getElementsNotebookScenario("cloud-workstation-ready");

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

interface AcceleratorFixture {
  description: string;
  id: string;
  narrow?: boolean;
  title: string;
  workstation: NotebookRegisteredWorkstation;
}

const acceleratorFixtures: readonly AcceleratorFixture[] = [
  {
    id: "usable-gpu",
    title: "Usable GPU",
    description: "Detected and usable by this workstation runtime, without a capacity claim.",
    workstation: workstation("ws-usable-gpu", "Training workstation", {
      accelerators: [
        {
          kind: "gpu",
          vendor: "NVIDIA",
          model: "A100",
          count: 1,
          memory_bytes_per_device: 80 * GIB,
          readiness: "ready",
        },
      ],
    }),
  },
  {
    id: "multiple-gpus",
    title: "Multiple GPUs",
    description: "Identical detected devices are grouped with an explicit per-device memory value.",
    workstation: workstation("ws-multiple-gpus", "Multi-GPU workstation", {
      accelerators: [
        {
          kind: "gpu",
          vendor: "NVIDIA",
          model: "A100",
          count: 2,
          memory_bytes_per_device: 80 * GIB,
          readiness: "ready",
        },
      ],
    }),
  },
  {
    id: "gpu-not-ready",
    title: "Detected, not ready",
    description: "Hardware remains visible while the runtime diagnostic gets an attention state.",
    workstation: workstation("ws-gpu-attention", "Driver attention", {
      accelerators: [
        {
          kind: "gpu",
          vendor: "AMD",
          model: "MI300X",
          count: 1,
          memory_bytes_per_device: 192 * GIB,
          readiness: "not_ready",
          diagnostic: "ROCm runtime is not available to the workstation service.",
        },
      ],
    }),
  },
  {
    id: "known-no-gpu",
    title: "Known no GPU",
    description:
      "Detection ran and returned an empty accelerator inventory; the rail adds no GPU row.",
    workstation: workstation("ws-known-none", "CPU workstation", { accelerators: [] }),
  },
  {
    id: "older-agent-unknown",
    title: "Older agent, unknown",
    description:
      "Missing accelerator data stays unknown and is omitted rather than becoming No GPU.",
    workstation: workstation("ws-older-agent", "Older workstation agent"),
  },
  {
    id: "offline-known-gpu",
    title: "Offline with known GPU",
    description:
      "Last-known hardware remains visible, but the rail does not call it currently available.",
    workstation: workstation("ws-offline-gpu", "Offline GPU workstation", {
      status: "offline",
      statusMessage: "No heartbeat from this workstation recently.",
      accelerators: [
        {
          kind: "gpu",
          vendor: "NVIDIA",
          model: "A100",
          count: 1,
          memory_bytes_per_device: 80 * GIB,
          readiness: "ready",
        },
      ],
    }),
  },
  {
    id: "narrow-rail",
    title: "Narrow rail",
    description: "Long resource and diagnostic copy wraps inside the minimum-width notebook rail.",
    narrow: true,
    workstation: workstation("ws-narrow-gpu", "Constrained GPU workstation", {
      accelerators: [
        {
          kind: "gpu",
          vendor: "NVIDIA",
          model: "NVIDIA A100-SXM4-80GB",
          count: 2,
          memory_bytes_per_device: 80 * GIB,
          readiness: "unknown",
          diagnostic: "GPU detected, but runtime usability has not been verified for this service.",
        },
        {
          kind: "neural-processing-unit",
          vendor: "Example",
          model: "NPU-1",
          count: 1,
          readiness: "unknown",
        },
      ],
    }),
  },
];

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

export function WorkstationAcceleratorsExample() {
  return (
    <div
      className="not-prose grid items-start gap-6 xl:grid-cols-2"
      data-elements-slot="workstation-accelerators"
    >
      {acceleratorFixtures.map((fixture) => (
        <AcceleratorFixtureCard key={fixture.id} fixture={fixture} />
      ))}
    </div>
  );
}

function AcceleratorFixtureCard({ fixture }: { fixture: AcceleratorFixture }) {
  const selection = projectNotebookWorkstationSelection({
    canRegisterWorkstation: true,
    canSelectWorkstation: true,
    canSetDefaultWorkstation: true,
    defaultWorkstationId: fixture.workstation.id,
    registeredWorkstations: [fixture.workstation],
  });

  return (
    <section className="space-y-3" data-accelerator-fixture={fixture.id}>
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
            <NotebookWorkstationsPanel capabilities={detachedCapabilities} selection={selection} />
          }
          onActivePanelChange={noop}
          onCollapsedChange={noop}
          className="h-full"
        />
      </div>
    </section>
  );
}
