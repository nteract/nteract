"use client";

import {
  CheckCircle2,
  Clock3,
  Cloud,
  CloudOff,
  Copy,
  Eye,
  FilePenLine,
  Globe2,
  KeyRound,
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
import {
  createNotebookInteractionModeProjection,
  NotebookCommandToolbar,
  NotebookDocumentRail,
  NotebookDocumentShell,
  NotebookEditModeButton,
  NotebookIdentityBadge,
  NotebookPackageSummaryPanel,
  NotebookPresenceStatus,
  notebookActorIdentityFromAccess,
  type NotebookActorIdentity,
  type NotebookInteractionMode,
  type NotebookInteractionModeProjection,
  type NotebookShellCapabilities,
} from "@/components/notebook";
import { EnvironmentSummary } from "@/components/environment";
import type { NotebookRailPanelId } from "@/components/notebook-rail";
import { cn } from "@/lib/utils";
import {
  getElementsNotebookScenario,
  type ElementsNotebookScenario,
} from "@/components/notebook-scenarios";

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
    language: "2 here now",
    reason: "People are peers on the document; mode belongs to the view/edit control.",
  },
  {
    surface: "Connection",
    owner: "Document transport",
    language: "Live, reconnecting, offline",
    reason: "Online/offline belongs to sync health and save confidence.",
  },
  {
    surface: "Mode",
    owner: "Frontend affordance",
    language: "Viewing or Editing",
    reason: "Users with edit access can locally step out of editing without requesting access.",
  },
  {
    surface: "Permissions",
    owner: "Cloud ACL",
    language: "Owner, can edit, can view, pending",
    reason: "Sharing is document access; it should read as a quiet ledger, not generic account UI.",
  },
  {
    surface: "Runtime",
    owner: "Notebook toolbar",
    language: "Python / uv",
    reason: "Language and package affordances stay on the notebook command toolbar.",
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
  const [mode, setMode] = useState<CloudModeState>("edit");
  const [activePanel, setActivePanel] = useState<NotebookRailPanelId>("outline");
  const [railCollapsed, setRailCollapsed] = useState(true);
  const actor = notebookActorIdentityFromAccess(
    scenario.capabilities.access,
    scenario.capabilities.auth,
  );
  const shellCapabilities = withInteractionProjection(
    scenario.capabilities,
    cloudInteractionProjection(scenario, mode),
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
            <EnvironmentSummary
              capabilities={shellCapabilities}
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
      <section className="overflow-hidden rounded-xl border border-fd-border bg-fd-card shadow-sm">
        <BrowserFrame />
        <NotebookDocumentShell
          rootElement="div"
          className="h-[720px] bg-background text-foreground"
          stageClassName="bg-background"
          toolbar={
            <CloudNotebookChrome
              actor={actor}
              connection="live"
              mode={mode}
              onModeChange={setMode}
              people={activePeople}
              scenario={scenario}
            />
          }
          toolbarClassName="border-b bg-background/95 backdrop-blur"
          toolbarLabel="Cloud notebook session"
          rail={rail}
          capabilities={shellCapabilities}
        >
          <CloudNotebookDocument />
        </NotebookDocumentShell>
      </section>

      <CloudPermissionsSurface />

      <CloudAccountSurface />

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
              <div className="bg-background text-foreground">
                <CloudStatePreview
                  actor={stateActor}
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
  actor,
  connection,
  mode,
  onModeChange,
  people,
  scenario,
}: {
  actor: NotebookActorIdentity;
  connection: CloudConnectionState;
  mode: CloudModeState;
  onModeChange: (mode: CloudModeState) => void;
  people: readonly NotebookActorIdentity[];
  scenario: ElementsNotebookScenario;
}) {
  return (
    <div className="flex min-w-0 flex-col" data-slot="cloud-notebook-chrome">
      <CloudAppToolbar
        actor={actor}
        connection={connection}
        mode={mode}
        onModeChange={onModeChange}
        people={people}
        scenario={scenario}
      />
      <CloudNotebookToolbar mode={mode} scenario={scenario} />
    </div>
  );
}

