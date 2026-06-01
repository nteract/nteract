"use client";

import {
  BadgeCheck,
  CircleDot,
  Laptop,
  PanelTop,
  PlayCircle,
  TimerReset,
  UserRound,
} from "lucide-react";
import {
  NotebookCommandToolbar,
  NotebookEditModeButton,
  NotebookIdentityBadge,
  NotebookPresenceStatus,
  notebookActorIdentityFromProjection,
  type NotebookCommandRuntimeState,
  type NotebookCommandToolbarProps,
} from "@/components/notebook-shell";
import {
  getElementsNotebookScenario,
  type ElementsNotebookScenario,
  type ElementsNotebookScenarioId,
} from "@/components/notebook-scenarios";

const noop = () => {};

interface ToolbarSurface {
  title: string;
  source: string;
  role: string;
  scenario: ElementsNotebookScenario;
  props: NotebookCommandToolbarProps;
}

function scenario(id: ElementsNotebookScenarioId) {
  return getElementsNotebookScenario(id);
}

function toolbarProps(
  scenario: ElementsNotebookScenario,
  overrides: Partial<NotebookCommandToolbarProps> = {},
): NotebookCommandToolbarProps {
  const firstRunnableCell = scenario.cells.find((cell) => cell.cellType === "code");
  const cellIds = scenario.viewModel.cellIds;
  const interaction = scenario.capabilities.interaction;

  return {
    canEditStructure: scenario.capabilities.canEditStructure,
    canExecute: scenario.capabilities.canExecute,
    canViewPackages: scenario.capabilities.canViewPackages,
    runtime: "python",
    environmentManager: "uv",
    environmentPanelOpen: false,
    environmentOutOfSync: scenario.packageState.syncState.status === "dirty",
    runtimeStatus: runtimeStatus("idle", scenario.runtimeLabel),
    addAfterCellId: firstRunnableCell?.id ?? cellIds[cellIds.length - 1] ?? null,
    onAddCell: noop,
    onStartRuntime: noop,
    onInterruptRuntime: noop,
    onRestartRuntime: noop,
    onRunAllCells: noop,
    onRestartAndRunAll: noop,
    onTogglePackages: noop,
    leadingControls: (
      <NotebookPresenceStatus
        connected={scenario.capabilities.runtime.connected || scenario.capabilities.canRead}
        label={presenceLabel(scenario)}
        modeLabel={interaction?.state === "editing" ? "editing" : "view only"}
        title={`${scenario.title}: actor presence and interaction state`}
        className="h-7 text-xs"
      />
    ),
    trailingControls: <ToolbarIdentityControls scenario={scenario} />,
    ...overrides,
  };
}

function presenceLabel(scenario: ElementsNotebookScenario): string {
  const actorCount =
    scenario.capabilities.runtime.actor && scenario.capabilities.access.actor?.actorLabel ? 2 : 1;
  return actorCount === 1 ? "1 actor here" : `${actorCount} actors here`;
}

function runtimeStatus(
  state: NotebookCommandRuntimeState,
  label: string,
  error?: string,
): NotebookCommandToolbarProps["runtimeStatus"] {
  return {
    state,
    label: (
      <span className={state === "error" ? "text-red-600 dark:text-red-400" : ""}>{label}</span>
    ),
    ariaLabel: `Runtime: ${label}`,
    title: label,
    error: error ? (
      <span className="text-red-600 underline decoration-dotted underline-offset-2 dark:text-red-400">
        {error}
      </span>
    ) : null,
  };
}

