"use client";

import {
  ArrowUpRight,
  BookOpen,
  Clock3,
  Columns3,
  Command,
  FilePlus2,
  Globe2,
  Inbox,
  ListFilter,
  Pin,
  RefreshCw,
  Search,
  Server,
  Share2,
  Table2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NotebookAccess = "owner" | "editor" | "viewer";
type ShareState = "private" | "shared" | "published";
type ComputeState = "ready" | "available" | "detached" | "none";

interface DashboardNotebook {
  id: string;
  title: string | null;
  project: string;
  access: NotebookAccess;
  updatedAt: string;
  summary: string;
  share: ShareState;
  compute: ComputeState;
  pinned?: boolean;
}

interface RankedPattern {
  id: string;
  rank: string;
  title: string;
  verdict: string;
  note: string;
  icon: LucideIcon;
}

const notebooks = [
  {
    id: "nb-forecast",
    title: "Revenue forecast model",
    project: "Planning",
    access: "owner",
    updatedAt: "4 min ago",
    summary: "Quarterly plan with scenario cells and a published preview.",
    share: "published",
    compute: "ready",
    pinned: true,
  },
  {
    id: "nb-hello",
    title: "Hello",
    project: "Scratch",
    access: "owner",
    updatedAt: "18 min ago",
    summary: "Small room used to validate hosted toolbar attachment.",
    share: "private",
    compute: "detached",
  },
  {
    id: "nb-runtime-peer",
    title: "Runtime peer smoke matrix",
    project: "Smoke tests",
    access: "owner",
    updatedAt: "42 min ago",
    summary: "Runtime peer attach, execute, and output replay checks.",
    share: "private",
    compute: "available",
  },
  {
    id: "nb-changelog",
    title: "Changelog render pass",
    project: "Docs",
    access: "editor",
    updatedAt: "1 hr ago",
    summary: "Editorial notebook for release-note screenshots.",
    share: "shared",
    compute: "none",
  },
  {
    id: "nb-untitled-1",
    title: null,
    project: "Smoke tests",
    access: "owner",
    updatedAt: "1 hr ago",
    summary: "Untitled room from toolbar attach smoke 2026-06-08T19:26:35.312Z.",
    share: "private",
    compute: "none",
  },
  {
    id: "nb-auth",
    title: "Hosted auth edge cases",
    project: "Cloud",
    access: "owner",
    updatedAt: "2 hr ago",
    summary: "OIDC renewal, app-session bootstrap, and anonymous viewer checks.",
    share: "shared",
    compute: "detached",
  },
  {
    id: "nb-packages",
    title: "Package rail fixtures",
    project: "Notebook UI",
    access: "editor",
    updatedAt: "2 hr ago",
    summary: "Read-only package metadata and environment source snapshots.",
    share: "private",
    compute: "available",
  },
  {
    id: "nb-renderer",
    title: "Output renderer regression set",
    project: "Renderer",
    access: "owner",
    updatedAt: "4 hr ago",
    summary: "Matplotlib, Vega, Plotly, image, and widget output fixtures.",
    share: "private",
    compute: "ready",
    pinned: true,
  },
  {
    id: "nb-preview",
    title: "Public preview metadata",
    project: "Cloud",
    access: "owner",
    updatedAt: "Yesterday",
    summary: "Revision-safe share cards and preview image behavior.",
    share: "published",
    compute: "detached",
    pinned: true,
  },
  {
    id: "nb-untitled-2",
    title: null,
    project: "Smoke tests",
    access: "owner",
    updatedAt: "Yesterday",
    summary: "Untitled room from hosted source-room smoke.",
    share: "private",
    compute: "none",
  },
  {
    id: "nb-kernel",
    title: "Kernel interrupt behavior",
    project: "Runtime",
    access: "owner",
    updatedAt: "2 days ago",
    summary: "Long-running cells, interrupt controls, and terminal state ordering.",
    share: "private",
    compute: "ready",
  },
  {
    id: "nb-import",
    title: "Customer notebook import",
    project: "Imports",
    access: "editor",
    updatedAt: "3 days ago",
    summary: "Imported notebook with markdown-heavy cells and attachments.",
    share: "shared",
    compute: "none",
  },
] satisfies readonly DashboardNotebook[];

const rankedPatterns = [
  {
    id: "one",
    rank: "1",
    title: "Notebook Switcher First",
    verdict: "base direction",
    note: "Keep search first, then add precedence and filters without returning to a dashboard.",
    icon: Command,
  },
  {
    id: "five",
    rank: "5",
    title: "Inbox Style",
    verdict: "borrow filters",
    note: "Useful for explicit state buckets, but the full inbox layout feels too app-like.",
    icon: Inbox,
  },
  {
    id: "eight",
    rank: "8",
    title: "Activity Log",
    verdict: "borrow time groups",
    note: "Good scan path for testing clutter: today, yesterday, earlier.",
    icon: Clock3,
  },
  {
    id: "ten",
    rank: "10",
    title: "Pinned + Recent",
    verdict: "borrow precedence",
    note: "A pin/favorite lane keeps real notebooks above smoke-test noise.",
    icon: Pin,
  },
] satisfies readonly RankedPattern[];

const essentialPatterns = [
  {
    id: "two",
    rank: "2",
    title: "Triage Buckets",
    verdict: "cleanup essential",
    note: "Recent, needs title, and published are still useful product states.",
    icon: ListFilter,
  },
  {
    id: "nine",
    rank: "9",
    title: "Finder Columns",
    verdict: "organization essential",
    note: "Project grouping matters, but this should probably be a filter mode.",
    icon: Columns3,
  },
  {
    id: "eleven",
    rank: "11",
    title: "Bare File Browser",
    verdict: "density essential",
    note: "The table is boring, but it is the baseline for dense inventory legibility.",
    icon: Table2,
  },
] satisfies readonly RankedPattern[];

const dashboardFacts = {
  visible: 100,
  owned: 88,
  untitled: 25,
  published: 8,
};

export function CloudDashboardExample() {
  return (
    <div className="not-prose space-y-6" data-elements-slot="cloud-dashboard">
      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-background">
        <DashboardReviewFrame />
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <RankedPatternPanel title="Use these as input to direction 1" patterns={rankedPatterns} />
        <RankedPatternPanel title="Keep as baseline constraints" patterns={essentialPatterns} />
      </section>
    </div>
  );
}

function DashboardReviewFrame() {
  const pinned = notebooks.filter((notebook) => notebook.pinned);
  const recent = notebooks.slice(0, 10);

  return (
    <div className="min-h-[48rem] bg-fd-background text-fd-foreground">
      <header className="flex flex-col gap-4 border-b border-fd-border px-4 py-4 md:flex-row md:items-end md:justify-between md:px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-normal text-fd-muted-foreground">
            <Command className="size-3.5" aria-hidden="true" />
            Direction 1 with useful pieces from 5, 8, and 10
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-normal md:text-3xl">
            Find a notebook
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-fd-muted-foreground">
            Search stays primary. Filters, activity groups, and pinned work become quiet precedence
            controls around the list.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <IconButton icon={RefreshCw} label="Refresh" />
          <IconButton icon={FilePlus2} label="New notebook" />
          <IconButton icon={UserRound} label="Account" />
        </div>
      </header>

      <main className="grid gap-5 px-4 py-5 md:px-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="grid min-w-0 gap-5">
          <label className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-fd-border px-4">
            <Search className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            <input
              value="revenue, smoke, renderer..."
              readOnly
              aria-label="Search notebooks"
              className="min-w-0 bg-transparent text-base text-fd-foreground outline-none"
            />
            <kbd className="rounded border border-fd-border bg-fd-muted/30 px-1.5 py-0.5 text-xs text-fd-muted-foreground">
              Cmd K
            </kbd>
          </label>

          <section className="grid gap-3 md:grid-cols-4" aria-label="Notebook filters">
            <FilterChip label="All" value={String(dashboardFacts.visible)} active />
            <FilterChip label="Pinned" value={String(pinned.length)} />
            <FilterChip label="Untitled" value={String(dashboardFacts.untitled)} />
            <FilterChip label="Published" value={String(dashboardFacts.published)} />
          </section>

          <section aria-labelledby="cloud-dashboard-pinned">
            <div className="mb-2 flex items-center gap-2">
              <Pin className="size-3.5 text-fd-muted-foreground" aria-hidden="true" />
              <h3 id="cloud-dashboard-pinned" className="text-sm font-semibold">
                Pinned first
              </h3>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              {pinned.map((notebook) => (
                <PinnedNotebook key={notebook.id} notebook={notebook} />
              ))}
            </div>
          </section>

          <section aria-labelledby="cloud-dashboard-recent">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Clock3 className="size-3.5 text-fd-muted-foreground" aria-hidden="true" />
                <h3 id="cloud-dashboard-recent" className="text-sm font-semibold">
                  Recent activity
                </h3>
              </div>
              <span className="text-xs text-fd-muted-foreground">Today</span>
            </div>
            <ol className="divide-y divide-fd-border border-y border-fd-border">
              {recent.map((notebook) => (
                <NotebookDashboardRow key={notebook.id} notebook={notebook} />
              ))}
            </ol>
          </section>
        </section>

        <aside className="grid content-start gap-4">
          <section className="rounded-lg border border-fd-border p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-normal text-fd-muted-foreground">
              <Server className="size-3.5" aria-hidden="true" />
              Workstation
            </div>
            <h3 className="mt-2 text-base font-semibold">Lab workstation</h3>
            <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
              Host-owned context only. Execution controls stay inside the opened notebook.
            </p>
          </section>
          <section className="rounded-lg border border-fd-border p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-normal text-fd-muted-foreground">
              <Share2 className="size-3.5" aria-hidden="true" />
              Sharing
            </div>
            <dl className="mt-3 grid gap-2 text-sm">
              <FactRow label="Published" value={String(dashboardFacts.published)} />
              <FactRow label="Untitled" value={String(dashboardFacts.untitled)} />
              <FactRow label="Owned" value={String(dashboardFacts.owned)} />
            </dl>
          </section>
        </aside>
      </main>
    </div>
  );
}

function RankedPatternPanel({
  title,
  patterns,
}: {
  title: string;
  patterns: readonly RankedPattern[];
}) {
  return (
    <section className="rounded-lg border border-fd-border bg-fd-background p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-4 grid gap-3">
        {patterns.map((pattern) => {
          const Icon = pattern.icon;
          return (
            <article
              key={pattern.id}
              className="grid grid-cols-[2rem_auto_minmax(0,1fr)] items-start gap-3 border-t border-fd-border pt-3"
            >
              <span className="inline-flex size-8 items-center justify-center rounded-md border border-fd-border text-xs font-semibold text-fd-muted-foreground">
                {pattern.rank}
              </span>
              <Icon className="mt-1 size-4 text-fd-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h4 className="m-0 text-sm font-semibold">{pattern.title}</h4>
                  <span className="text-xs font-medium text-fd-muted-foreground">
                    {pattern.verdict}
                  </span>
                </div>
                <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">{pattern.note}</p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function IconButton({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <button
      type="button"
      className="inline-flex size-9 items-center justify-center rounded-md border border-fd-border bg-fd-background text-fd-foreground hover:bg-fd-muted/50"
      aria-label={label}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

function FilterChip({
  label,
  value,
  active = false,
}: {
  label: string;
  value: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      data-active={active}
      className={cn(
        "grid gap-1 border-t border-fd-border pt-3 text-left",
        active && "border-fd-foreground",
      )}
    >
      <span className="text-xs font-medium uppercase tracking-normal text-fd-muted-foreground">
        {label}
      </span>
      <strong className="text-xl font-semibold leading-none tracking-normal">{value}</strong>
    </button>
  );
}

function PinnedNotebook({ notebook }: { notebook: DashboardNotebook }) {
  return (
    <a
      href="#cloud-dashboard-recent"
      className="grid min-h-28 content-between rounded-md border border-fd-border p-3 text-fd-foreground no-underline hover:bg-fd-muted/40"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{displayTitle(notebook)}</span>
        <span className="mt-1 line-clamp-2 text-xs leading-5 text-fd-muted-foreground">
          {notebook.summary}
        </span>
      </span>
      <span className="mt-3 flex items-center justify-between gap-2 text-xs text-fd-muted-foreground">
        <span>{notebook.updatedAt}</span>
        <ShareState notebook={notebook} />
      </span>
    </a>
  );
}

function NotebookDashboardRow({ notebook }: { notebook: DashboardNotebook }) {
  return (
    <li>
      <a
        href="#cloud-dashboard-recent"
        className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3 text-fd-foreground no-underline hover:bg-fd-muted/40"
      >
        <BookOpen className="ml-2 size-4 text-fd-muted-foreground" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{displayTitle(notebook)}</span>
          <span className="mt-1 block truncate text-xs text-fd-muted-foreground">
            {notebook.project} · {notebook.updatedAt}
          </span>
        </span>
        <span className="mr-2 flex items-center gap-3">
          <ShareState notebook={notebook} />
          <ArrowUpRight className="size-4 text-fd-muted-foreground" aria-hidden="true" />
        </span>
      </a>
    </li>
  );
}

function ShareState({ notebook }: { notebook: DashboardNotebook }) {
  const publicState = notebook.share === "published";
  const sharedState = notebook.share === "shared";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium text-fd-muted-foreground",
        publicState && "text-emerald-700 dark:text-emerald-300",
        sharedState && "text-sky-700 dark:text-sky-300",
      )}
    >
      {publicState ? (
        <Globe2 className="size-3.5" aria-hidden="true" />
      ) : (
        <Share2 className="size-3.5" aria-hidden="true" />
      )}
      {notebook.share}
    </span>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-fd-muted-foreground">{label}</dt>
      <dd className="m-0 font-medium">{value}</dd>
    </div>
  );
}

function displayTitle(notebook: DashboardNotebook): string {
  return notebook.title?.trim() || "Untitled notebook";
}
