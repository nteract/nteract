"use client";

import {
  CheckCircle2,
  Clock3,
  Cloud,
  Copy,
  Eye,
  FilePenLine,
  Globe2,
  KeyRound,
  Loader2,
  LogIn,
  Mail,
  Play,
  Radio,
  Share2,
  ShieldCheck,
  UserRound,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup } from "@/components/ui/avatar";
import {
  createNotebookInteractionModeProjection,
  NotebookCommandToolbar,
  NotebookDocumentHeader,
  NotebookDocumentRail,
  NotebookDocumentShell,
  NotebookToolbarFrame,
  NotebookEditModeButton,
  NotebookIdentityBadge,
  NotebookPackageSummaryPanel,
  NotebookWorkstationsPanel,
  notebookActorIdentityFromAccess,
  projectNotebookWorkstationSelection,
  type NotebookCommandRuntimeState,
  type NotebookCommandToolbarStatus,
  type NotebookActorIdentity,
  type NotebookInteractionMode,
  type NotebookInteractionModeProjection,
  type NotebookRegisteredWorkstation,
  type NotebookShellCapabilities,
} from "@/components/notebook";
import { cn } from "@/lib/utils";
import {
  ElementsNotebookEnvironment,
  useElementsNotebookEnvironment,
} from "@/components/elements-notebook-environment";
import {
  getElementsNotebookScenario,
  type ElementsNotebookScenario,
} from "@/components/notebook-scenarios";
import { Eyebrow } from "@/components/surface-primitives";
import { CodeCellCurrentLine } from "@/components/cell/CodeCellCurrentLine";

type CloudConnectionState = "live" | "reconnecting" | "offline";
type CloudModeState = NotebookInteractionMode;

const noop = () => {};

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
    title: "Workstation ready",
    description: "The room has selected a workstation target and the toolbar can run cells.",
    scenarioId: "cloud-workstation-ready" as const,
    connection: "live" as const,
    mode: "edit" as const,
    people: activePeople,
  },
  {
    title: "Owner editing",
    description: "Presence and sync stay app-level while the notebook row owns language.",
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
    title: "Requesting edit access",
    description: "The edit segment reads as sent until the room grants write access.",
    scenarioId: "cloud-viewer" as const,
    connection: "live" as const,
    mode: "edit" as const,
    people: activePeople,
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
    language: "avatar stack",
    reason:
      "People are peers on the document; visible copy stays quiet and mode belongs to the view/edit control.",
  },
  {
    surface: "Connection",
    owner: "Document transport",
    language: "notice when blocked",
    reason: "Sync health should stay quiet until the room needs attention.",
  },
  {
    surface: "Mode",
    owner: "Frontend affordance",
    language: "Viewing, Request sent, Editing",
    reason:
      "Users can ask for edit access without pretending the notebook is editable before the grant lands.",
  },
  {
    surface: "Permissions",
    owner: "Cloud ACL",
    language: "Owner, can edit, can view, pending",
    reason: "Sharing is document access; it should read as a quiet ledger, not generic account UI.",
  },
  {
    surface: "Notebook actions",
    owner: "Notebook toolbar",
    language: "Code, Markdown, packages",
    reason:
      "Cell structure and package language stay notebook-local; execution controls appear only when a runtime can run cells.",
  },
  {
    surface: "Account",
    owner: "Host auth",
    language: "sign in, expired session",
    reason: "Identity diagnostics move out of the primary row unless the session needs action.",
  },
];

type WorkstationTargetState = "ready" | "available" | "attaching" | "disconnected";

interface WorkstationTarget {
  id: string;
  name: string;
  provider: "outerbounds" | "jupyterhub" | "local";
  detail: string;
  environment: string;
  cpuCount?: number;
  memoryLabel?: string;
  workingDirectory?: string;
  status: WorkstationTargetState;
  statusLabel: string;
  selected: boolean;
  actionLabel: string;
}

const workstationTargets = [
  {
    id: "outerbounds-forecast-gpu",
    name: "Forecast GPU",
    provider: "outerbounds",
    detail: "Outerbounds Workstation",
    environment: "Current Python",
    cpuCount: 16,
    memoryLabel: "64 GiB",
    workingDirectory: "~/work/mathnet",
    status: "ready",
    statusLabel: "Ready",
    selected: true,
    actionLabel: "Attached",
  },
  {
    id: "hub-lab-kyle",
    name: "JupyterLab server",
    provider: "jupyterhub",
    detail: "JupyterHub workstation",
    environment: "Python 3 kernelspec",
    status: "available",
    statusLabel: "Online",
    selected: false,
    actionLabel: "Attach",
  },
  {
    id: "desktop-ssh-lab",
    name: "SSH lab bridge",
    provider: "local",
    detail: "Desktop remote bridge",
    environment: "Daemon managed",
    status: "disconnected",
    statusLabel: "Offline",
    selected: false,
    actionLabel: "Reconnect",
  },
] satisfies readonly WorkstationTarget[];

const activeWorkstationTarget =
  workstationTargets.find((target) => target.selected) ?? workstationTargets[0]!;

const shellRegisteredWorkstations = [
  {
    id: "outerbounds-forecast-gpu",
    displayName: "Forecast GPU",
    provider: "runtime_peer",
    providerLabel: "Outerbounds",
    status: "online",
    defaultEnvironmentLabel: "Current Python",
    environmentPolicy: "current_python",
    workingDirectory: "~/work/mathnet",
    cpuCount: 16,
    memoryBytes: 64 * 1024 ** 3,
  },
  {
    id: "hub-lab-kyle",
    displayName: "JupyterLab server",
    provider: "runtime_peer",
    providerLabel: "JupyterHub",
    status: "online",
    defaultEnvironmentLabel: "Python 3 kernelspec",
    environmentPolicy: "kernelspec",
  },
] satisfies readonly NotebookRegisteredWorkstation[];