function createStatusSurfaces(): ToolbarSurface[] {
  const desktopOwner = scenario("desktop-local-owner");
  const desktopReadOnly = scenario("desktop-read-only");
  const desktopRemote = scenario("desktop-remote-room");
  const cloudViewer = scenario("cloud-public-viewer");
  const cloudEditor = scenario("cloud-editor");
  const cloudOwner = scenario("cloud-owner");
  const agent = scenario("agent-on-behalf");
  const runtimePeer = scenario("runtime-peer");
  const runtimeUnavailable = scenario("runtime-unavailable");

  return [
    {
      title: "Desktop owner",
      source: "src/components/notebook-shell/NotebookCommandToolbar.tsx",
      scenario: desktopOwner,
      role: "Local desktop host can edit structure, execute, and inspect package state through the same command toolbar contract.",
      props: toolbarProps(desktopOwner),
    },
    {
      title: "Desktop read-only file",
      source: "src/components/notebook-shell/NotebookCommandToolbar.tsx",
      scenario: desktopReadOnly,
      role: "Filesystem or host permissions disable mutation controls while package details remain visible.",
      props: toolbarProps(desktopReadOnly, {
        runtimeStatus: runtimeStatus("shutdown", desktopReadOnly.runtimeLabel),
      }),
    },
    {
      title: "Desktop remote room",
      source: "src/components/notebook-shell/NotebookCommandToolbar.tsx",
      scenario: desktopRemote,
      role: "Desktop can be a remote notebook host: local app and daemon identity project into the same access model as cloud.",
      props: toolbarProps(desktopRemote, {
        runtimeStatus: runtimeStatus("unknown", desktopRemote.runtimeLabel),
      }),
    },
    {
      title: "Cloud public viewer",
      source: "src/components/notebook-shell/NotebookCommandToolbar.tsx",
      scenario: cloudViewer,
      role: "Anonymous read access keeps the notebook shell readable and package-aware without edit, execution, or sharing controls.",
      props: toolbarProps(cloudViewer, {
        runtime: null,
        environmentManager: null,
        runtimeStatus: runtimeStatus("unknown", cloudViewer.runtimeLabel),
      }),
    },
    {
      title: "Cloud editor",
      source: "src/components/notebook-shell/NotebookCommandToolbar.tsx",
      scenario: cloudEditor,
      role: "Cloud edit permission and selected edit mode are separate from host support; active controls are their intersection.",
      props: toolbarProps(cloudEditor, {
        runtimeStatus: runtimeStatus("unknown", cloudEditor.runtimeLabel),
      }),
    },
    {
      title: "Cloud owner",
      source: "src/components/notebook-shell/NotebookCommandToolbar.tsx",
      scenario: cloudOwner,
      role: "Owner access can expose sharing identity chrome without inventing a second notebook toolbar.",
      props: toolbarProps(cloudOwner, {
        runtimeStatus: runtimeStatus("unknown", cloudOwner.runtimeLabel),
      }),
    },
    {
      title: "Codex or Claude operator",
      source: "src/components/notebook-shell/NotebookCommandToolbar.tsx",
      scenario: agent,
      role: "Desktop and cloud both have non-human operators. The toolbar uses actor-neutral presence and projected identity labels.",
      props: toolbarProps(agent, {
        runtimeStatus: runtimeStatus("unknown", agent.runtimeLabel),
      }),
    },
    {
      title: "Runtime peer",
      source: "src/components/notebook-shell/NotebookCommandToolbar.tsx",
      scenario: runtimePeer,
      role: "Runtime authorship is present without notebook edit access, so execution authors do not become structure editors.",
      props: toolbarProps(runtimePeer, {
        runtimeStatus: runtimeStatus("busy", runtimePeer.runtimeLabel),
      }),
    },
    {
      title: "Preparing environment",
      source: "src/components/notebook-shell/NotebookCommandToolbar.tsx",
      scenario: cloudEditor,
      role: "Hosted and desktop hosts can show environment progress while keeping the work owned by their runtime adapter.",
      props: toolbarProps(cloudEditor, {
        runtimeStatus: runtimeStatus("starting", "Installing 17/24 scikit-learn"),
        environmentManager: "conda",
        environmentOutOfSync: true,
      }),
    },
    {
      title: "Runtime unavailable",
      source: "src/components/notebook-shell/NotebookCommandToolbar.tsx",
      scenario: runtimeUnavailable,
      role: "Runtime and trust remediation can surface through shared status while host-specific fixes stay outside the command toolbar.",
      props: toolbarProps(runtimeUnavailable, {
        runtimeStatus: runtimeStatus(
          "error",
          "Deno runtime unavailable",
          "deno executable not found",
        ),
        runtime: "deno",
        environmentManager: null,
      }),
    },
    {
      title: "Update ready",
      source: "src/components/notebook-shell/NotebookCommandToolbar.tsx",
      scenario: desktopOwner,
      role: "Desktop update actions remain a host slot on the shared command toolbar.",
      props: toolbarProps(desktopOwner, {
        updateAction: {
          label: "Update 2.5.3",
          title: "Prepare to update to v2.5.3",
          onClick: noop,
        },
      }),
    },
  ];
}