function CloudAppToolbar({
  actor,
  connection,
  mode,
  onModeChange,
  people,
  scenario,
}: {
  actor: NotebookActorIdentity;
  connection: CloudConnectionState;
  mode: CloudModeState;
  onModeChange?: (mode: CloudModeState) => void;
  people: readonly NotebookActorIdentity[];
  scenario: ElementsNotebookScenario;
}) {
  const interaction = cloudInteractionProjection(scenario, mode);
  const effectiveCapabilities = withInteractionProjection(scenario.capabilities, interaction);

  return (
    <div
      className="flex min-h-14 min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/70 px-4 py-2"
      data-slot="cloud-app-toolbar"
    >
      <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
        <CloudPresence people={people} compact={false} />
        <CloudConnectionPill state={connection} compact={false} />
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
        {scenario.capabilities.canManageSharing ? <CloudShareMenu compact={false} /> : null}
        <CloudModeToggle
          compact={false}
          interaction={interaction}
          mode={mode}
          onModeChange={onModeChange}
        />
        {scenario.capabilities.auth.canSignIn ||
        scenario.capabilities.auth.canUseAuthenticatedIdentity ||
        scenario.capabilities.auth.needsAttention ? (
          <CloudAccountButton actor={actor} capabilities={effectiveCapabilities} compact={false} />
        ) : null}
      </div>
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

  return (
    <div className="min-w-0 overflow-hidden" data-slot="cloud-notebook-toolbar">
      <NotebookCommandToolbar
        capabilities={capabilities}
        runtime="python"
        environmentManager="uv"
        environmentOutOfSync={scenario.packageState.syncState.status === "dirty"}
        runtimeStatus={null}
        addAfterCellId={firstRunnableCell?.id ?? cellIds[cellIds.length - 1] ?? null}
        onAddCell={noop}
        onStartRuntime={noop}
        onInterruptRuntime={noop}
        onRestartRuntime={noop}
        onRunAllCells={noop}
        onRestartAndRunAll={noop}
        onTogglePackages={noop}
        className="h-12 px-4"
      />
    </div>
  );
}

function CloudStatePreview({
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
      <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5">
        <CloudPresence people={people} compact />
        <span className="h-4 w-px bg-border/70" aria-hidden="true" />
        <CloudConnectionPill state={connection} compact />
        {scenario.capabilities.canManageSharing ? <CloudShareMenu compact /> : null}
        <CloudModeToggle compact={false} interaction={interaction} mode={mode} />
        {scenario.capabilities.auth.canSignIn ||
        scenario.capabilities.auth.canUseAuthenticatedIdentity ||
        scenario.capabilities.auth.needsAttention ? (
          <CloudAccountButton actor={actor} capabilities={effectiveCapabilities} compact />
        ) : null}
      </div>
      <div className="[&_[data-slot=notebook-command-toolbar]]:h-9 [&_[data-slot=notebook-command-toolbar]]:px-3">
        <CloudNotebookToolbar mode={mode} scenario={scenario} />
      </div>
    </div>
  );
}

function CloudPresence({
  compact,
  people,
}: {
  compact: boolean;
  people: readonly NotebookActorIdentity[];
}) {
  const summary = presenceSummary(people, compact);
  const hasPeers = people.length > 0;

  return (
    <NotebookPresenceStatus
      connected={hasPeers}
      label={summary.label}
      title={summary.title}
      variant="inline"
      className={cn(
        "px-1",
        compact ? "max-w-[min(18rem,54vw)]" : "max-w-[min(18rem,42vw)]",
        !hasPeers && "text-muted-foreground",
      )}
    />
  );
}

function presenceSummary(
  people: readonly NotebookActorIdentity[],
  compact: boolean,
): { label: string; title: string } {
  if (people.length === 0) {
    return {
      label: compact ? "No live peers" : "No one live here",
      title: "No live collaborators are connected",
    };
  }

  if (compact) {
    return {
      label: `${people.length} here`,
      title: people.map((person) => `${person.label}: ${person.detail ?? "connected"}`).join(", "),
    };
  }

  return {
    label: `${people.length} here now`,
    title: people.map((person) => `${person.label}: ${person.detail ?? "connected"}`).join(", "),
  };
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
    value: "4 people",
    detail: "owner, editor, public, invite",
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
          <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Current access
          </h4>
          <span className="text-xs text-muted-foreground">4 people, 1 invite</span>
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
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 py-2.5">
      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{row.label}</div>
        <div className="truncate text-xs text-muted-foreground">{row.detail}</div>
      </div>
      <div className="hidden text-sm text-muted-foreground sm:block">{row.access}</div>
      <div
        className={cn(
          "text-xs font-medium",
          row.tone === "success" && "text-emerald-700 dark:text-emerald-300",
          row.tone === "pending" && "text-amber-700 dark:text-amber-300",
          row.tone === "default" && "text-muted-foreground",
        )}
      >
        {row.state}
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
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          What each role sees
        </h3>
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
    <div className="rounded-lg border border-red-500/25 bg-red-500/[0.04] p-4 text-foreground">
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
  compact,
  interaction,
  mode,
  onModeChange,
}: {
  compact: boolean;
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
        {compact ? null : <span>View only</span>}
      </span>
    );
  }

  if (compact) {
    return (
      <NotebookEditModeButton
        mode={mode}
        state={interaction.state}
        onModeChange={(nextMode) => onModeChange?.(nextMode)}
        className="border-0 bg-transparent px-1.5 shadow-none"
      />
    );
  }

  return (
    <NotebookEditModeButton
      mode={mode}
      state={interaction.state}
      onModeChange={(nextMode) => onModeChange?.(nextMode)}
      variant="segmented"
      className="h-8 rounded-md bg-muted/35 p-0.5 text-sm"
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

function CloudAccountButton({
  actor,
  capabilities,
  compact,
}: {
  actor: NotebookActorIdentity;
  capabilities: NotebookShellCapabilities;
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
      className="inline-flex h-8 max-w-[min(14rem,34vw)] items-center rounded-md px-1.5 transition-colors hover:bg-muted/70"
      title={actor.detail ?? actor.label}
    >
      <NotebookIdentityBadge
        actor={actor}
        variant="inline"
        showDetail={false}
        className={cn("max-w-full", compact && "max-w-16")}
      />
      <span className="sr-only">{capabilities.access.level} account</span>
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
