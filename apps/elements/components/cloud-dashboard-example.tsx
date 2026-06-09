"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  Clock3,
  FilePlus2,
  Globe2,
  LayoutDashboard,
  Link2,
  LockKeyhole,
  RefreshCw,
  Search,
  Share2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  cloudNotebookDisplayTitle,
  projectCloudNotebookDashboard,
  projectCloudNotebookDashboardView,
  type CloudNotebookDashboardFilterId,
  type CloudNotebookDashboardRow,
  type CloudNotebookDashboardRowFact,
  type CloudNotebookListItem,
} from "@/components/notebook/workspace/notebook-dashboard";

// Deterministic notebooks in the real list-item shape. The catalog renders the
// production projection over these, so it cannot drift from the hosted /n
// dashboard. Summaries are catalog flavor; the list API does not carry them.
const HOUR = 3_600_000;
const BASE_TIME = Date.UTC(2026, 5, 9, 12);

const notebooks: readonly CloudNotebookListItem[] = [
  listItem("01KTFZYC", "Topic visualization", "owner", 0, "rev-topic"),
  listItem("01KTHAZR", "Runtime peer smoke", "owner", 1, null),
  listItem("01KTEYJH", "Lab dual peer", "editor", 24, "rev-lab"),
  listItem("01KSQKEP", "Markdown harness", "viewer", 9 * 24, "rev-md"),
  listItem("01KSA1B2", null, "owner", 30 * 24, null),
] as const;

const summaries: Record<string, string> = {
  "01KTFZYC": "Embeddings, clustering, Plotly charts, and narrative markdown.",
  "01KTHAZR": "Remote workstation lifecycle with queued execution probes.",
  "01KTEYJH": "Shared cloud room, Python kernel, and browser editor checks.",
  "01KSQKEP": "Long document outline, tables, callouts, and heading anchors.",
};

const model = projectCloudNotebookDashboard(notebooks);

function listItem(
  id: string,
  title: string | null,
  scope: CloudNotebookListItem["scope"],
  ageHours: number,
  latestRevisionId: string | null,
): CloudNotebookListItem {
  const updatedAt = new Date(BASE_TIME - ageHours * HOUR).toISOString();
  return {
    notebook_id: id,
    title,
    owner_principal: "user:dev:kyle",
    scope,
    created_at: new Date(BASE_TIME - (ageHours + 240) * HOUR).toISOString(),
    updated_at: updatedAt,
    latest_revision_id: latestRevisionId,
    viewer_url: "#cloud-dashboard-notebooks",
    endpoints: {
      catalog: `/api/n/${id}`,
      acl: `/api/n/${id}/acl`,
      access_requests: `/api/n/${id}/access-requests`,
    },
  };
}

export function CloudDashboardExample() {
  return (
    <div className="not-prose space-y-6" data-elements-slot="cloud-dashboard">
      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-background">
        <CloudDashboardFrame />
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <SharePreview notebook={model.continueNotebook} />
        <DashboardPrinciples />
      </section>
    </div>
  );
}