const contractItems = [
  {
    icon: BadgeCheck,
    title: "Shared source",
    body: "Every preview renders NotebookCommandToolbar from the host-neutral notebook shell.",
  },
  {
    icon: PlayCircle,
    title: "Adapter-owned actions",
    body: "Kernel, package, update, and cell insertion callbacks are inert fixtures here and host-owned in production.",
  },
  {
    icon: TimerReset,
    title: "Actor-neutral chrome",
    body: "Presence and mode copy works for humans, agents, runtime peers, and system operators.",
  },
];

const toolbarBoundaryRows = [
  {
    boundary: "Shared command toolbar",
    catalogPath: "NotebookCommandToolbar + ElementsNotebookScenario",
    productionBoundary: "Desktop NotebookToolbar wrapper and cloud host adapter",
    detail:
      "The catalog renders the shared command toolbar directly. Desktop and cloud wrappers may add host-specific status projection, but not duplicate command chrome.",
  },
  {
    boundary: "Interaction mode",
    catalogPath: "scenario.capabilities.interaction",
    productionBoundary: "ACL/local permission + selected host mode",
    detail:
      "View/edit state is a projection of permission, selected mode, and host support. The toolbar reads that projection instead of inferring editability from auth alone.",
  },
  {
    boundary: "Actor identity",
    catalogPath: "NotebookActorProjection -> NotebookActorIdentity",
    productionBoundary: "Host/backend structured actor projection",
    detail:
      "Raw durable actor labels remain attribution data. User-facing toolbar labels come from structured principal/operator projections when available.",
  },
  {
    boundary: "Runtime status projection",
    catalogPath: "static runtimeStatus fixtures",
    productionBoundary: "RuntimeStateDoc + kernel lifecycle",
    detail:
      "The command toolbar accepts a small runtime status shape. Hosts own the richer lifecycle, environment progress, launch errors, and remediation details.",
  },
  {
    boundary: "Package panel",
    catalogPath: "scenario.packageState + inert toggle",
    productionBoundary: "Package rail and project writes",
    detail:
      "Read-only scenarios still expose package details. Package management remains gated separately from package viewing.",
  },
];

