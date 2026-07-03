"use client";

import { useEffect, useRef, useState } from "react";
import {
  projectNotebookWorkstationSelection,
  type NotebookRegisteredWorkstation,
  type NotebookWorkstationPairingView,
} from "@/components/notebook";
import {
  projectWorkstationsPage,
  WorkstationsManagementPage,
  type WorkstationsPageHostFacts,
} from "@/components/workstations";

/**
 * Deterministic fixture for the workstations management page: the full split
 * list + detail surface with pairing and unpair flows. Statuses, timestamps,
 * and the pairing code are fixed so the fixture reads the same in every
 * review pass; transport transitions run only on interaction.
 *
 * Kernel inventory, idle policy, GPU/OS/env-manager labels are design-target
 * facts the hosted registry does not expose yet — the fixture supplies them as
 * host facts to show the complete design.
 */

const FIXED_NOW = Date.parse("2026-07-01T17:00:00Z");
const MINUTE_MS = 60_000;
const GIB = 1024 ** 3;

interface FixtureWorkstation {
  registration: NotebookRegisteredWorkstation;
  facts: WorkstationsPageHostFacts;
}

const seedWorkstations: readonly FixtureWorkstation[] = [
  {
    registration: {
      id: "ws-aurora",
      displayName: "aurora",
      providerLabel: "Paired",
      status: "online",
      cpuCount: 12,
      memoryBytes: 36 * GIB,
      updatedAt: new Date(FIXED_NOW - MINUTE_MS).toISOString(),
    },
    facts: {
      kindLabel: "MacBook Pro",
      osLabel: "macOS 15.2 · arm64",
      gpuLabel: "M3 Max",
      envManagerLabel: "uv",
      idlePolicy: { enabled: true, minutes: 30, minuteOptions: [15, 30, 60, 120] },
      kernels: [
        {
          id: "k-forecast",
          notebookLabel: "sales-forecast.ipynb",
          languageLabel: "Python",
          status: "executing",
        },
        {
          id: "k-features",
          notebookLabel: "feature-store.ipynb",
          languageLabel: "Python",
          status: "ready",
        },
        {
          id: "k-etl",
          notebookLabel: "etl-checks.ts",
          languageLabel: "TypeScript",
          status: "ready",
        },
      ],
    },
  },
  {
    registration: {
      id: "ws-tundra",
      displayName: "tundra",
      providerLabel: "Paired",
      status: "online",
      cpuCount: 32,
      memoryBytes: 128 * GIB,
      updatedAt: new Date(FIXED_NOW - 2 * MINUTE_MS).toISOString(),
    },
    facts: {
      kindLabel: "Lab desktop",
      osLabel: "Ubuntu 22.04 · x86_64",
      gpuLabel: "RTX 4090",
      envManagerLabel: "conda",
      idlePolicy: { enabled: false, minutes: 60, minuteOptions: [15, 30, 60, 120] },
      kernels: [
        {
          id: "k-train",
          notebookLabel: "train-resnet.ipynb",
          languageLabel: "Python",
          status: "executing",
        },
        {
          id: "k-eval",
          notebookLabel: "eval-sweep.ipynb",
          languageLabel: "Python",
          status: "ready",
        },
      ],
    },
  },
  {
    registration: {
      id: "ws-hub-a41",
      displayName: "hub-a41",
      providerLabel: "JupyterHub",
      status: "online",
      cpuCount: 8,
      memoryBytes: 32 * GIB,
      updatedAt: new Date(FIXED_NOW - 4 * MINUTE_MS).toISOString(),
    },
    facts: {
      kindLabel: "JupyterHub node",
      osLabel: "Ubuntu 22.04 · x86_64",
      envManagerLabel: "pixi",
      idlePolicy: { enabled: true, minutes: 15, minuteOptions: [15, 30, 60, 120] },
      kernels: [
        {
          id: "k-stats",
          notebookLabel: "intro-stats.ipynb",
          languageLabel: "Python",
          status: "ready",
        },
      ],
    },
  },
  {
    registration: {
      id: "ws-glacier",
      displayName: "glacier",
      providerLabel: "Outerbounds",
      status: "connecting",
      cpuCount: 64,
      memoryBytes: 256 * GIB,
      updatedAt: new Date(FIXED_NOW - MINUTE_MS).toISOString(),
    },
    facts: {
      kindLabel: "Outerbounds task",
      osLabel: "Ubuntu 24.04 · x86_64",
      gpuLabel: "A100 80GB",
      envManagerLabel: "conda",
      idlePolicy: { enabled: true, minutes: 30, minuteOptions: [15, 30, 60, 120] },
      kernels: [
        {
          id: "k-finetune",
          notebookLabel: "llm-finetune.ipynb",
          languageLabel: "Python",
          status: "starting",
        },
      ],
    },
  },
  {
    registration: {
      id: "ws-basalt",
      displayName: "basalt",
      providerLabel: "Paired",
      status: "offline",
      cpuCount: 16,
      memoryBytes: 64 * GIB,
      updatedAt: new Date(FIXED_NOW - 2 * 60 * MINUTE_MS).toISOString(),
    },
    facts: {
      kindLabel: "Cloud VM",
      osLabel: "Ubuntu 24.04 · x86_64",
      gpuLabel: "A10",
      envManagerLabel: "uv",
      idlePolicy: { enabled: true, minutes: 30, minuteOptions: [15, 30, 60, 120] },
      kernels: [],
    },
  },
  {
    registration: {
      id: "ws-quartz",
      displayName: "quartz",
      providerLabel: "Paired",
      status: "offline",
      cpuCount: 8,
      memoryBytes: 16 * GIB,
      updatedAt: new Date(FIXED_NOW - 3 * 24 * 60 * MINUTE_MS).toISOString(),
    },
    facts: {
      kindLabel: "Old laptop",
      osLabel: "macOS 13.6 · arm64",
      envManagerLabel: "uv",
      idlePolicy: { enabled: false, minutes: 30, minuteOptions: [15, 30, 60, 120] },
      kernels: [],
    },
  },
];

