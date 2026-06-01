"use client";

import { Bot, CheckCircle2, Cloud, KeyRound, Package, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { CodeCellCurrentLine } from "@/components/cell/CodeCellCurrentLine";
import {
  NotebookEnvironmentSummary,
  NotebookIdentityBadge,
  NotebookIdentityGroup,
  NotebookDocumentHeader,
  notebookActorIdentityFromAccess,
  type NotebookActorIdentity,
} from "@/components/notebook-shell";
import { cn } from "@/lib/utils";
import {
  getElementsNotebookScenario,
  type ElementsNotebookScenario,
  type ElementsNotebookScenarioId,
} from "@/components/notebook-scenarios";

const identityScenarioIds: ElementsNotebookScenarioId[] = [
  "desktop-local-owner",
  "desktop-read-only",
  "desktop-remote-room",
  "cloud-public-viewer",
  "cloud-editor",
  "cloud-owner",
  "agent-on-behalf",
  "credential-attention",
  "multi-operator",
  "mixed-idp-room",
  "runtime-peer",
  "system-schema",
  "runtime-unavailable",
  "untrusted-dependencies",
];

const remainingNotebookSurfaces = [
  {
    surface: "Notebook activity feed",
    why: "The shell knows access and current execution actors, but we do not yet have a reusable timeline for runs, saves, trust, and sharing events.",
  },
  {
    surface: "Variable rail panel",
    why: "Elements scenarios carry variable facts, but the production rail currently exposes outline and packages only.",
  },
  {
    surface: "Sharing controls",
    why: "Cloud has ACL actor labels, but the shared shell only reserves the slot; the notebook-semantic invite/list surface is still host-local.",
  },
];

export function IdentityEnvironmentSurfacesExample() {
  const scenarios = identityScenarioIds.map((id) => getElementsNotebookScenario(id));
  const desktopOwner = getElementsNotebookScenario("desktop-local-owner");
  const cloudOwner = getElementsNotebookScenario("cloud-owner");
  const cloudEditor = getElementsNotebookScenario("cloud-editor");
  const agentScenario = getElementsNotebookScenario("agent-on-behalf");
  const runtimePeer = getElementsNotebookScenario("runtime-peer");
  const activeActors = [
    scenarioActor(cloudOwner),
    scenarioActor(cloudEditor),
    scenarioActor(agentScenario),
    scenarioActor(runtimePeer),
  ];

  return (
    <div className="not-prose space-y-6" data-elements-slot="identity-environment-surfaces">
      <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-fd-foreground">
        <div className="flex items-start gap-3">
          <CheckCircle2
            className="mt-0.5 size-4 flex-none text-emerald-700 dark:text-emerald-300"
            aria-hidden="true"
          />
          <div>
            <h2 className="text-sm font-semibold">Notebook-semantic composites</h2>
            <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
              These examples wrap shared primitives in notebook concepts: current actor, access
              source, agent delegation, runtime state, and package details. Raw Avatar, Badge,
              Select, and Button primitives stay implementation details.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        {scenarios.map((scenario) => (
          <IdentityScenarioCard key={scenario.id} scenario={scenario} />
        ))}
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <div className="flex items-center gap-2">
            <Cloud className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Header composition</h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
            `NotebookDocumentHeader` owns the shared slot policy. The identity and active actor
            group can be supplied by desktop, cloud, or Elements fixtures without changing the
            shell.
          </p>
        </div>
        <div className="bg-background p-4 text-foreground">
          <NotebookDocumentHeader
            capabilities={cloudOwner.capabilities}
            presence={<NotebookIdentityBadge actor={scenarioActor(cloudOwner)} />}
            utilityControls={<HeaderPill icon={<Cloud className="size-3.5" />} label="Cloud" />}
            runtimeControls={
              <HeaderPill icon={<Package className="size-3.5" />} label="Packages" />
            }
            codeControls={<HeaderPill icon={<UserRound className="size-3.5" />} label="Source" />}
            sharingControls={<HeaderPill icon={<KeyRound className="size-3.5" />} label="Share" />}
            identityControls={<NotebookIdentityGroup actors={activeActors} />}
          />
        </div>
      </section>

      <section className="grid items-start gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
          <div className="border-b border-fd-border p-4">
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-fd-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold">Execution attribution</h2>
            </div>
            <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
              Code cells already receive `submitted_by_actor_label`. The shared identity badge makes
              the agent/user relationship visible without teaching cells about cloud auth.
            </p>
          </div>
          <div className="space-y-3 bg-background p-4 text-foreground">
            <CodeCellCurrentLine
              languageLabel="Python"
              count={16}
              isExecuting
              isFocused
              activityContent={
                <NotebookIdentityBadge
                  actor={scenarioActor(agentScenario)}
                  size="sm"
                  showDetail={false}
                  className="max-w-28 border-transparent bg-transparent px-0 shadow-none"
                />
              }
            />
            <div className="rounded-md border border-border bg-card p-3">
              <NotebookIdentityBadge actor={scenarioActor(agentScenario)} />
            </div>
          </div>
        </div>

        <NotebookEnvironmentSummary
          capabilities={desktopOwner.capabilities}
          packages={desktopOwner.viewModel.packages}
          environment={desktopOwner.environment}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <NotebookEnvironmentSummary
          capabilities={agentScenario.capabilities}
          packages={agentScenario.viewModel.packages}
          environment={agentScenario.environment}
        />
        <NotebookEnvironmentSummary
          capabilities={getElementsNotebookScenario("runtime-unavailable").capabilities}
          packages={getElementsNotebookScenario("runtime-unavailable").viewModel.packages}
          environment={getElementsNotebookScenario("runtime-unavailable").environment}
        />
      </section>

      <section className="rounded-lg border border-dashed border-fd-border bg-fd-background p-4">
        <h2 className="text-sm font-semibold">Remaining notebook-specific surfaces</h2>
        <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
          The catalog should keep moving toward notebook semantics, not raw primitives. These are
          the next gaps after identity and environment summary.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {remainingNotebookSurfaces.map((item) => (
            <article
              key={item.surface}
              className="rounded-md border border-fd-border bg-fd-card p-3"
            >
              <h3 className="text-sm font-semibold">{item.surface}</h3>
              <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{item.why}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function IdentityScenarioCard({ scenario }: { scenario: ElementsNotebookScenario }) {
  const actor = scenarioActor(scenario);

  return (
    <article className="rounded-lg border border-fd-border bg-fd-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-fd-muted-foreground">
            {scenario.eyebrow}
          </div>
          <h2 className="mt-1 truncate text-sm font-semibold">{scenario.title}</h2>
        </div>
        <AccessPill scenario={scenario} />
      </div>
      <NotebookIdentityBadge actor={actor} className="max-w-full" />
      <dl className="mt-4 grid gap-2 text-xs">
        <Fact
          label="Access"
          value={`${scenario.capabilities.access.level} / ${scenario.capabilities.access.source}`}
        />
        <Fact label="Runtime" value={scenario.runtimeLabel} />
        <Fact
          label="Packages"
          value={scenario.viewModel.packages.summary ?? scenario.packageSummary}
        />
      </dl>
    </article>
  );
}

function HeaderPill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground shadow-sm"
    >
      {icon}
      {label}
    </button>
  );
}

function AccessPill({ scenario }: { scenario: ElementsNotebookScenario }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        scenario.capabilities.access.isPublic
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      )}
    >
      {scenario.capabilities.access.isPublic ? "public" : scenario.capabilities.access.level}
    </span>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-2">
      <dt className="text-fd-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

function scenarioActor(scenario: ElementsNotebookScenario): NotebookActorIdentity {
  return notebookActorIdentityFromAccess(scenario.capabilities.access, scenario.capabilities.auth);
}