export function NotebookToolbarSurfacesExample() {
  const statusSurfaces = createStatusSurfaces();

  return (
    <div className="not-prose space-y-6" data-elements-slot="notebook-toolbar-surfaces">
      <section className="grid gap-3 md:grid-cols-3">
        {contractItems.map((item) => (
          <div key={item.title} className="rounded-lg border border-fd-border bg-fd-card p-4">
            <item.icon className="mb-3 size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">{item.title}</h2>
            <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{item.body}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-4">
        {statusSurfaces.map((surface) => (
          <article
            key={surface.title}
            className="overflow-hidden rounded-lg border border-fd-border bg-fd-card"
          >
            <div className="flex flex-col gap-3 border-b border-fd-border p-4 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2">
                  <PanelTop
                    className="size-4 shrink-0 text-fd-muted-foreground"
                    aria-hidden="true"
                  />
                  <h2 className="text-sm font-semibold">{surface.title}</h2>
                </div>
                <p className="max-w-3xl text-xs leading-5 text-fd-muted-foreground">
                  {surface.role}
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-fd-muted-foreground">
                  <ScenarioPill label={surface.scenario.title} />
                  <ScenarioPill
                    label={`${surface.scenario.capabilities.access.source}:${surface.scenario.capabilities.access.level}`}
                  />
                  <ScenarioPill
                    label={
                      surface.scenario.capabilities.interaction?.state ??
                      (surface.scenario.capabilities.canEditMarkdown ? "editing" : "viewing")
                    }
                  />
                  <ScenarioPill
                    label={
                      surface.scenario.capabilities.runtime.actor
                        ? "runtime actor"
                        : "no runtime actor"
                    }
                  />
                </div>
              </div>
              <div className="break-words font-mono text-[11px] leading-5 text-fd-muted-foreground [overflow-wrap:anywhere] md:max-w-72 md:text-right">
                {surface.source}
              </div>
            </div>
            <div className="overflow-hidden bg-fd-background">
              <div className="min-w-[860px]">
                <NotebookCommandToolbar {...surface.props} />
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className="rounded-lg border border-dashed border-fd-border bg-fd-background p-4">
        <div className="mb-3 flex items-center gap-2">
          <CircleDot className="size-4 text-fd-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Live work stays with the host</h2>
        </div>
        <p className="text-xs leading-5 text-fd-muted-foreground">
          NotebookCommandToolbar is shared notebook chrome. This page owns only fixture props and
          inert callbacks; desktop and cloud remain responsible for transport, CRDT writes,
          execution, package mutation, credentials, and deployment-specific behavior.
        </p>
        <div className="mt-4 grid gap-2">
          {toolbarBoundaryRows.map((row) => (
            <div
              key={row.boundary}
              className="rounded-md border border-fd-border bg-fd-card p-3 text-xs"
            >
              <div className="grid gap-3 md:grid-cols-[150px_minmax(0,1fr)]">
                <div className="font-semibold">{row.boundary}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                      Preview uses
                    </div>
                    <div className="mt-1 break-words font-mono text-[11px] leading-4 text-emerald-700 dark:text-emerald-300">
                      {row.catalogPath}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                      Host owns
                    </div>
                    <div className="mt-1 break-words font-mono text-[11px] leading-4 text-amber-700 dark:text-amber-300">
                      {row.productionBoundary}
                    </div>
                  </div>
                </div>
              </div>
              <p className="mt-3 leading-5 text-fd-muted-foreground">{row.detail}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ToolbarIdentityControls({ scenario }: { scenario: ElementsNotebookScenario }) {
  const accessActor = scenario.capabilities.access.actor;
  const runtimeActor = scenario.capabilities.runtime.actor;
  const actors = [
    accessActor ? notebookActorIdentityFromProjection(accessActor) : null,
    runtimeActor ? notebookActorIdentityFromProjection(runtimeActor) : null,
  ].filter((actor): actor is NonNullable<typeof actor> => Boolean(actor));
  const interaction = scenario.capabilities.interaction;

  return (
    <div className="flex min-w-0 items-center gap-2">
      {interaction ? (
        <NotebookEditModeButton
          mode={interaction.selectedMode}
          state={interaction.state}
          disabled={!interaction.canRequestEdit && interaction.activeMode !== "edit"}
          onModeChange={noop}
          className="h-7 text-xs"
        />
      ) : null}
      {actors.slice(0, 2).map((actor) => (
        <NotebookIdentityBadge key={actor.id} actor={actor} size="sm" showDetail={false} />
      ))}
      {actors.length === 0 ? (
        <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-background px-2 text-xs text-muted-foreground">
          {scenario.capabilities.access.source === "local" ? (
            <Laptop className="size-3.5" aria-hidden="true" />
          ) : (
            <UserRound className="size-3.5" aria-hidden="true" />
          )}
          anonymous
        </span>
      ) : null}
    </div>
  );
}

function ScenarioPill({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-fd-border bg-fd-background px-2 py-0.5">
      {label}
    </span>
  );
}