const pairingCode = "QNTR-0385-NM";

function fixturePairingView(status: NotebookWorkstationPairingView["status"]) {
  return {
    code: pairingCode,
    connectCommand: `runt workstation connect https://nteract.example --code ${pairingCode}`,
    commands: [
      {
        id: "install",
        label: "Install nteract headless",
        command:
          "curl --proto '=https' --tlsv1.2 -sSf https://sh.nteract.io | bash -s -- --headless",
      },
      {
        id: "connect",
        label: "Pair this workstation",
        command: `runt workstation connect https://nteract.example --code ${pairingCode}`,
      },
    ],
    expiresAt: new Date(FIXED_NOW + 9 * MINUTE_MS).toISOString(),
    status,
    workstationName: status === "registered" ? "nimbus" : null,
    error: null,
  } satisfies NotebookWorkstationPairingView;
}

export function WorkstationManagementExample() {
  const [workstations, setWorkstations] = useState(seedWorkstations);
  const [selectedId, setSelectedId] = useState<string | null>("ws-aurora");
  const [pairing, setPairing] = useState<NotebookWorkstationPairingView | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const timersRef = useRef<number[]>([]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
    },
    [],
  );

  const later = (delayMs: number, run: () => void) => {
    timersRef.current.push(window.setTimeout(run, delayMs));
  };

  const showToast = (text: string) => {
    setToast(text);
    later(2_800, () => setToast(null));
  };

  const mutate = (id: string, fn: (workstation: FixtureWorkstation) => FixtureWorkstation) => {
    setWorkstations((previous) =>
      previous.map((workstation) =>
        workstation.registration.id === id ? fn(workstation) : workstation,
      ),
    );
  };

  const settleOnline = (id: string) => {
    mutate(id, (workstation) => ({
      registration: { ...workstation.registration, status: "online" },
      facts: {
        ...workstation.facts,
        kernels: workstation.facts.kernels?.map((kernel) => ({
          ...kernel,
          status: "ready" as const,
        })),
      },
    }));
  };

  const goConnecting = (id: string) => {
    mutate(id, (workstation) => ({
      ...workstation,
      registration: { ...workstation.registration, status: "connecting" },
    }));
    later(1_300, () => settleOnline(id));
  };

  const selection = projectNotebookWorkstationSelection({
    registeredWorkstations: workstations.map((workstation) => workstation.registration),
  });
  const view = projectWorkstationsPage(selection.registeredWorkstations, {
    hostFacts: new Map(
      workstations.map((workstation) => [workstation.registration.id, workstation.facts]),
    ),
    nowMs: FIXED_NOW,
  });

  return (
    <div className="not-prose relative my-6 overflow-x-auto rounded-2xl bg-[oklch(0.982_0_0)] p-6 dark:bg-[oklch(0.16_0_0)]">
      <div className="mx-auto min-w-[1040px] max-w-[1140px]">
        <WorkstationsManagementPage
          className="h-[712px]"
          view={view}
          selectedId={selectedId}
          onSelect={setSelectedId}
          pairing={pairing}
          onStartPairing={() => {
            setPairing(fixturePairingView("pending"));
            later(3_500, () =>
              setPairing((previous) =>
                previous && previous.status === "pending"
                  ? fixturePairingView("redeemed")
                  : previous,
              ),
            );
            later(5_000, () => {
              setPairing((previous) =>
                previous && previous.status === "redeemed"
                  ? fixturePairingView("registered")
                  : previous,
              );
              setWorkstations((previous) => [
                {
                  registration: {
                    id: "ws-nimbus",
                    displayName: "nimbus",
                    providerLabel: "Paired",
                    status: "connecting",
                    cpuCount: 16,
                    memoryBytes: 64 * GIB,
                    updatedAt: new Date(FIXED_NOW).toISOString(),
                  },
                  facts: {
                    kindLabel: "Cloud VM",
                    osLabel: "Ubuntu 24.04 · x86_64",
                    gpuLabel: "A10",
                    envManagerLabel: "uv",
                    idlePolicy: { enabled: true, minutes: 30, minuteOptions: [15, 30, 60, 120] },
                    kernels: [],
                  },
                },
                ...previous,
              ]);
              setSelectedId("ws-nimbus");
              later(1_300, () => settleOnline("ws-nimbus"));
            });
          }}
          onCancelPairing={() => setPairing(null)}
          onUnpair={(id) => {
            setWorkstations((previous) => {
              const next = previous.filter((workstation) => workstation.registration.id !== id);
              setSelectedId((current) =>
                current === id ? (next[0]?.registration.id ?? null) : current,
              );
              return next;
            });
          }}
          onReconnect={goConnecting}
          onRestart={goConnecting}
          onDisconnect={(id) => {
            mutate(id, (workstation) => ({
              registration: { ...workstation.registration, status: "offline" },
              facts: { ...workstation.facts, kernels: [] },
            }));
          }}
          onOpenKernel={(_workstationId, kernelId) => {
            const kernel = workstations
              .flatMap((workstation) => workstation.facts.kernels ?? [])
              .find((candidate) => candidate.id === kernelId);
            showToast(
              `Open ‘${kernel?.notebookLabel ?? "the notebook"}’ from the notebook to attach a runtime here.`,
            );
          }}
          onSetIdlePolicyEnabled={(id, enabled) => {
            mutate(id, (workstation) => ({
              ...workstation,
              facts: {
                ...workstation.facts,
                idlePolicy: workstation.facts.idlePolicy
                  ? { ...workstation.facts.idlePolicy, enabled }
                  : workstation.facts.idlePolicy,
              },
            }));
          }}
          onSetIdleMinutes={(id, minutes) => {
            mutate(id, (workstation) => ({
              ...workstation,
              facts: {
                ...workstation.facts,
                idlePolicy: workstation.facts.idlePolicy
                  ? { ...workstation.facts.idlePolicy, minutes }
                  : workstation.facts.idlePolicy,
              },
            }));
          }}
        />
      </div>
      {toast ? (
        <div className="pointer-events-none absolute bottom-10 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-foreground px-4 py-2.5 text-[12.5px] text-background shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
