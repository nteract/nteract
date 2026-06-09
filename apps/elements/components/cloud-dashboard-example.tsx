"use client";

import {
  ArrowRight,
  BookOpen,
  Clock3,
  FilePlus2,
  Globe2,
  LayoutDashboard,
  Link2,
  LockKeyhole,
  MoreHorizontal,
  RefreshCw,
  Search,
  Share2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  projectCloudNotebookDashboard,
  type CloudNotebookDashboardMetric,
  type CloudNotebookListItem,
} from "@/components/notebook/workspace/notebook-dashboard";

type NotebookAccess = "owner" | "editor" | "viewer";

interface DashboardNotebook {
  id: string;
  title: string;
  access: NotebookAccess;
  updatedAt: string;
  summary: string;
  latestRevision: "published" | "draft";
  public: boolean;
}

interface DashboardMetric {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
}

const notebooks = [
  {
    id: "01KTFZYC",
    title: "Topic visualization",
    access: "owner",
    updatedAt: "18 minutes ago",
    summary: "Embeddings, clustering, Plotly charts, and narrative markdown.",
    latestRevision: "draft",
    public: true,
  },
  {
    id: "01KTHAZR",
    title: "Runtime peer smoke",
    access: "owner",
    updatedAt: "42 minutes ago",
    summary: "Remote workstation lifecycle with queued execution probes.",
    latestRevision: "draft",
    public: false,
  },
  {
    id: "01KTEYJH",
    title: "Lab dual peer",
    access: "editor",
    updatedAt: "Yesterday",
    summary: "Shared cloud room, Python kernel, and browser editor checks.",
    latestRevision: "published",
    public: false,
  },
  {
    id: "01KSQKEP",
    title: "Markdown harness",
    access: "viewer",
    updatedAt: "May 31",
    summary: "Long document outline, tables, callouts, and heading anchors.",
    latestRevision: "published",
    public: true,
  },
] satisfies readonly DashboardNotebook[];

// The catalog drives ordering, metrics, and the sidebar from the same shared
// projection the hosted /n dashboard uses, so this fixture cannot drift from
// production behavior. Display-only flavor (per-notebook summary, share state)
// stays local because the list API does not carry it.
const METRIC_ICONS: Record<CloudNotebookDashboardMetric["icon"], LucideIcon> = {
  notebooks: BookOpen,
  owned: UserRound,
  published: Globe2,
};

const dashboard = projectDashboard(notebooks);

function projectDashboard(source: readonly DashboardNotebook[]) {
  const byId = new Map(source.map((notebook) => [notebook.id, notebook] as const));
  const model = projectCloudNotebookDashboard(source.map(toListItem));
  const display = (item: CloudNotebookListItem): DashboardNotebook =>
    byId.get(item.notebook_id) ?? source[0]!;
  return {
    continueNotebook: model.continueNotebook ? display(model.continueNotebook) : source[0]!,
    notebooks: model.notebooks.map(display),
    published: model.sidebar.published.map(display),
    access: model.sidebar.access,
    metrics: model.metrics.map((metric) => ({
      label: metric.label,
      value: metric.value,
      detail: metric.detail,
      icon: METRIC_ICONS[metric.icon],
    })),
  };
}

function toListItem(notebook: DashboardNotebook, index: number): CloudNotebookListItem {
  // Earlier in the fixture array reads as more recently updated.
  const updatedAt = new Date(Date.UTC(2026, 5, 8, 12) - index * 3_600_000).toISOString();
  return {
    notebook_id: notebook.id,
    title: notebook.title,
    owner_principal: "user:dev:kyle",
    scope: notebook.access,
    created_at: updatedAt,
    updated_at: updatedAt,
    latest_revision_id: notebook.latestRevision === "published" ? `rev-${notebook.id}` : null,
    viewer_url: "#cloud-dashboard-notebooks",
    endpoints: { catalog: "", acl: "", access_requests: "" },
  };
}

export function CloudDashboardExample() {
  return (
    <div className="not-prose space-y-6" data-elements-slot="cloud-dashboard">
      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-background">
        <CloudDashboardFrame />
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <SharePreview notebook={dashboard.continueNotebook} />
        <DashboardPrinciples />
      </section>
    </div>
  );
}