const shellWorkstationSelection = projectNotebookWorkstationSelection({
  activeAttachment: {
    workstation_id: "outerbounds-forecast-gpu",
    display_name: "Forecast GPU",
    provider: "outerbounds",
    default_environment_label: "Current Python",
    environment_policy: "current_python",
    status: "ready",
    cpu_count: 16,
    memory_bytes: 64 * 1024 ** 3,
    working_directory: "~/work/mathnet",
  },
  canRegisterWorkstation: true,
  canSelectWorkstation: true,
  canSetDefaultWorkstation: true,
  defaultWorkstationId: "outerbounds-forecast-gpu",
  registeredWorkstations: shellRegisteredWorkstations,
  selectedWorkstationId: "outerbounds-forecast-gpu",
});

const workstationFlowRows = [
  {
    label: "Register",
    owner: "Host peer",
    state: "heartbeat",
    detail: "Provider process dials home and reports workstation capabilities.",
  },
  {
    label: "Select",
    owner: "Room host",
    state: "target",
    detail: "The room records the active workstation separately from document access.",
  },
  {
    label: "Attach",
    owner: "Runtime peer",
    state: "scoped",
    detail: "The selected workstation opens a room WebSocket with runtime_peer authority.",
  },
  {
    label: "Execute",
    owner: "Coordinator",
    state: "accepted work",
    detail: "The room creates execution intent before the workstation runs code.",
  },
] satisfies Array<{
  label: string;
  owner: string;
  state: string;
  detail: string;
}>;

export function CloudNotebookShellExample() {
  return (
    <ElementsNotebookEnvironment
      scenarioId="cloud-workstation-ready"
      initialActivePanelId="workstations"
      initialRailCollapsed={false}
    >
      <CloudNotebookShellExampleContent />
    </ElementsNotebookEnvironment>
  );
}

