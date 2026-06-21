"use client";

import {
  ArrowUpRight,
  BookOpen,
  Clock3,
  Command,
  FilePlus2,
  Globe2,
  Pin,
  RefreshCw,
  Search,
  Server,
  Share2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/surface-primitives";

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

const dashboardFacts = {
  visible: 100,
  owned: 88,
  untitled: 25,
  published: 8,
};

export function CloudDashboardExample() {
  return (
    <div className="not-prose" data-elements-slot="cloud-dashboard">
      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-background">
        <DashboardReviewFrame />
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
          <Eyebrow className="flex items-center gap-2">
            <Command className="size-3.5" aria-hidden="true" />
            Notebook home
          </Eyebrow>
          <h2 className="mt-2 text-2xl font-semibold tracking-normal md:text-3xl">
            Find a notebook
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-fd-muted-foreground">
            Search is the first affordance. Pins, recent groups, and title-cleanup filters keep
            high-signal rooms ahead of smoke-test clutter.
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
            <FilterChip label="Needs title" value={String(dashboardFacts.untitled)} />
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
            <Eyebrow className="flex items-center gap-2">
              <Server className="size-3.5" aria-hidden="true" />
              Workstation context
            </Eyebrow>
            <h3 className="mt-2 text-base font-semibold">Default workstation</h3>
            <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
              Host-owned readiness only. Run, restart, and interrupt controls stay inside the opened
              notebook.
            </p>
          </section>
          <section className="rounded-lg border border-fd-border p-4">
            <Eyebrow className="flex items-center gap-2">
              <Share2 className="size-3.5" aria-hidden="true" />
              Sharing metadata
            </Eyebrow>
            <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
              Safe counts for inventory scan. Preview content comes only from explicit published
              revisions.
            </p>
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
      <Eyebrow>{label}</Eyebrow>
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
