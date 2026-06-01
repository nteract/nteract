"use client";

import {
  BookOpen,
  CheckCircle2,
  Cloud,
  CloudOff,
  Code2,
  Globe2,
  LogIn,
  Pencil,
  Play,
  Radio,
  Share2,
  UsersRound,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import {
  NotebookDocumentHeader,
  NotebookDocumentRail,
  NotebookDocumentShell,
  NotebookEnvironmentSummary,
  NotebookPackageSummaryPanel,
  notebookActorIdentityFromAccess,
  type NotebookActorIdentity,
} from "@/components/notebook-shell";
import type { NotebookRailPanelId } from "@/components/notebook-rail";
import { cn } from "@/lib/utils";
import { getElementsNotebookScenario } from "@/components/notebook-scenarios";

type CloudConnectionState = "live" | "reconnecting" | "offline";
type CloudModeState = "view" | "edit";

const activePeople: NotebookActorIdentity[] = [
  {
    id: "kyle",
    label: "Kyle",
    detail: "editing from browser",
    kind: "human",
    status: "active",
  },
  {
    id: "morgan",
    label: "Morgan",
    detail: "viewing",
    kind: "human",
    status: "idle",
  },
];

const shellStates = [
  {
    title: "Owner editing",
    description: "Presence, live sync, mode, sharing, and account all fit on one quiet line.",
    scenarioId: "cloud-owner" as const,
    connection: "live" as const,
    mode: "edit" as const,
    people: activePeople,
  },
  {
    title: "Public viewer",
    description:
      "The same shell reads as published and view-only without pretending a runtime exists.",
    scenarioId: "cloud-public-viewer" as const,
    connection: "live" as const,
    mode: "view" as const,
    people: [activePeople[1]],
  },
  {
    title: "Reconnecting",
    description: "Transport state is a document concern, separate from Python or kernel state.",
    scenarioId: "cloud-editor" as const,
    connection: "reconnecting" as const,
    mode: "edit" as const,
    people: activePeople,
  },
  {
    title: "Offline viewer",
    description: "Auth and access stay legible while the notebook waits to reconnect.",
    scenarioId: "cloud-public-viewer" as const,
    connection: "offline" as const,
    mode: "view" as const,
    people: [],
  },
];

const cloudStateRows = [
  {
    surface: "Presence",
    owner: "Room session",
    language: "2 here now, Kyle editing",
    reason: "People are peers on the document, not kernel state.",
  },
  {
    surface: "Connection",
    owner: "Document transport",
    language: "Live, reconnecting, offline",
    reason: "Online/offline belongs to sync health and save confidence.",
  },
  {
    surface: "Mode",
    owner: "Access request",
    language: "View or Edit",
    reason: "Mode is the user's current affordance, not a permission dump.",
  },
  {
    surface: "Runtime",
    owner: "Notebook capability",
    language: "Python, runtime detached",
    reason: "Cloud previews can show language context without implying local execution.",
  },
  {
    surface: "Account",
    owner: "Host auth",
    language: "Kyle, sign in, expired session",
    reason: "Identity controls stay with the cloud host while actor badges remain shared.",
  },
];

export function CloudNotebookShellExample() {
  const scenario = getElementsNotebookScenario("cloud-owner");
  const [activePanel, setActivePanel] = useState<NotebookRailPanelId>("outline");
  const [railCollapsed, setRailCollapsed] = useState(true);
  const actor = notebookActorIdentityFromAccess(
    scenario.capabilities.access,
    scenario.capabilities.auth,
  );

  const rail = (
    <NotebookDocumentRail
      viewModel={scenario.viewModel}
      activePanelId={activePanel}
      collapsed={railCollapsed}
      packagesPanel={
        <NotebookPackageSummaryPanel
          packages={scenario.viewModel.packages}
          readOnly
          header={
            <NotebookEnvironmentSummary
              capabilities={scenario.capabilities}
              packages={scenario.viewModel.packages}
              environment={scenario.environment}
              showPackageDetails={false}
              className="shadow-none"
            />
          }
        />
      }
      onActivePanelChange={setActivePanel}
      onCollapsedChange={setRailCollapsed}
      className="bg-background"
    />
  );

  return (
    <div className="not-prose space-y-6" data-elements-slot="cloud-notebook-shell">
      <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-fd-foreground">
        <div className="flex items-start gap-3">
          <Cloud
            className="mt-0.5 size-4 flex-none text-emerald-700 dark:text-emerald-300"
            aria-hidden="true"
          />
          <div>
            <h2 className="text-sm font-semibold">Cloud shell direction</h2>
            <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
              The cloud layer should compose around the shared notebook shell. Presence, document
              connection, edit mode, sharing, and account controls are host state. Runtime remains a
              notebook capability so the chrome does not imply that online/offline is a kernel
              status.
            </p>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-fd-border bg-fd-card shadow-sm">
        <BrowserFrame />
        <NotebookDocumentShell
          rootElement="div"
          className="h-[720px] bg-background text-foreground"
          stageClassName="bg-background"
          toolbar={
            <CloudHeader
              actor={actor}
              connection="live"
              mode="edit"
              people={activePeople}
              scenario={scenario}
            />
          }
          toolbarClassName="border-b bg-background/95 px-3 py-2 backdrop-blur"
          toolbarLabel="Cloud notebook session"
          rail={rail}
          capabilities={scenario.capabilities}
        >
          <CloudNotebookDocument />
        </NotebookDocumentShell>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        {shellStates.map((state) => {
          const stateScenario = getElementsNotebookScenario(state.scenarioId);
          const stateActor = notebookActorIdentityFromAccess(
            stateScenario.capabilities.access,
            stateScenario.capabilities.auth,
          );
          return (
            <article
              key={state.title}
              className="overflow-hidden rounded-lg border border-fd-border bg-fd-card"
            >
              <div className="border-b border-fd-border p-4">
                <h2 className="text-sm font-semibold">{state.title}</h2>
                <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
                  {state.description}
                </p>
              </div>
              <div className="bg-background p-3 text-foreground">
                <CloudHeader
                  actor={stateActor}
                  connection={state.connection}
                  mode={state.mode}
                  people={state.people}
                  scenario={stateScenario}
                  compact
                />
              </div>
            </article>
          );
        })}
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">State vocabulary</h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
            The mockup keeps each cloud feature in its own source of truth, then gives the shell
            quiet phrases that can collapse at small widths.
          </p>
        </div>
        <div className="divide-y divide-fd-border">
          {cloudStateRows.map((row) => (
            <div
              key={row.surface}
              className="grid gap-3 p-4 text-sm md:grid-cols-[9rem_11rem_minmax(0,1fr)_minmax(0,1.4fr)]"
            >
              <div className="font-semibold">{row.surface}</div>
              <div className="text-fd-muted-foreground">{row.owner}</div>
              <div className="font-mono text-xs text-fd-foreground">{row.language}</div>
              <div className="text-xs leading-5 text-fd-muted-foreground">{row.reason}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function BrowserFrame() {
  return (
    <div className="flex h-11 items-center gap-2 border-b border-fd-border bg-muted/50 px-4 text-xs text-muted-foreground">
      <div className="flex gap-1.5">
        <span className="size-2.5 rounded-full bg-red-400" />
        <span className="size-2.5 rounded-full bg-amber-400" />
        <span className="size-2.5 rounded-full bg-emerald-400" />
      </div>
      <div className="ml-2 flex h-7 min-w-0 flex-1 items-center rounded-full bg-background px-3">
        <Globe2 className="mr-2 size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">preview.runt.run/n/topic-viz/topic-viz</span>
      </div>
    </div>
  );
}

function CloudHeader({
  actor,
  compact = false,
  connection,
  mode,
  people,
  scenario,
}: {
  actor: NotebookActorIdentity;
  compact?: boolean;
  connection: CloudConnectionState;
  mode: CloudModeState;
  people: readonly NotebookActorIdentity[];
  scenario: ReturnType<typeof getElementsNotebookScenario>;
}) {
  if (compact) {
    return (
      <CloudHeaderStrip
        actor={actor}
        connection={connection}
        mode={mode}
        people={people}
        scenario={scenario}
      />
    );
  }

  return (
    <NotebookDocumentHeader
      capabilities={scenario.capabilities}
      presence={<CloudPresence people={people} mode={mode} compact={compact} />}
      utilityControls={<CloudConnectionPill state={connection} compact={compact} />}
      runtimeControls={<CloudRuntimePill compact={compact} />}
      sharingControls={<CloudShareButton compact={compact} />}
      editControls={<CloudModeButton mode={mode} compact={compact} />}
      authControls={<CloudAccountButton actor={actor} compact={compact} />}
    />
  );
}

function CloudHeaderStrip({
  actor,
  connection,
  mode,
  people,
  scenario,
}: {
  actor: NotebookActorIdentity;
  connection: CloudConnectionState;
  mode: CloudModeState;
  people: readonly NotebookActorIdentity[];
  scenario: ReturnType<typeof getElementsNotebookScenario>;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
      data-slot="cloud-notebook-header-strip"
      role="toolbar"
      aria-label="Cloud notebook state"
    >
      <CloudPresence people={people} mode={mode} compact />
      <span className="h-4 w-px bg-border/70" aria-hidden="true" />
      <CloudConnectionPill state={connection} compact />
      <CloudRuntimePill compact />
      {scenario.capabilities.canManageSharing ? <CloudShareButton compact /> : null}
      {scenario.capabilities.canRequestEdit ? <CloudModeButton mode={mode} compact /> : null}
      {scenario.capabilities.auth.canSignIn ||
      scenario.capabilities.auth.canUseAuthenticatedIdentity ||
      scenario.capabilities.auth.needsAttention ? (
        <CloudAccountButton actor={actor} compact />
      ) : null}
    </div>
  );
}

function CloudPresence({
  compact,
  mode,
  people,
}: {
  compact: boolean;
  mode: CloudModeState;
  people: readonly NotebookActorIdentity[];
}) {
  const connectedCount = Math.max(1, people.length);
  const modeLabel = mode === "edit" ? "editing" : "viewing";
  const label = compact ? `${connectedCount} here` : `${connectedCount} here now`;

  return (
    <div
      className={cn(
        "inline-flex h-8 max-w-[min(18rem,54vw)] items-center gap-2 px-1 text-sm text-foreground",
        people.length === 0 && "text-muted-foreground",
      )}
      title={`${label}, ${modeLabel}`}
    >
      <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
        <UsersRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        {people.length > 0 ? (
          <span className="absolute bottom-0 right-0 size-1.5 rounded-full bg-emerald-500" />
        ) : null}
      </span>
      <span className="min-w-0 truncate">
        {label}
        <span className="text-muted-foreground">, {modeLabel}</span>
      </span>
    </div>
  );
}

function CloudConnectionPill({
  compact,
  state,
}: {
  compact: boolean;
  state: CloudConnectionState;
}) {
  const detail = connectionDetail(state);
  const Icon = detail.icon;
  return (
    <span
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm font-medium transition-colors hover:bg-muted/60",
        detail.className,
      )}
      title={detail.title}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{compact ? detail.shortLabel : detail.label}</span>
    </span>
  );
}

function CloudRuntimePill({ compact }: { compact: boolean }) {
  return (
    <span
      className="inline-flex h-8 max-w-[10rem] items-center gap-1.5 rounded-md px-1.5 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-500/10 dark:text-blue-300"
      title="Notebook language, runtime detached in cloud preview"
    >
      <Code2 className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{compact ? "Python" : "Python"}</span>
      {!compact ? <span className="text-blue-700/50 dark:text-blue-300/50">detached</span> : null}
    </span>
  );
}

function CloudShareButton({ compact }: { compact: boolean }) {
  return (
    <button
      type="button"
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/70"
    >
      <Share2 className="size-3.5" aria-hidden="true" />
      {compact ? null : <span>Share</span>}
    </button>
  );
}

function CloudModeButton({ compact, mode }: { compact: boolean; mode: CloudModeState }) {
  const Icon = mode === "edit" ? BookOpen : Pencil;
  const label = mode === "edit" ? "View" : "Edit";

  return (
    <button
      type="button"
      aria-pressed={mode === "edit"}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm font-medium transition-colors hover:bg-muted/70",
        mode === "edit" ? "text-emerald-700 dark:text-emerald-300" : "text-foreground",
      )}
      title={mode === "edit" ? "Return to read-only viewing" : "Request edit access"}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {compact ? null : <span>{label}</span>}
    </button>
  );
}

function CloudAccountButton({
  actor,
  compact,
}: {
  actor: NotebookActorIdentity;
  compact: boolean;
}) {
  if (actor.kind === "public") {
    return (
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/70"
      >
        <LogIn className="size-3.5" aria-hidden="true" />
        <span className={cn(compact && "sr-only")}>Sign in</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="inline-flex h-8 max-w-[min(14rem,34vw)] items-center gap-1.5 rounded-md px-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/70"
      title={actor.detail ?? actor.label}
    >
      <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
      <span className={cn("min-w-0 truncate", compact && "max-w-16")}>{actor.label}</span>
    </button>
  );
}

function CloudNotebookDocument() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <article className="mx-auto max-w-5xl px-8 py-12 text-[17px] leading-8 max-sm:px-5">
        <h1 className="text-4xl font-semibold tracking-normal">MathNet topic visualization</h1>
        <p className="mt-6 max-w-4xl">
          The <a className="font-medium text-blue-600">MathNet dataset</a> collects competition math
          problems from around the world, each annotated with a hierarchical topic path like{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.9em]">
            Geometry &gt; Plane Geometry &gt; Triangles
          </code>
          . This notebook asks what that hierarchy actually looks like.
        </p>
        <p className="mt-5 max-w-4xl">
          Two views land it. A <strong>sunburst</strong> for the radial sense of where the mass
          lives, and a <strong>treemap</strong> for proportional comparison at a glance.
        </p>

        <h2 className="mt-9 text-2xl font-semibold">Loading the slice</h2>
        <p className="mt-4 max-w-4xl">
          200 rows, shuffled with a fixed seed so the picture is reproducible. The{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.9em]">map</code> step pre-computes{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.9em]">problem_length</code> and{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.9em]">has_images</code>.
        </p>

        <div className="mt-12 grid grid-cols-[2rem_minmax(0,1fr)] gap-4">
          <button
            type="button"
            className="mt-2 flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Run cell"
          >
            <Play className="size-4" aria-hidden="true" />
          </button>
          <div className="min-w-0 font-mono text-lg leading-8">
            <div>
              <span className="text-red-500">from</span>{" "}
              <span className="text-blue-700">datasets</span>{" "}
              <span className="text-red-500">import</span>{" "}
              <span className="text-blue-700">load_dataset</span>
            </div>
            <div className="mt-7">
              <span className="text-blue-700">columns</span> = [
              <br />
              <span className="pl-8 text-slate-700">"id",</span>
              <br />
              <span className="pl-8 text-slate-700">"problem_markdown",</span>
              <br />
              <span className="pl-8 text-slate-700">"problem_length",</span>
              <br />]
            </div>
            <div className="mt-7 flex items-center gap-3 text-sm font-sans text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <Radio className="size-3.5 text-emerald-600" aria-hidden="true" />
                Python
              </span>
              <span>/</span>
              <span>run 8</span>
              <span className="h-px flex-1 bg-border" />
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}

function connectionDetail(state: CloudConnectionState): {
  icon: LucideIcon;
  label: string;
  shortLabel: string;
  title: string;
  className: string;
} {
  switch (state) {
    case "live":
      return {
        icon: Cloud,
        label: "Live",
        shortLabel: "Live",
        title: "Document sync is live",
        className: "text-emerald-700 dark:text-emerald-300",
      };
    case "reconnecting":
      return {
        icon: CloudOff,
        label: "Reconnecting",
        shortLabel: "Sync",
        title: "Trying to reconnect to the notebook room",
        className: "text-amber-700 dark:text-amber-300",
      };
    case "offline":
      return {
        icon: WifiOff,
        label: "Offline",
        shortLabel: "Off",
        title: "Document edits are not connected",
        className: "text-muted-foreground",
      };
  }
}