function CloudNotebookShellExampleContent() {
  const { actions, rail: railState, scenario } = useElementsNotebookEnvironment();
  const [mode, setMode] = useState<CloudModeState>("edit");
  const shellCapabilities = withInteractionProjection(
    scenario.capabilities,
    cloudInteractionProjection(scenario, mode),
  );

  const rail = (
    <NotebookDocumentRail
      viewModel={scenario.viewModel}
      activePanelId={railState.activePanelId}
      collapsed={railState.collapsed}
      workstationsPanel={
        <NotebookWorkstationsPanel
          capabilities={shellCapabilities}
          selection={shellWorkstationSelection}
        />
      }
      packagesPanel={
        <NotebookPackageSummaryPanel packages={scenario.viewModel.packages} readOnly />
      }
      onActivePanelChange={actions.setActivePanel}
      onCollapsedChange={actions.setRailCollapsed}
      className="bg-background"
    />
  );

  return (
    <div className="not-prose space-y-6" data-elements-slot="cloud-notebook-shell">
      <section className="overflow-hidden rounded-xl border border-fd-border bg-fd-card shadow-sm">
        <BrowserFrame />
        <NotebookDocumentShell
          rootElement="div"
          className="h-[720px] bg-background text-foreground"
          stageClassName="bg-background"
          toolbar={
            <CloudNotebookChrome
              connection="live"
              mode={mode}
              onModeChange={setMode}
              people={activePeople}
              scenario={scenario}
            />
          }
          toolbarClassName="bg-background/95 backdrop-blur"
          toolbarLabel="Cloud notebook session"
          rail={rail}
          capabilities={shellCapabilities}
        >
          <CloudNotebookDocument />
        </NotebookDocumentShell>
      </section>

      <CloudEntrySurface />

      <CloudWorkstationSurface />

      <CloudAuthHandoffSurface />

      <CloudPermissionsSurface />

      <CloudAccountSurface />

      <section className="grid gap-3 lg:grid-cols-2">
        {shellStates.map((state) => {
          const stateScenario = getElementsNotebookScenario(state.scenarioId);
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
              <div className="bg-background text-foreground">
                <CloudStatePreview
                  connection={state.connection}
                  mode={state.mode}
                  people={state.people}
                  scenario={stateScenario}
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

function CloudNotebookChrome({
  connection,
  mode,
  onModeChange,
  people,
  scenario,
}: {
  connection: CloudConnectionState;
  mode: CloudModeState;
  onModeChange: (mode: CloudModeState) => void;
  people: readonly NotebookActorIdentity[];
  scenario: ElementsNotebookScenario;
}) {
  return (
    <NotebookToolbarFrame className="static top-auto z-auto border-b-0 bg-background/95 supports-backdrop-filter:bg-background/80">
      <CloudAppToolbar
        connection={connection}
        mode={mode}
        onModeChange={onModeChange}
        people={people}
        scenario={scenario}
      />
      <CloudNotebookToolbar mode={mode} scenario={scenario} />
    </NotebookToolbarFrame>
  );
}

function CloudAppToolbar({
  connection,
  mode,
  onModeChange,
  people,
  scenario,
}: {
  connection: CloudConnectionState;
  mode: CloudModeState;
  onModeChange?: (mode: CloudModeState) => void;
  people: readonly NotebookActorIdentity[];
  scenario: ElementsNotebookScenario;
}) {
  const interaction = cloudInteractionProjection(scenario, mode);
  const effectiveCapabilities = withInteractionProjection(scenario.capabilities, interaction);

  return (
    <NotebookDocumentHeader
      capabilities={effectiveCapabilities}
      className={cn(
        "min-h-14 border-b border-border/70 px-4 py-2",
        "[&_[data-slot=notebook-document-header-presence]]:flex-[1_1_min(24rem,44vw)] [&_[data-slot=notebook-document-header-presence]]:max-w-[min(38rem,48vw)]",
        "[&_[data-slot=notebook-document-header-controls]]:flex-none [&_[data-slot=notebook-document-header-controls]]:min-w-max",
        "max-[900px]:min-h-[4.75rem] max-[900px]:flex-wrap max-[900px]:content-center max-[900px]:justify-start max-[900px]:gap-x-2 max-[900px]:gap-y-1",
        "max-[900px]:[&_[data-slot=notebook-document-header-presence]]:flex-[1_1_100%] max-[900px]:[&_[data-slot=notebook-document-header-presence]]:max-w-none",
        "max-[900px]:[&_[data-slot=notebook-document-header-controls]]:flex-[1_1_100%] max-[900px]:[&_[data-slot=notebook-document-header-controls]]:min-w-0 max-[900px]:[&_[data-slot=notebook-document-header-controls]]:justify-start max-[900px]:[&_[data-slot=notebook-document-header-controls]]:gap-1",
      )}
      presence={<CloudDocumentTitle title="MathNet topic visualization" subtitle="by Kyle" />}
      utilityControls={
        <>
          <CloudPresence connection={connection} people={people} />
        </>
      }
      sharingControls={<CloudShareMenu compact={false} />}
      editControls={
        <CloudModeToggle interaction={interaction} mode={mode} onModeChange={onModeChange} />
      }
      identityControls={null}
    />
  );
}

function CloudDocumentTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="grid min-w-0 text-left" data-slot="cloud-document-title">
      <span className="truncate text-sm font-semibold text-foreground">{title}</span>
      {subtitle ? (
        <span className="hidden truncate text-[11px] leading-4 text-muted-foreground sm:block">
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}

function CloudNotebookToolbar({
  mode,
  scenario,
}: {
  mode: CloudModeState;
  scenario: ElementsNotebookScenario;
}) {
  const firstRunnableCell = scenario.cells.find((cell) => cell.cellType === "code");
  const cellIds = scenario.viewModel.cellIds;
  const interaction = cloudInteractionProjection(scenario, mode);
  const capabilities = withInteractionProjection(scenario.capabilities, interaction);

  if (!shouldShowCloudNotebookCommandToolbar(capabilities)) {
    return null;
  }

  return (
    <div className="min-w-0 overflow-hidden" data-slot="cloud-notebook-toolbar">
      <NotebookCommandToolbar
        capabilities={capabilities}
        runtime="python"
        environmentManager={cloudEnvironmentManager(scenario)}
        environmentOutOfSync={cloudEnvironmentOutOfSync(scenario)}
        runtimeStatus={cloudRuntimeStatus(scenario)}
        addAfterCellId={firstRunnableCell?.id ?? cellIds[cellIds.length - 1] ?? null}
        onAddCell={noop}
        onStartRuntime={noop}
        onInterruptRuntime={noop}
        onRestartRuntime={noop}
        onRunAllCells={noop}
        onRestartAndRunAll={noop}
        onTogglePackages={noop}
      />
    </div>
  );
}

function cloudEnvironmentManager(scenario: ElementsNotebookScenario) {
  return scenario.id === "cloud-workstation-ready" ? null : "uv";
}

function cloudEnvironmentOutOfSync(scenario: ElementsNotebookScenario): boolean {
  return (
    scenario.id !== "cloud-workstation-ready" && scenario.packageState.syncState.status === "dirty"
  );
}

function cloudRuntimeStatus(
  scenario: ElementsNotebookScenario,
): NotebookCommandToolbarStatus | null {
  if (!scenario.capabilities.runtime.connected) {
    return null;
  }

  const state: NotebookCommandRuntimeState = scenario.capabilities.canExecute ? "idle" : "unknown";
  const label =
    scenario.id === "cloud-workstation-ready" ? "Current Python" : scenario.runtimeLabel;

  return {
    state,
    label,
    ariaLabel: `Runtime: ${label}`,
    title: scenario.runtimeLabel,
  };
}

function shouldShowCloudNotebookCommandToolbar(capabilities: NotebookShellCapabilities): boolean {
  return capabilities.canEditStructure || capabilities.canExecute || capabilities.canManagePackages;
}

function CloudStatePreview({
  connection,
  mode,
  people,
  scenario,
}: {
  connection: CloudConnectionState;
  mode: CloudModeState;
  people: readonly NotebookActorIdentity[];
  scenario: ElementsNotebookScenario;
}) {
  const interaction = cloudInteractionProjection(scenario, mode);
  const effectiveCapabilities = withInteractionProjection(scenario.capabilities, interaction);

  return (
    <div
      className="divide-y divide-border/70"
      data-slot="cloud-state-preview"
      role="toolbar"
      aria-label="Cloud notebook state"
    >
      <NotebookDocumentHeader
        capabilities={effectiveCapabilities}
        className={cn(
          "min-h-11 px-3 py-1.5",
          "[&_[data-slot=notebook-document-header-presence]]:flex-[1_1_min(24rem,44vw)] [&_[data-slot=notebook-document-header-presence]]:max-w-[min(38rem,48vw)]",
          "[&_[data-slot=notebook-document-header-controls]]:flex-none [&_[data-slot=notebook-document-header-controls]]:min-w-max",
          "max-[900px]:min-h-[4.25rem] max-[900px]:flex-wrap max-[900px]:content-center max-[900px]:justify-start max-[900px]:gap-x-2 max-[900px]:gap-y-1",
          "max-[900px]:[&_[data-slot=notebook-document-header-presence]]:flex-[1_1_100%] max-[900px]:[&_[data-slot=notebook-document-header-presence]]:max-w-none",
          "max-[900px]:[&_[data-slot=notebook-document-header-controls]]:flex-[1_1_100%] max-[900px]:[&_[data-slot=notebook-document-header-controls]]:min-w-0 max-[900px]:[&_[data-slot=notebook-document-header-controls]]:justify-start max-[900px]:[&_[data-slot=notebook-document-header-controls]]:gap-1",
        )}
        presence={<CloudDocumentTitle title={scenario.title} subtitle="by Kyle" />}
        utilityControls={
          <>
            <CloudPresence connection={connection} people={people} />
          </>
        }
        sharingControls={<CloudShareMenu compact />}
        editControls={<CloudModeToggle interaction={interaction} mode={mode} />}
        identityControls={null}
      />
      <div className="[&_[data-slot=notebook-command-toolbar]]:h-9 [&_[data-slot=notebook-command-toolbar]]:px-3">
        <CloudNotebookToolbar mode={mode} scenario={scenario} />
      </div>
    </div>
  );
}

function CloudPresence({
  connection,
  people,
}: {
  connection: CloudConnectionState;
  people: readonly NotebookActorIdentity[];
}) {
  const connected = connection === "live" && people.length > 0;
  const state = connected ? "live" : connection === "reconnecting" ? "joining" : "waiting";
  const title = connected
    ? people.length === 1
      ? "1 participant"
      : `${people.length} participants`
    : connection === "reconnecting"
      ? "Joining room"
      : "Room unavailable";
  const label = connected
    ? people.length === 1
      ? "1 here now"
      : `${people.length} here now`
    : title;
  const visiblePeople = people.slice(0, 3);

  return (
    <span
      className={cn(
        "inline-flex h-8 min-w-7 items-center justify-center rounded-md px-0.5 transition-colors hover:bg-muted/70",
        !connected && "opacity-65",
      )}
      data-slot="cloud-presence-stack"
      data-state={state}
      title={title}
      aria-label={title}
    >
      <AvatarGroup className="items-center px-1" aria-hidden="true">
        {visiblePeople.length > 0 ? (
          visiblePeople.map((person) => (
            <CloudPresenceAvatar key={person.id} actor={person} connected={connected} />
          ))
        ) : (
          <Avatar
            size="sm"
            className="border border-border bg-background"
            data-status={connection === "offline" ? "offline" : "idle"}
            title={title}
          >
            <AvatarFallback className="bg-muted/70 text-[10px] font-semibold text-muted-foreground">
              ?
            </AvatarFallback>
            <AvatarBadge
              className={connection === "offline" ? "bg-slate-300" : "bg-slate-400"}
              data-status={connection === "offline" ? "offline" : "idle"}
            />
          </Avatar>
        )}
      </AvatarGroup>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function CloudPresenceAvatar({
  actor,
  connected,
}: {
  actor: NotebookActorIdentity;
  connected: boolean;
}) {
  const status = connected ? actor.status : "offline";
  return (
    <Avatar
      size="sm"
      className="border border-border bg-background"
      data-kind={actor.kind}
      data-status={status}
      title={actor.label}
    >
      <AvatarFallback
        className={cn(
          "bg-background text-[10px] font-semibold text-muted-foreground",
          actor.status === "active" && connected && "text-emerald-700 dark:text-emerald-300",
        )}
      >
        {cloudPresenceInitials(actor.label)}
      </AvatarFallback>
      <AvatarBadge
        className={cn(
          status === "active" && "bg-emerald-500",
          status === "idle" && "bg-slate-400",
          status === "offline" && "bg-slate-300",
        )}
        data-status={status}
      />
    </Avatar>
  );
}

function cloudPresenceInitials(label: string): string {
  const words = label
    .split(/[\s@._-]+/g)
    .map((word) => word.trim())
    .filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "?";
}

function CloudShareMenu({ compact }: { compact: boolean }) {
  return (
    <button
      type="button"
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      title="Share notebook"
    >
      <Share2 className="size-3.5" aria-hidden="true" />
      {compact ? <span className="sr-only">Share</span> : <span>Share</span>}
    </button>
  );
}

function CloudWorkstationSurface() {
  return (
    <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div className="border-b border-fd-border p-4">
        <div className="flex items-center gap-2">
          <Radio className="size-4 text-fd-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Workstations</h2>
        </div>
        <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
          JupyterHub and Outerbounds both appear as nteract workstations; provider adapters own
          connection details while the room owns target selection.
        </p>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
        <section
          className="grid content-start gap-4 border-l-2 border-emerald-500/70 bg-emerald-500/[0.07] py-3 pl-4 pr-3"
          aria-label="Active workstation target"
        >
          <div className="flex min-w-0 items-start gap-3">
            <CheckCircle2
              className="mt-0.5 size-5 shrink-0 text-emerald-700 dark:text-emerald-300"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold">{activeWorkstationTarget.name}</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {activeWorkstationTarget.detail} - {activeWorkstationTarget.environment}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <WorkstationMetric label="Provider" value="Outerbounds" />
            <WorkstationMetric label="Default env" value={activeWorkstationTarget.environment} />
            <WorkstationMetric
              label="CPUs"
              value={
                activeWorkstationTarget.cpuCount ? `${activeWorkstationTarget.cpuCount}` : "Unknown"
              }
            />
            <WorkstationMetric
              label="RAM"
              value={activeWorkstationTarget.memoryLabel ?? "Unknown"}
            />
            <WorkstationMetric
              label="Working dir"
              value={activeWorkstationTarget.workingDirectory ?? "Provider default"}
            />
          </div>
          <button
            type="button"
            className="inline-flex h-8 w-max items-center gap-1.5 rounded-md bg-foreground px-3 text-sm font-medium text-background"
          >
            <Play className="size-3.5" fill="currentColor" aria-hidden="true" />
            Run selected cell
          </button>
        </section>

        <section className="min-w-0" aria-label="Available workstation targets">
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background text-foreground">
            {workstationTargets.map((target) => (
              <WorkstationTargetRow key={target.id} target={target} />
            ))}
          </div>
        </section>
      </div>

      <section className="border-t border-fd-border px-4 py-3" aria-label="Workstation flow">
        <div className="grid gap-3 lg:grid-cols-4">
          {workstationFlowRows.map((row) => (
            <div
              key={row.label}
              className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2 border-l border-border/70 pl-3 first:border-l-0 first:pl-0 max-lg:border-l-0 max-lg:border-t max-lg:pt-3 max-lg:first:border-t-0 max-lg:first:pt-0"
            >
              <Cloud className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <h3 className="truncate text-sm font-semibold">{row.label}</h3>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {row.state}
                  </span>
                </div>
                <div className="mt-0.5 text-xs font-medium text-muted-foreground">{row.owner}</div>
                <p className="m-0 mt-1 text-xs leading-5 text-muted-foreground">{row.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

function WorkstationMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-emerald-500/20 bg-background/70 px-2 py-1.5">
      <Eyebrow className="truncate">{label}</Eyebrow>
      <div className="truncate text-xs font-semibold text-foreground">{value}</div>
    </div>
  );
}

function WorkstationTargetRow({ target }: { target: WorkstationTarget }) {
  const tone = workstationTargetTone(target.status);
  const StatusIcon = tone.icon;
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
      <StatusIcon className={cn("mt-0.5 size-4 shrink-0", tone.iconClassName)} aria-hidden="true" />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="truncate text-sm font-semibold">{target.name}</h3>
          <span className={cn("text-xs font-medium", tone.textClassName)}>
            {target.statusLabel}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{target.detail}</span>
          <span>{target.environment}</span>
        </div>
      </div>
      <button
        type="button"
        className={cn(
          "col-start-2 inline-flex h-8 w-max items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors sm:col-start-auto",
          target.selected
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        {target.selected ? (
          <CheckCircle2 className="size-3.5" aria-hidden="true" />
        ) : (
          <Radio className="size-3.5" aria-hidden="true" />
        )}
        {target.actionLabel}
      </button>
    </div>
  );
}

function workstationTargetTone(status: WorkstationTargetState): {
  className: string;
  icon: LucideIcon;
  iconClassName: string;
  textClassName: string;
} {
  switch (status) {
    case "ready":
      return {
        className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        icon: CheckCircle2,
        iconClassName: "text-emerald-700 dark:text-emerald-300",
        textClassName: "text-emerald-700 dark:text-emerald-300",
      };
    case "available":
      return {
        className: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
        icon: Radio,
        iconClassName: "text-blue-700 dark:text-blue-300",
        textClassName: "text-blue-700 dark:text-blue-300",
      };
    case "attaching":
      return {
        className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        icon: Clock3,
        iconClassName: "text-amber-700 dark:text-amber-300",
        textClassName: "text-amber-700 dark:text-amber-300",
      };
    case "disconnected":
      return {
        className: "bg-muted text-muted-foreground",
        icon: WifiOff,
        iconClassName: "text-muted-foreground",
        textClassName: "text-muted-foreground",
      };
  }
}

function CloudEntrySurface() {
  return (
    <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div className="border-b border-fd-border p-4">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-fd-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Cloud entry</h2>
        </div>
        <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
          The root shell should not become a role switcher. Public notebooks stay readable, and
          account action appears only when the user needs edit or sharing power.
        </p>
      </div>
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.85fr)]">
        <div className="grid content-start gap-3">
          <Eyebrow as="p">Notebook cloud</Eyebrow>
          <h3 className="m-0 max-w-[12ch] text-4xl font-bold leading-none text-foreground">
            nteract
          </h3>
          <p className="m-0 max-w-xl text-sm leading-6 text-muted-foreground">
            preview realtime notebooks
          </p>
        </div>
        <div className="grid content-start gap-3 border-l-2 border-foreground/25 bg-gradient-to-r from-muted/35 to-transparent py-3 pl-4">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
            <KeyRound className="mt-0.5 size-5 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <h3 className="m-0 truncate text-base font-semibold">Notebook cloud</h3>
              <p className="m-0 mt-1 text-xs leading-5 text-muted-foreground">
                Sign in to open private previews or request edit access. Public notebooks stay
                readable without an account.
              </p>
            </div>
          </div>
          <div>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-sm transition-colors hover:bg-muted"
            >
              <LogIn className="size-3.5" aria-hidden="true" />
              Sign in with Anaconda
            </button>
          </div>
        </div>
      </div>
      <div className="border-t border-fd-border px-4 py-3 text-xs leading-5 text-fd-muted-foreground">
        After a notebook opens, account and sharing actions belong to the room host. The notebook
        shell receives capabilities from that host instead of guessing from runtime state.
      </div>
    </section>
  );
}

const authHandoffStates = [
  {
    label: "Completing sign-in",
    detail: "The browser is finishing the account handoff.",
    icon: Loader2,
    tone: "live",
    spin: true,
  },
  {
    label: "Signed in",
    detail: "Access is renewed and the notebook can resume write actions.",
    icon: UserRound,
    tone: "live",
  },
  {
    label: "Nothing to finish",
    detail: "The user can return to cloud notebooks without changing document state.",
    icon: KeyRound,
    tone: "default",
  },
  {
    label: "Sign-in needs attention",
    detail: "The notebook stays readable while account recovery remains host-level.",
    icon: X,
    tone: "attention",
  },
] satisfies Array<{
  label: string;
  detail: string;
  icon: LucideIcon;
  tone: "default" | "live" | "attention";
  spin?: boolean;
}>;

function CloudAuthHandoffSurface() {
  return (
    <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div className="border-b border-fd-border p-4">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-fd-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Account handoff</h2>
        </div>
        <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
          The OIDC callback should feel like the cloud entry surface, not a separate auth app.
          Account recovery stays host-level while the notebook remains readable.
        </p>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.9fr)]">
        <div className="grid content-start gap-3">
          <Eyebrow as="p">Cloud sign-in</Eyebrow>
          <h3 className="m-0 max-w-[18ch] text-4xl font-bold leading-none text-foreground">
            Returning to the notebook.
          </h3>
          <p className="m-0 max-w-xl text-sm leading-6 text-muted-foreground">
            The browser finishes account work without introducing document chrome. Public reading
            remains calm while edit, share, and invite actions wait for identity.
          </p>
        </div>

        <div className="grid content-start gap-0 border-y border-border bg-muted/30 text-foreground">
          {authHandoffStates.map((state) => {
            const Icon = state.icon;
            return (
              <div
                key={state.label}
                className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 border-t border-border/70 px-4 py-3 first:border-t-0"
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-5 text-muted-foreground",
                    state.tone === "live" && "text-emerald-700 dark:text-emerald-300",
                    state.tone === "attention" && "text-red-600",
                    state.spin && "motion-safe:animate-spin",
                  )}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <h3 className="m-0 truncate text-base font-semibold">{state.label}</h3>
                  <p className="m-0 mt-1 text-xs leading-5 text-muted-foreground">{state.detail}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-fd-border px-4 py-3 text-xs leading-5 text-fd-muted-foreground">
        Callback routes can reuse the entry panel directly; open notebooks should keep account
        controls in cloud chrome and avoid adding auth badges to the document body.
      </div>
    </section>
  );
}

function CloudPermissionsSurface() {
  return (
    <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div className="border-b border-fd-border p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-fd-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Sharing and access</h2>
        </div>
        <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
          Owners should see link access, people, requests, and session health in one calm pass.
          Viewers and editors get quieter paths that match what they can actually do.
        </p>
      </div>
      <CloudAccessLedger />
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(20rem,0.7fr)]">
        <div className="min-w-0">
          <CloudSharePanel variant="owner" />
        </div>
        <div className="grid content-start gap-4">
          <CloudAccessRequestCard />
          <CloudAuthAttentionCard />
        </div>
      </div>
      <CloudAccessPathways />
    </section>
  );
}

const accessLedgerRows = [
  {
    icon: Globe2,
    label: "Link access",
    value: "Anyone can view",
    detail: "public, read-only",
    tone: "live",
  },
  {
    icon: UserRound,
    label: "People",
    value: "2 people",
    detail: "owner and editor",
    tone: "default",
  },
  {
    icon: Clock3,
    label: "Requests",
    value: "1 pending",
    detail: "waiting on owner",
    tone: "pending",
  },
  {
    icon: KeyRound,
    label: "Session",
    value: "Kyle can share",
    detail: "cloud account is live",
    tone: "live",
  },
] satisfies Array<{
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  tone: "default" | "live" | "pending";
}>;

function CloudAccessLedger() {
  return (
    <div className="grid border-b border-fd-border bg-background/60 text-foreground sm:grid-cols-2 xl:grid-cols-4">
      {accessLedgerRows.map((row) => {
        const Icon = row.icon;
        return (
          <div
            key={row.label}
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 border-t border-border/70 px-4 py-3 first:border-t-0 sm:[&:nth-child(-n+2)]:border-t-0 xl:border-t-0 xl:border-l xl:first:border-l-0"
          >
            <Icon
              className={cn(
                "mt-0.5 size-4 text-muted-foreground",
                row.tone === "live" && "text-emerald-700 dark:text-emerald-300",
                row.tone === "pending" && "text-amber-700 dark:text-amber-300",
              )}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="text-xs font-medium text-muted-foreground">{row.label}</div>
              <div className="truncate text-sm font-semibold">{row.value}</div>
              <div className="truncate text-xs text-muted-foreground">{row.detail}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

type CloudSharePanelVariant = "owner" | "public";

function CloudSharePanel({ variant }: { variant: CloudSharePanelVariant }) {
  const publicEnabled = variant === "owner";
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-sm">
      <div className="grid gap-1 border-b border-border/70 px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">Share notebook</h3>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Public link, collaborators, and pending invites for this notebook.
            </p>
          </div>
          <button
            type="button"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Copy className="size-3.5" aria-hidden="true" />
            Copy link
          </button>
        </div>
      </div>

      <div className="grid gap-3 px-4 py-3">
        <section
          className="grid gap-3 border-l-2 border-emerald-400/80 bg-emerald-500/[0.06] py-2 pl-3 pr-2"
          aria-label="Public link"
        >
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <Globe2
                className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold">Anyone with the link</div>
                <div className="text-xs leading-5 text-muted-foreground">
                  {publicEnabled
                    ? "Can view this notebook without signing in."
                    : "Only explicitly invited people can open this notebook."}
                </div>
              </div>
            </div>
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center rounded-md px-2 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-500/10 dark:text-emerald-300"
            >
              {publicEnabled ? "Disable" : "Enable"}
            </button>
          </div>
        </section>

        <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_auto]" aria-label="Invite">
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Invite by email
            <input
              className="h-9 min-w-0 rounded-md border border-border bg-background px-3 text-sm font-normal text-foreground"
              placeholder="name@example.com"
              type="email"
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Access
            <select className="h-9 rounded-md border border-border bg-background px-2 text-sm font-normal text-foreground">
              <option>Can view</option>
              <option>Can edit</option>
            </select>
          </label>
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center gap-1.5 self-end rounded-md bg-foreground px-3 text-sm font-medium text-background"
          >
            <Mail className="size-3.5" aria-hidden="true" />
            Invite
          </button>
        </form>
      </div>

      <section className="border-t border-border/70 px-4 py-3" aria-label="Current access">
        <div className="mb-2 flex items-center justify-between gap-2">
          <Eyebrow as="h4">Current access</Eyebrow>
          <span className="text-xs text-muted-foreground">2 people, public link, 1 invite</span>
        </div>
        <div className="divide-y divide-border/70">
          {shareRows.map((row) => (
            <CloudShareAccessRow key={row.label} row={row} />
          ))}
        </div>
      </section>
    </div>
  );
}

const shareRows = [
  {
    icon: UserRound,
    label: "Kyle",
    detail: "kyle@notebook.local",
    access: "Owner",
    state: "Signed in",
    tone: "default",
  },
  {
    icon: FilePenLine,
    label: "Morgan",
    detail: "morgan@example.com",
    access: "Can edit",
    state: "Live now",
    tone: "success",
  },
  {
    icon: Eye,
    label: "Public link",
    detail: "Anyone with the link",
    access: "Can view",
    state: "Enabled",
    tone: "success",
  },
  {
    icon: Clock3,
    label: "riley@example.com",
    detail: "Invited by Kyle",
    access: "Can edit",
    state: "Pending",
    tone: "pending",
  },
] satisfies Array<{
  icon: LucideIcon;
  label: string;
  detail: string;
  access: string;
  state: string;
  tone: "default" | "success" | "pending";
}>;

function CloudShareAccessRow({ row }: { row: (typeof shareRows)[number] }) {
  const Icon = row.icon;
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{row.label}</div>
        <div className="truncate text-xs text-muted-foreground">{row.detail}</div>
      </div>
      <div className="col-start-2 inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:col-start-auto sm:justify-end">
        <span className="text-xs font-medium text-muted-foreground sm:text-sm">{row.access}</span>
        <span
          className={cn(
            "text-xs font-medium",
            row.tone === "success" && "text-emerald-700 dark:text-emerald-300",
            row.tone === "pending" && "text-amber-700 dark:text-amber-300",
            row.tone === "default" && "text-muted-foreground",
          )}
        >
          {row.state}
        </span>
      </div>
    </div>
  );
}

const accessPathways = [
  {
    icon: ShieldCheck,
    label: "Owner",
    state: "Share notebook",
    detail: "Public link, invites, role changes, and removals stay owner-owned.",
    action: "Manage access",
    tone: "default",
  },
  {
    icon: FilePenLine,
    label: "Editor",
    state: "Editing",
    detail: "Editors can change notebook content without becoming sharing admins.",
    action: "Owner shares",
    tone: "default",
  },
  {
    icon: Eye,
    label: "Viewer",
    state: "Viewing live",
    detail: "The document stays connected while the viewer requests edit access.",
    action: "Request edit",
    tone: "request",
  },
  {
    icon: X,
    label: "Expired",
    state: "Session paused",
    detail: "Read access remains calm; write, share, and invite actions wait for renewal.",
    action: "Renew session",
    tone: "attention",
  },
] satisfies Array<{
  icon: LucideIcon;
  label: string;
  state: string;
  detail: string;
  action: string;
  tone: "default" | "request" | "attention";
}>;

function CloudAccessPathways() {
  return (
    <section className="border-t border-fd-border px-4 py-3" aria-label="Cloud access pathways">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Eyebrow as="h3">What each role sees</Eyebrow>
        <span className="text-xs text-muted-foreground">
          sharing appears only where the role can act
        </span>
      </div>
      <div className="divide-y divide-border/70">
        {accessPathways.map((pathway) => {
          const Icon = pathway.icon;
          return (
            <div
              key={pathway.label}
              className="grid min-w-0 gap-2 py-3 sm:grid-cols-[auto_7rem_minmax(0,1fr)_auto]"
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 text-muted-foreground",
                  pathway.tone === "request" && "text-emerald-700 dark:text-emerald-300",
                  pathway.tone === "attention" && "text-red-600",
                )}
                aria-hidden="true"
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold">{pathway.label}</div>
                <div
                  className={cn(
                    "text-xs font-medium text-muted-foreground",
                    pathway.tone === "request" && "text-emerald-700 dark:text-emerald-300",
                    pathway.tone === "attention" && "text-red-700 dark:text-red-300",
                  )}
                >
                  {pathway.state}
                </div>
              </div>
              <p className="m-0 text-xs leading-5 text-muted-foreground">{pathway.detail}</p>
              <div
                className={cn(
                  "text-sm font-medium text-muted-foreground",
                  pathway.tone === "request" && "text-emerald-700 dark:text-emerald-300",
                  pathway.tone === "attention" && "text-red-700 dark:text-red-300",
                )}
              >
                {pathway.action}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CloudAccessRequestCard() {
  return (
    <div className="rounded-lg border border-border bg-background p-4 text-foreground">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Need edit access?</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Viewers should stay in the live document and ask for edit access without changing
            connection mode or runtime state.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-sm font-medium text-background"
            >
              <FilePenLine className="size-3.5" aria-hidden="true" />
              Request edit access
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center rounded-md px-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Stay viewing
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CloudAuthAttentionCard() {
  return (
    <div className="border-l-2 border-red-500 bg-gradient-to-r from-red-500/[0.08] via-red-500/[0.04] to-transparent px-4 py-3 text-foreground">
      <div className="flex items-start gap-3">
        <X className="mt-0.5 size-4 text-red-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Session needs attention</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Auth problems should sit with account controls. The notebook can remain readable while
            cloud write actions wait for a renewed identity.
          </p>
          <button
            type="button"
            className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-500/10 dark:text-red-300"
          >
            <LogIn className="size-3.5" aria-hidden="true" />
            Sign in again
          </button>
        </div>
      </div>
    </div>
  );
}

function CloudAccountSurface() {
  const ownerScenario = getElementsNotebookScenario("cloud-owner");
  const publicScenario = getElementsNotebookScenario("cloud-public-viewer");
  const editorScenario = getElementsNotebookScenario("cloud-editor");
  const ownerActor = notebookActorIdentityFromAccess(
    ownerScenario.capabilities.access,
    ownerScenario.capabilities.auth,
  );
  const publicActor = notebookActorIdentityFromAccess(
    publicScenario.capabilities.access,
    publicScenario.capabilities.auth,
  );
  const editorActor = notebookActorIdentityFromAccess(editorScenario.capabilities.access, {
    ...editorScenario.capabilities.auth,
    needsAttention: true,
  });

  return (
    <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div className="border-b border-fd-border p-4">
        <div className="flex items-center gap-2">
          <UserRound className="size-4 text-fd-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Account and session</h2>
        </div>
        <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
          The account surface explains who the browser is acting as, what document access that
          identity has, and how to recover without repeating presence or runtime state.
        </p>
      </div>
      <div className="grid gap-4 p-4 xl:grid-cols-3">
        <CloudAccountPanel
          actor={ownerActor}
          title="Signed in"
          description="Write actions use this browser identity."
          rows={[
            ["Document access", "Owner"],
            ["Session", "Live"],
            ["Auth", "Anaconda"],
          ]}
          action="Sign out"
        />
        <CloudAccountPanel
          actor={publicActor}
          title="Public viewer"
          description="The document stays live while edit requests wait for sign-in."
          rows={[
            ["Document access", "Can view"],
            ["Session", "Anonymous"],
            ["Edit path", "Sign in to request"],
          ]}
          action="Sign in"
        />
        <CloudAccountPanel
          actor={editorActor}
          title="Session attention"
          description="Notebook reads remain available while cloud write actions pause."
          tone="attention"
          rows={[
            ["Document access", "Can edit"],
            ["Session", "Expired"],
            ["Recovery", "Sign in again"],
          ]}
          action="Renew session"
        />
      </div>
    </section>
  );
}

function CloudAccountPanel({
  action,
  actor,
  description,
  rows,
  title,
  tone = "default",
}: {
  action: string;
  actor: NotebookActorIdentity;
  description: string;
  rows: ReadonlyArray<readonly [string, string]>;
  title: string;
  tone?: "default" | "attention";
}) {
  return (
    <div
      className={cn(
        "grid gap-3 rounded-lg border border-border bg-background p-4 text-foreground",
        tone === "attention" && "border-red-500/25 bg-red-500/[0.04]",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
        {tone === "attention" ? (
          <X className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden="true" />
        ) : (
          <CheckCircle2
            className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300"
            aria-hidden="true"
          />
        )}
      </div>
      <NotebookIdentityBadge
        actor={actor}
        variant="inline"
        showDetail={false}
        showStatus={false}
        className="justify-start"
      />
      <dl className="grid gap-1.5 border-l-2 border-border/80 pl-3 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd
              className={cn(
                "min-w-0 truncate font-medium text-foreground",
                tone === "attention" && label === "Session" && "text-red-700 dark:text-red-300",
              )}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        className={cn(
          "inline-flex h-8 w-fit items-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors hover:bg-muted hover:text-foreground",
          tone === "attention"
            ? "text-red-700 hover:bg-red-500/10 dark:text-red-300"
            : "text-muted-foreground",
        )}
      >
        {tone === "attention" ? (
          <LogIn className="size-3.5" aria-hidden="true" />
        ) : (
          <KeyRound className="size-3.5" aria-hidden="true" />
        )}
        {action}
      </button>
    </div>
  );
}

function CloudModeToggle({
  interaction,
  mode,
  onModeChange,
}: {
  interaction: NotebookInteractionModeProjection;
  mode: CloudModeState;
  onModeChange?: (mode: CloudModeState) => void;
}) {
  if (!interaction.canRequestEdit && interaction.state === "viewing") {
    return (
      <span
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm font-medium text-muted-foreground"
        title="This notebook is view-only for the current identity"
      >
        <CheckCircle2 className="size-3.5" aria-hidden="true" />
        <span>View only</span>
      </span>
    );
  }

  return (
    <NotebookEditModeButton
      mode={mode}
      state={interaction.state}
      onModeChange={(nextMode) => onModeChange?.(nextMode)}
      variant="segmented"
      className="bg-muted/35"
    />
  );
}

function cloudInteractionProjection(
  scenario: ElementsNotebookScenario,
  mode: CloudModeState,
): NotebookInteractionModeProjection {
  return createNotebookInteractionModeProjection({
    selectedMode: mode,
    permission: {
      canEditMarkdown: scenario.capabilities.canEditMarkdown,
      canEditCells: scenario.capabilities.canEditCells,
      canEditStructure: scenario.capabilities.canEditStructure,
    },
    hostSupport: {
      canEditMarkdown: scenario.capabilities.canEditMarkdown,
      canEditCells: scenario.capabilities.canEditCells,
      canEditStructure: scenario.capabilities.canEditStructure,
      canRequestEdit: scenario.capabilities.canRequestEdit,
    },
  });
}

function withInteractionProjection(
  capabilities: NotebookShellCapabilities,
  interaction: NotebookInteractionModeProjection,
): NotebookShellCapabilities {
  return {
    ...capabilities,
    canEditMarkdown: interaction.canEditMarkdown,
    canEditCells: interaction.canEditCells,
    canEditStructure: interaction.canEditStructure,
    canRequestEdit: interaction.canRequestEdit,
    interaction,
  };
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
            <div className="group mt-7 font-sans">
              <CodeCellCurrentLine
                languageLabel="Python"
                count={8}
                elapsedMs={180}
                activityContent={<Radio className="size-3.5 text-emerald-600" aria-hidden />}
                isFocused
                className="mt-0"
              />
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}
