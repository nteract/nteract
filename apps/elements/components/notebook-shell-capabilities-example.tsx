"use client";

import {
  AlertTriangle,
  Check,
  CircleSlash2,
  Cloud,
  Code2,
  Eye,
  FileCode2,
  GitBranch,
  Info,
  KeyRound,
  ListTree,
  Monitor,
  Package,
  PencilLine,
  PlayCircle,
  Rows3,
  Share2,
  ShieldCheck,
  TestTube2,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  NotebookNotice,
  NotebookNoticeAction,
  type NotebookNoticeTone,
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
  type ElementsNotebookScenarioId,
} from "@/components/notebook-scenarios";
import { Eyebrow } from "@/components/surface-primitives";

type BooleanCapabilityKey = {
  [Key in keyof NotebookShellCapabilities]-?: NotebookShellCapabilities[Key] extends boolean
    ? Key
    : never;
}[keyof NotebookShellCapabilities];

const scenarioIds: ElementsNotebookScenarioId[] = [
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

const hostFlows: {
  title: string;
  icon: LucideIcon;
  facts: string;
  adapter: string;
  sharedSurface: string;
}[] = [
  {
    title: "Desktop host",
    icon: Monitor,
    facts:
      "local file mutability, daemon session readiness, local actor, hosted scope when attached",
    adapter: "desktopNotebookShellCapabilities",
    sharedSurface: "NotebookDocumentShell + NotebookView + NotebookDocumentRail",
  },
  {
    title: "Cloud host",
    icon: Cloud,
    facts: "OIDC/auth mode, room ACL, requested viewer/editor mode, code-cell presence",
    adapter: "cloudNotebookShellCapabilities",
    sharedSurface: "NotebookDocumentShell + NotebookView + NotebookDocumentHeader",
  },
  {
    title: "Elements host",
    icon: TestTube2,
    facts: "deterministic scenarios, fixture cells, package facts, inert callbacks",
    adapter: "ElementsNotebookScenario.capabilities",
    sharedSurface: "the same shared shell components, without daemon or room side effects",
  },
];

const capabilityRows: {
  key: BooleanCapabilityKey;
  label: string;
  icon: LucideIcon;
  component: string;
  meaning: string;
}[] = [
  {
    key: "canRead",
    label: "Read notebook",
    icon: Eye,
    component: "NotebookDocumentShell, NotebookCellList",
    meaning: "The host can show the document and projected cell list.",
  },
  {
    key: "canEditMarkdown",
    label: "Edit markdown",
    icon: PencilLine,
    component: "NotebookView, MarkdownCell",
    meaning: "Markdown changes are allowed through the host bridge.",
  },
  {
    key: "canEditCells",
    label: "Edit code source",
    icon: Code2,
    component: "NotebookView, CodeCell",
    meaning: "Code and raw cell source editors can accept changes.",
  },
  {
    key: "canEditStructure",
    label: "Edit structure",
    icon: GitBranch,
    component: "NotebookView structure controls",
    meaning: "Cell insert, delete, move, and document structure changes are available.",
  },
  {
    key: "canRequestEdit",
    label: "Request edit",
    icon: KeyRound,
    component: "NotebookDocumentHeader edit slot",
    meaning: "The host can render a sign-in or edit-mode affordance separate from write access.",
  },
  {
    key: "canExecute",
    label: "Execute",
    icon: PlayCircle,
    component: "NotebookToolbar, CodeCell run controls",
    meaning: "Run and kernel controls are available through the host execution adapter.",
  },
  {
    key: "canToggleCode",
    label: "Toggle source",
    icon: FileCode2,
    component: "NotebookDocumentHeader code slot",
    meaning: "The host can expose source visibility controls for notebooks with code cells.",
  },
  {
    key: "canViewPackages",
    label: "View packages",
    icon: Package,
    component: "NotebookDocumentRail, NotebookPackageSummaryPanel",
    meaning: "Package details can be inspected even when management is disabled.",
  },
  {
    key: "canManagePackages",
    label: "Manage packages",
    icon: Package,
    component: "Environment dependency panels, package rail controls",
    meaning: "Package edits, sync actions, and rebuild decisions are available.",
  },
  {
    key: "canManageSharing",
    label: "Manage sharing",
    icon: Share2,
    component: "NotebookDocumentHeader sharing slot",
    meaning: "Host-specific ACL or invite controls can render.",
  },
];

const componentRows = [
  {
    component: "NotebookDocumentShell",
    path: "src/components/notebook/NotebookDocumentShell.tsx",
    use: "Hosts the document stage, header, rail, notice slots, and capability data attributes.",
    hostBoundary: "No Tauri, OIDC, room host, daemon, or catalog router imports.",
  },
  {
    component: "NotebookDocumentHeader",
    path: "src/components/notebook/NotebookDocumentHeader.tsx",
    use: "Gates utility, runtime, code, sharing, edit, and auth slots from capabilities.",
    hostBoundary: "Controls stay host-specific; visibility policy stays shared.",
  },
  {
    component: "NotebookView",
    path: "apps/notebook/src/components/NotebookView.tsx",
    use: "Renders editable markdown, code cells, raw cells, outputs, and stable DOM order.",
    hostBoundary: "Receives capabilities and callbacks instead of reading cloud or desktop state.",
  },
  {
    component: "NotebookDocumentRail",
    path: "src/components/notebook/NotebookDocumentRail.tsx",
    use: "Projects outline and packages through the shared view model.",
    hostBoundary: "Navigation and package writes remain host callbacks.",
  },
  {
    component: "createNotebookViewModel",
    path: "src/components/notebook/view-model.ts",
    use: "Materializes cells, outline items, heading anchors, view-only cells, and package summaries.",
    hostBoundary: "Hosts provide source facts; the projection stays notebook-semantic.",
  },
];

export function NotebookShellCapabilitiesExample() {
  const scenarios = scenarioIds.map((id) => getElementsNotebookScenario(id));

  return (
    <div className="not-prose space-y-6" data-elements-slot="notebook-shell-capabilities">
      <section className="border-l border-fd-border py-1 pl-4 text-fd-muted-foreground">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Shared host contract</h2>
            <p className="mt-1 text-xs leading-5">
              Desktop, cloud, and Elements should feed the same shell facts into the same notebook
              components. The catalog fixtures are only a host adapter: they provide capabilities,
              projected cells, package state, and inert callbacks.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        {hostFlows.map((flow) => (
          <article key={flow.title} className="rounded-lg border border-fd-border bg-fd-card p-4">
            <flow.icon className="mb-3 size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">{flow.title}</h2>
            <dl className="mt-3 space-y-3 text-xs leading-5">
              <div>
                <Eyebrow as="dt">Source facts</Eyebrow>
                <dd className="mt-1 text-fd-muted-foreground">{flow.facts}</dd>
              </div>
              <div>
                <Eyebrow as="dt">Adapter</Eyebrow>
                <dd className="mt-1 break-words font-mono text-[11px] text-fd-foreground">
                  {flow.adapter}
                </dd>
              </div>
              <div>
                <Eyebrow as="dt">Shared surface</Eyebrow>
                <dd className="mt-1 text-fd-muted-foreground">{flow.sharedSurface}</dd>
              </div>
            </dl>
          </article>
        ))}
      </section>

      <ElementsNotebookEnvironment scenarioId="cloud-editor" initialRailCollapsed>
        <ElementsFixtureEnvironmentCard />
      </ElementsNotebookEnvironment>

      <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
          <div className="flex items-center gap-2 border-b border-fd-border p-4">
            <Rows3 className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Scenario capability matrix</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-separate border-spacing-0 text-left text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.08em] text-fd-muted-foreground">
                  <th className="w-64 border-b border-fd-border p-3 font-medium">Capability</th>
                  {scenarios.map((scenario) => (
                    <th key={scenario.id} className="border-b border-fd-border p-3 font-medium">
                      {scenario.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {capabilityRows.map((row) => (
                  <tr key={row.key} className="align-top">
                    <th className="border-b border-fd-border p-3 font-normal">
                      <div className="flex items-start gap-2">
                        <row.icon
                          className="mt-0.5 size-4 flex-none text-fd-muted-foreground"
                          aria-hidden="true"
                        />
                        <div>
                          <div className="font-semibold text-fd-foreground">{row.label}</div>
                          <div className="mt-1 text-[11px] leading-4 text-fd-muted-foreground">
                            {row.meaning}
                          </div>
                          <div className="mt-1 break-words font-mono text-[10px] leading-4 text-fd-muted-foreground">
                            {row.component}
                          </div>
                        </div>
                      </div>
                    </th>
                    {scenarios.map((scenario) => (
                      <td
                        key={`${scenario.id}-${row.key}`}
                        className="border-b border-fd-border p-3"
                      >
                        <CapabilityState enabled={scenario.capabilities[row.key]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-3">
          {scenarios.map((scenario) => (
            <ScenarioCard key={scenario.id} scenario={scenario} />
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="flex items-center gap-2 border-b border-fd-border p-4">
          <Workflow className="size-4 text-fd-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Shared notebook surface</h2>
        </div>
        <div className="grid gap-2 p-4">
          {componentRows.map((row) => (
            <article key={row.component} className="rounded-md border border-fd-border p-3">
              <div className="grid gap-3 md:grid-cols-[240px_minmax(0,1fr)]">
                <div className="min-w-0">
                  <div className="font-semibold">{row.component}</div>
                  <div className="mt-1 break-words font-mono text-[11px] leading-4 text-fd-muted-foreground [overflow-wrap:anywhere]">
                    {row.path}
                  </div>
                </div>
                <div className="grid gap-3 text-xs leading-5 md:grid-cols-2">
                  <div>
                    <Eyebrow>Shared use</Eyebrow>
                    <p className="mt-1 text-fd-muted-foreground">{row.use}</p>
                  </div>
                  <div>
                    <Eyebrow>Host keeps</Eyebrow>
                    <p className="mt-1 text-fd-muted-foreground">{row.hostBoundary}</p>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-dashed border-fd-border bg-fd-background p-4">
        <div className="mb-3 flex items-center gap-2">
          <ListTree className="size-4 text-fd-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Catalog rule</h2>
        </div>
        <p className="text-xs leading-5 text-fd-muted-foreground">
          New Elements pages should start from these scenarios when they need document context.
          Lower-level fixtures are still fine for isolated renderers, but shell-level pages should
          not invent their own desktop/cloud permission vocabulary.
        </p>
      </section>
    </div>
  );
}

function ElementsFixtureEnvironmentCard() {
  const environment = useElementsNotebookEnvironment();
  const firstCellId = environment.document.viewModel.cellIds[0] ?? null;

  return (
    <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div className="flex items-center gap-2 border-b border-fd-border p-4">
        <TestTube2 className="size-4 text-fd-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Elements fixture environment</h2>
      </div>
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div>
          <p className="text-xs leading-5 text-fd-muted-foreground">
            Catalog pages that need notebook context can wrap production shell components in
            `ElementsNotebookEnvironment`. The provider emits scenario capabilities, rail state,
            document facts, output fixtures, runtime/package projections, and inert host actions.
          </p>
          <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
            <FixtureFact label="Scenario" value={environment.scenario.title} />
            <FixtureFact
              label="Access"
              value={`${environment.capabilities.access.source}:${environment.capabilities.access.level}`}
            />
            <FixtureFact
              label="Document"
              value={`${environment.document.cellCount} cells, ${environment.rail.outlineItemCount} headings`}
            />
            <FixtureFact
              label="Packages"
              value={`${environment.rail.packageCount} projected packages`}
            />
            <FixtureFact label="Runtime" value={environment.runtime.label} />
            <FixtureFact
              label="Outputs"
              value={`${environment.outputs.outputAreaOutputs.length} outputs, ${environment.outputs.widgetOutputs.length} widget views`}
            />
            <FixtureFact label="Notices" value={`${environment.notices.length} projected`} />
          </dl>
          {environment.notices.length ? (
            <div className="mt-4 space-y-2">
              {environment.notices.slice(0, 3).map((notice) => (
                <NotebookNotice
                  key={`${notice.tone}-${notice.title}`}
                  tone={notice.tone}
                  icon={<NoticeIcon tone={notice.tone} />}
                  title={notice.title}
                  details={<span>{notice.details}</span>}
                  actions={
                    notice.actionLabel ? (
                      <NotebookNoticeAction
                        onClick={() =>
                          environment.actions.recordHostAction(
                            `notice:${notice.actionLabel?.toLowerCase()}`,
                          )
                        }
                      >
                        {notice.actionLabel}
                      </NotebookNoticeAction>
                    ) : null
                  }
                  className="rounded-md border"
                >
                  {notice.body}
                </NotebookNotice>
              ))}
            </div>
          ) : null}
        </div>
        <div className="rounded-md border border-fd-border bg-fd-background p-3">
          <Eyebrow>Inert host callbacks</Eyebrow>
          <div className="mt-3 flex flex-wrap gap-2">
            <FixtureActionButton
              label="Open packages"
              onClick={() => environment.actions.setActivePanel("packages")}
            />
            <FixtureActionButton
              label={environment.rail.collapsed ? "Expand rail" : "Collapse rail"}
              onClick={() => environment.actions.setRailCollapsed(!environment.rail.collapsed)}
            />
            <FixtureActionButton
              label="Select first cell"
              onClick={() => environment.actions.selectCell(firstCellId)}
            />
            <FixtureActionButton
              label="Host action"
              onClick={() => environment.actions.recordHostAction("request-edit")}
            />
            <FixtureActionButton label="Clear" onClick={environment.actions.clearEventLog} />
          </div>
          <ol className="mt-3 min-h-20 space-y-1 font-mono text-[11px] text-fd-muted-foreground">
            {environment.actions.eventLog.length ? (
              environment.actions.eventLog.map((item, index) => (
                <li key={`${item}-${index}`}>{item}</li>
              ))
            ) : (
              <li>No events recorded</li>
            )}
          </ol>
        </div>
      </div>
    </section>
  );
}

function FixtureFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Eyebrow as="dt">{label}</Eyebrow>
      <dd className="mt-1 text-fd-foreground">{value}</dd>
    </div>
  );
}

function FixtureActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rounded-md border border-fd-border bg-fd-card px-2 py-1 text-xs font-medium text-fd-foreground transition-colors hover:bg-fd-muted"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function CapabilityState({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[11px] font-medium",
        enabled ? "text-emerald-700 dark:text-emerald-300" : "text-fd-muted-foreground",
      )}
    >
      {enabled ? (
        <Check className="size-3" aria-hidden="true" />
      ) : (
        <CircleSlash2 className="size-3" aria-hidden="true" />
      )}
      {enabled ? "yes" : "no"}
    </span>
  );
}

function ScenarioCard({ scenario }: { scenario: ElementsNotebookScenario }) {
  const enabledLabels = [
    scenario.capabilities.canEditMarkdown ? "markdown" : null,
    scenario.capabilities.canEditCells ? "code source" : null,
    scenario.capabilities.canExecute ? "execute" : null,
    scenario.capabilities.runtime.canWriteRuntimeState ? "runtime state" : null,
    scenario.capabilities.canManagePackages ? "packages" : null,
    scenario.capabilities.canManageSharing ? "sharing" : null,
  ].filter(Boolean);
  const authLabel = scenario.capabilities.auth.needsAttention
    ? "auth attention"
    : scenario.capabilities.auth.canUseAuthenticatedIdentity
      ? "authenticated"
      : scenario.capabilities.auth.canSignIn
        ? "sign-in available"
        : "local fixture";

  return (
    <article className="rounded-lg border border-fd-border bg-fd-card text-xs leading-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 px-3 pt-3">
          <div className="font-semibold text-fd-foreground">{scenario.title}</div>
          <div className="mt-1 text-[11px] text-fd-muted-foreground">{scenario.eyebrow}</div>
        </div>
        <span className="shrink-0 px-3 pt-3 text-[10px] font-medium text-fd-muted-foreground">
          {scenario.capabilities.access.source} / {scenario.capabilities.access.level}
        </span>
      </div>
      <p className="px-3 pt-2 text-fd-muted-foreground">{scenario.summary}</p>
      <div className="mt-3 divide-y divide-fd-border/70 border-y border-fd-border/70">
        <ScenarioSignal label="Auth" value={authLabel} />
        <ScenarioSignal
          label="Runtime"
          value={`${scenario.runtimeLabel} / ${scenario.packageSummary}`}
        />
        <ScenarioSignal
          label="Notices"
          value={scenario.notices.length ? `${scenario.notices.length} projected` : "none"}
        />
        <ScenarioSignal
          label="Changes"
          value={enabledLabels.length ? enabledLabels.join(", ") : "view only"}
        />
      </div>
      <dl className="grid gap-2 px-3 pt-3">
        {scenario.sourceFacts.map((fact) => (
          <div key={fact.label}>
            <Eyebrow as="dt">{fact.label}</Eyebrow>
            <dd className="mt-0.5 text-[11px] leading-4 text-fd-foreground">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {scenario.notices.length ? (
        <div className="mt-3 border-t border-fd-border px-3 pt-3">
          <Eyebrow>Projected notices</Eyebrow>
          <ul className="mt-2 space-y-1.5">
            {scenario.notices.map((notice) => (
              <li key={`${notice.tone}-${notice.title}`} className="text-[11px] leading-4">
                <span className="font-medium text-fd-foreground">{notice.title}</span>
                <span className="text-fd-muted-foreground"> · {notice.body}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-3 border-t border-fd-border px-3 py-3">
        <Eyebrow>Host boundary</Eyebrow>
        <ul className="mt-2 space-y-2">
          {scenario.hostBoundaries.map((boundary) => (
            <li key={boundary.surface} className="text-[11px] leading-4">
              <span className="font-medium text-fd-foreground">{boundary.surface}: </span>
              <span className="text-fd-muted-foreground">{boundary.sharedSurface}</span>
              <span className="text-fd-muted-foreground">; </span>
              <span className="text-fd-muted-foreground">{boundary.hostAuthority}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

function NoticeIcon({ tone }: { tone: NotebookNoticeTone }) {
  switch (tone) {
    case "warning":
    case "error":
      return <AlertTriangle className="size-3.5" />;
    case "success":
      return <ShieldCheck className="size-3.5" />;
    default:
      return <Info className="size-3.5" />;
  }
}

function ScenarioSignal({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 px-3 py-1.5">
      <Eyebrow>{label}</Eyebrow>
      <div className="min-w-0 text-[11px] text-fd-foreground">{value}</div>
    </div>
  );
}
