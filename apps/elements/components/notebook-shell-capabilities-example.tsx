"use client";

import {
  Check,
  CircleSlash2,
  Cloud,
  Code2,
  Eye,
  FileCode2,
  GitBranch,
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
import type { NotebookShellCapabilities } from "@/components/notebook-shell";
import { cn } from "@/lib/utils";
import {
  getElementsNotebookScenario,
  type ElementsNotebookScenario,
  type ElementsNotebookScenarioId,
} from "@/components/notebook-scenarios";

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
    path: "src/components/notebook-shell/NotebookDocumentShell.tsx",
    use: "Hosts the document stage, header, rail, notice slots, and capability data attributes.",
    hostBoundary: "No Tauri, OIDC, room host, daemon, or catalog router imports.",
  },
  {
    component: "NotebookDocumentHeader",
    path: "src/components/notebook-shell/NotebookDocumentHeader.tsx",
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
    path: "src/components/notebook-shell/NotebookDocumentRail.tsx",
    use: "Projects outline and packages through the shared view model.",
    hostBoundary: "Navigation and package writes remain host callbacks.",
  },
  {
    component: "createNotebookViewModel",
    path: "src/components/notebook-shell/view-model.ts",
    use: "Materializes cells, outline items, heading anchors, view-only cells, and package summaries.",
    hostBoundary: "Hosts provide source facts; the projection stays notebook-semantic.",
  },
];

export function NotebookShellCapabilitiesExample() {
  const scenarios = scenarioIds.map((id) => getElementsNotebookScenario(id));

  return (
    <div className="not-prose space-y-6" data-elements-slot="notebook-shell-capabilities">
      <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-900 dark:text-emerald-200">
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
                <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-fd-muted-foreground">
                  Source facts
                </dt>
                <dd className="mt-1 text-fd-muted-foreground">{flow.facts}</dd>
              </div>
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-fd-muted-foreground">
                  Adapter
                </dt>
                <dd className="mt-1 break-words font-mono text-[11px] text-fd-foreground">
                  {flow.adapter}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-fd-muted-foreground">
                  Shared surface
                </dt>
                <dd className="mt-1 text-fd-muted-foreground">{flow.sharedSurface}</dd>
              </div>
            </dl>
          </article>
        ))}
      </section>

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
                    <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-fd-muted-foreground">
                      Shared use
                    </div>
                    <p className="mt-1 text-fd-muted-foreground">{row.use}</p>
                  </div>
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-fd-muted-foreground">
                      Host keeps
                    </div>
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

function CapabilityState({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium",
        enabled
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-fd-border bg-fd-muted text-fd-muted-foreground",
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
    <article className="rounded-lg border border-fd-border bg-fd-card p-3 text-xs leading-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-fd-foreground">{scenario.title}</div>
          <div className="mt-1 text-[11px] text-fd-muted-foreground">{scenario.eyebrow}</div>
        </div>
        <span className="shrink-0 rounded-full border border-fd-border bg-fd-background px-2 py-0.5 text-[10px] text-fd-muted-foreground">
          {scenario.capabilities.access.source}:{scenario.capabilities.access.level}
        </span>
      </div>
      <p className="mt-2 text-fd-muted-foreground">{scenario.summary}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <ScenarioPill label={authLabel} />
        <ScenarioPill label={scenario.runtimeLabel} />
        <ScenarioPill label={scenario.packageSummary} />
        <ScenarioPill
          label={enabledLabels.length ? `can change: ${enabledLabels.join(", ")}` : "view only"}
        />
      </div>
    </article>
  );
}

function ScenarioPill({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-fd-border bg-fd-background px-2 py-0.5 text-[10px] text-fd-muted-foreground">
      {label}
    </span>
  );
}