function CloudDashboardFrame() {
  const [filterId, setFilterId] = useState<CloudNotebookDashboardFilterId>("all");
  const view = useMemo(() => projectCloudNotebookDashboardView(model, { filterId }), [filterId]);
  const continued = model.continueNotebook;

  return (
    <div className="min-h-[44rem] bg-fd-background text-fd-foreground">
      <header className="flex flex-col gap-4 border-b border-fd-border px-4 py-4 md:flex-row md:items-end md:justify-between md:px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-normal text-fd-muted-foreground">
            <LayoutDashboard className="size-3.5" aria-hidden="true" />
            Notebook home
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-normal md:text-3xl">
            Good morning, Kyle
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-fd-muted-foreground">
            Continue recent work, filter the notebooks you can reach, and open shared rooms.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <DashboardButton icon={Search} label="Search" />
          <DashboardButton icon={RefreshCw} label="Refresh" />
          <DashboardButton icon={FilePlus2} label="New notebook" intent="primary" />
        </div>
      </header>

      <main className="grid gap-5 px-4 py-5 md:px-6">
        {continued ? (
          <section
            className="border-t border-emerald-500/30 bg-gradient-to-b from-emerald-500/[0.08] via-fd-background to-fd-background px-1 py-4"
            aria-labelledby="cloud-dashboard-continue"
          >
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-normal text-emerald-700 dark:text-emerald-300">
                  Continue
                </p>
                <h3
                  id="cloud-dashboard-continue"
                  className="mt-1 truncate text-xl font-semibold tracking-normal"
                >
                  {cloudNotebookDisplayTitle(continued)}
                </h3>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-fd-muted-foreground">
                  {summaries[continued.notebook_id] ?? "Hosted notebook room."}
                </p>
              </div>
              <a
                href="#cloud-dashboard-notebooks"
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md bg-fd-foreground px-3 text-sm font-medium text-fd-background"
              >
                Open
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
            </div>
            {model.continueRow ? (
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-fd-muted-foreground">
                <InlineFact icon={Clock3} label="updated recently" />
                {model.continueRow.facts.map((fact) => (
                  <InlineFact
                    key={fact.kind}
                    icon={fact.kind === "published" ? Globe2 : UserRound}
                    label={fact.label}
                  />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        <nav className="flex flex-wrap items-center gap-2" aria-label="Notebook filters">
          {view.filterGroups.map((group) =>
            group.filters.map((filter) => (
              <FilterChip
                key={filter.id}
                label={filter.label}
                count={filter.count}
                active={view.filterId === filter.id}
                onSelect={() => setFilterId(filter.id)}
              />
            )),
          )}
        </nav>

        <section id="cloud-dashboard-notebooks" aria-label="Notebook list" className="grid gap-5">
          {view.showResultCount ? (
            <p className="text-xs text-fd-muted-foreground">
              {view.resultCount} {view.resultCount === 1 ? "notebook" : "notebooks"}
            </p>
          ) : null}
          {view.sections.length > 0 ? (
            view.sections.map((section) => (
              <div key={section.id}>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-semibold">{section.title}</h3>
                  <span className="text-xs text-fd-muted-foreground">{section.detail}</span>
                </div>
                <ol className="divide-y divide-fd-border border-y border-fd-border">
                  {section.rows.map((row) => (
                    <NotebookDashboardRow key={row.notebook.notebook_id} row={row} />
                  ))}
                </ol>
              </div>
            ))
          ) : (
            <p className="rounded-md border border-fd-border px-3 py-6 text-center text-sm text-fd-muted-foreground">
              {view.emptyMessage}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}

function DashboardButton({
  icon: Icon,
  label,
  intent = "secondary",
}: {
  icon: LucideIcon;
  label: string;
  intent?: "primary" | "secondary";
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium",
        intent === "primary"
          ? "border-fd-foreground bg-fd-foreground text-fd-background"
          : "border-fd-border bg-fd-background text-fd-foreground hover:bg-fd-muted/60",
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {label}
    </button>
  );
}

function FilterChip({
  label,
  count,
  active,
  onSelect,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium",
        active
          ? "border-fd-foreground bg-fd-foreground text-fd-background"
          : "border-fd-border bg-fd-background text-fd-muted-foreground hover:text-fd-foreground",
      )}
    >
      {label}
      <span className={cn("tabular-nums", active ? "opacity-80" : "opacity-60")}>{count}</span>
    </button>
  );
}

function InlineFact({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

function NotebookDashboardRow({ row }: { row: CloudNotebookDashboardRow }) {
  const { notebook } = row;
  return (
    <li>
      <a
        href="#cloud-dashboard-notebooks"
        className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 py-3 text-fd-foreground no-underline hover:bg-fd-muted/40"
      >
        <span className="min-w-0 px-2 md:px-3">
          <span className="block truncate text-sm font-semibold">
            {cloudNotebookDisplayTitle(notebook)}
          </span>
          <span className="mt-1 block truncate text-xs text-fd-muted-foreground">
            {summaries[notebook.notebook_id] ?? row.contextLabel ?? "Hosted notebook room."}
          </span>
          <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {row.facts.map((fact) => (
              <RowFact key={fact.kind} fact={fact} />
            ))}
          </span>
        </span>
        <span className="inline-flex items-center justify-end gap-1.5 pr-2 text-xs text-fd-muted-foreground md:pr-3">
          {row.identityLabel ? (
            <>
              <UserRound className="size-3.5" aria-hidden="true" />
              {row.identityLabel}
            </>
          ) : null}
        </span>
      </a>
    </li>
  );
}

function RowFact({ fact }: { fact: CloudNotebookDashboardRowFact }) {
  if (fact.kind === "published") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-fd-muted-foreground">
        <Globe2 className="size-3.5" aria-hidden="true" />
        {fact.label}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center justify-center rounded-md border px-2 text-xs font-medium",
        fact.label === "owner"
          ? "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300"
          : fact.label === "editor"
            ? "border-sky-500/30 bg-sky-500/[0.07] text-sky-700 dark:text-sky-300"
            : "border-fd-border bg-fd-muted/40 text-fd-muted-foreground",
      )}
    >
      {fact.label}
    </span>
  );
}

function SharePreview({ notebook }: { notebook: CloudNotebookListItem | null }) {
  if (!notebook) return null;
  const published = Boolean(notebook.latest_revision_id);
  return (
    <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-background">
      <div className="border-b border-fd-border px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-normal text-fd-muted-foreground">
          <Share2 className="size-3.5" aria-hidden="true" />
          Share preview
        </div>
      </div>
      <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="grid aspect-[1.91/1] content-between overflow-hidden rounded-md border border-fd-border bg-gradient-to-br from-fd-background via-fd-muted/40 to-emerald-500/[0.12] p-5">
          <div>
            <p className="font-mono text-[0.68rem] uppercase tracking-normal text-fd-muted-foreground">
              nteract notebook
            </p>
            <h3 className="mt-2 line-clamp-2 text-2xl font-semibold tracking-normal">
              {cloudNotebookDisplayTitle(notebook)}
            </h3>
            <p className="mt-3 line-clamp-2 max-w-xl text-sm leading-6 text-fd-muted-foreground">
              {summaries[notebook.notebook_id] ?? "Hosted notebook room."}
            </p>
          </div>
          <div className="flex items-center justify-between gap-3 text-xs text-fd-muted-foreground">
            <span>{published ? "Published preview" : "Draft (no published revision)"}</span>
            <span className="inline-flex items-center gap-1.5">
              {published ? (
                <Globe2 className="size-3.5" aria-hidden="true" />
              ) : (
                <LockKeyhole className="size-3.5" aria-hidden="true" />
              )}
              {published ? "revision" : "draft"}
            </span>
          </div>
        </div>
        <div className="grid content-start gap-3 text-sm leading-6 text-fd-muted-foreground">
          <p>
            Public metadata can use catalog-safe facts first. Content-derived previews should come
            only from an explicit published revision.
          </p>
          <div className="inline-flex w-max items-center gap-1.5 rounded-md border border-fd-border px-2 py-1 text-xs font-medium text-fd-foreground">
            <Link2 className="size-3.5" aria-hidden="true" />
            Revision-aware image
          </div>
        </div>
      </div>
    </section>
  );
}

function DashboardPrinciples() {
  return (
    <section className="rounded-lg border border-fd-border bg-fd-background p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-normal text-fd-muted-foreground">
        <LayoutDashboard className="size-3.5" aria-hidden="true" />
        Dashboard rules
      </div>
      <ul className="mt-3 grid gap-2 text-sm leading-6 text-fd-muted-foreground">
        <li>Use the dashboard for app state, identity, sharing, and workstation selection.</li>
        <li>Keep notebook cells, execution controls, rail panels, and output rendering shared.</li>
        <li>Show private notebook metadata cautiously; public previews need published intent.</li>
      </ul>
    </section>
  );
}