function CloudDashboardFrame() {
  const continued = dashboard.continueNotebook;

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
            Continue recent work, open shared notebooks, and choose compute when a notebook needs
            it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <DashboardButton icon={Search} label="Search" />
          <DashboardButton icon={RefreshCw} label="Refresh" />
          <DashboardButton icon={FilePlus2} label="New notebook" intent="primary" />
        </div>
      </header>

      <main className="grid gap-5 px-4 py-5 md:px-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <section className="grid gap-5">
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
                  {continued.title}
                </h3>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-fd-muted-foreground">
                  {continued.summary}
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
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-fd-muted-foreground">
              <InlineFact icon={Clock3} label={continued.updatedAt} />
              <InlineFact icon={UserRound} label={continued.access} />
              <InlineFact
                icon={continued.public ? Globe2 : LockKeyhole}
                label={shareLabel(continued)}
              />
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-3" aria-label="Notebook summary">
            {dashboard.metrics.map((metric) => (
              <DashboardMetricCell key={metric.label} metric={metric} />
            ))}
          </section>

          <section id="cloud-dashboard-notebooks" aria-label="Notebook list">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Notebooks</h3>
              <button
                type="button"
                className="inline-flex size-8 items-center justify-center rounded-md text-fd-muted-foreground hover:bg-fd-muted hover:text-fd-foreground"
                aria-label="Notebook list options"
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </button>
            </div>
            <ol className="divide-y divide-fd-border border-y border-fd-border">
              {dashboard.notebooks.map((notebook) => (
                <NotebookDashboardRow key={notebook.id} notebook={notebook} />
              ))}
            </ol>
          </section>
        </section>

        <aside className="grid content-start gap-5">
          <section
            className="border-t border-fd-border pt-4"
            aria-labelledby="cloud-dashboard-published"
          >
            <p className="text-xs font-medium uppercase tracking-normal text-fd-muted-foreground">
              Sharing
            </p>
            <h3 id="cloud-dashboard-published" className="mt-1 text-base font-semibold">
              Published previews
            </h3>
            {dashboard.published.length > 0 ? (
              <ul className="mt-3 grid gap-1">
                {dashboard.published.map((notebook) => (
                  <li key={notebook.id}>
                    <a
                      href="#cloud-dashboard-notebooks"
                      className="-mx-1.5 inline-flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-sm text-fd-foreground no-underline hover:bg-fd-muted/50"
                    >
                      <Globe2
                        className="size-3.5 text-emerald-600 dark:text-emerald-400"
                        aria-hidden="true"
                      />
                      <span className="truncate">{notebook.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm leading-5 text-fd-muted-foreground">
                Publish a revision to expose safe metadata and revision-aware preview images.
              </p>
            )}
          </section>

          <section
            className="border-t border-fd-border pt-4"
            aria-labelledby="cloud-dashboard-access"
          >
            <p className="text-xs font-medium uppercase tracking-normal text-fd-muted-foreground">
              Access
            </p>
            <h3 id="cloud-dashboard-access" className="mt-1 text-base font-semibold">
              Your roles
            </h3>
            <dl className="mt-3 grid grid-cols-3 gap-2">
              <AccessStat label="Owned" value={dashboard.access.owned} />
              <AccessStat label="Editable" value={dashboard.access.editable} />
              <AccessStat label="View-only" value={dashboard.access.viewOnly} />
            </dl>
          </section>
        </aside>
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

function InlineFact({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

function DashboardMetricCell({ metric }: { metric: DashboardMetric }) {
  const Icon = metric.icon;
  return (
    <div className="border-t border-fd-border pt-3">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-normal text-fd-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" />
        {metric.label}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-normal">{metric.value}</p>
      <p className="mt-1 text-xs text-fd-muted-foreground">{metric.detail}</p>
    </div>
  );
}

function NotebookDashboardRow({ notebook }: { notebook: DashboardNotebook }) {
  return (
    <li>
      <a
        href="#cloud-dashboard-notebooks"
        className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 py-3 text-fd-foreground no-underline hover:bg-fd-muted/40"
      >
        <span className="min-w-0 px-2 md:px-3">
          <span className="block truncate text-sm font-semibold">{notebook.title}</span>
          <span className="mt-1 block truncate text-xs text-fd-muted-foreground">
            {notebook.summary}
          </span>
          <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            <NotebookScope access={notebook.access} />
            <span className="inline-flex items-center gap-1.5 text-xs text-fd-muted-foreground">
              {notebook.public ? (
                <Globe2 className="size-3.5" aria-hidden="true" />
              ) : (
                <LockKeyhole className="size-3.5" aria-hidden="true" />
              )}
              {shareLabel(notebook)}
            </span>
          </span>
        </span>
        <span className="inline-flex items-center justify-end gap-1.5 pr-2 text-xs text-fd-muted-foreground md:pr-3">
          <Clock3 className="size-3.5" aria-hidden="true" />
          {notebook.updatedAt}
        </span>
      </a>
    </li>
  );
}

function NotebookScope({ access }: { access: NotebookAccess }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center justify-center rounded-md border px-2 text-xs font-medium",
        access === "owner"
          ? "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300"
          : access === "editor"
            ? "border-sky-500/30 bg-sky-500/[0.07] text-sky-700 dark:text-sky-300"
            : "border-fd-border bg-fd-muted/40 text-fd-muted-foreground",
      )}
    >
      {access}
    </span>
  );
}

function AccessStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[0.68rem] font-medium uppercase tracking-normal text-fd-muted-foreground">
        {label}
      </dt>
      <dd className="m-0 text-xl font-semibold">{value}</dd>
    </div>
  );
}

function SharePreview({ notebook }: { notebook: DashboardNotebook }) {
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
              {notebook.title}
            </h3>
            <p className="mt-3 line-clamp-2 max-w-xl text-sm leading-6 text-fd-muted-foreground">
              {notebook.summary}
            </p>
          </div>
          <div className="flex items-center justify-between gap-3 text-xs text-fd-muted-foreground">
            <span>Published preview</span>
            <span className="inline-flex items-center gap-1.5">
              {notebook.public ? (
                <Globe2 className="size-3.5" aria-hidden="true" />
              ) : (
                <LockKeyhole className="size-3.5" aria-hidden="true" />
              )}
              {shareLabel(notebook)}
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

function shareLabel(notebook: DashboardNotebook): string {
  if (notebook.public) {
    return notebook.latestRevision === "published" ? "public revision" : "public draft";
  }
  return notebook.latestRevision === "published" ? "private revision" : "private draft";
}
