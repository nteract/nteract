import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Boxes,
  Cloud,
  FileCode2,
  Frame,
  IdCard,
  LayoutDashboard,
  ListPlus,
  MessageSquareText,
  MousePointer2,
  PackageCheck,
  Palette,
  PanelLeft,
  PanelTop,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  SquareCode,
  TextCursorInput,
  ToggleLeft,
  Workflow,
  type LucideIcon,
} from "lucide-react";

interface CatalogEntry {
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
}

interface CatalogGroup {
  title: string;
  entries: readonly CatalogEntry[];
}

const catalogGroups = [
  {
    title: "Shell",
    entries: [
      {
        title: "Notebook shell capabilities",
        description: "Host capability facts for shared notebook chrome.",
        href: "/docs/notebook-shell-capabilities",
        icon: ToggleLeft,
      },
      {
        title: "Cloud notebook shell",
        description: "Presence, sync, workstations, sharing, mode, and auth.",
        href: "/docs/cloud-notebook-shell",
        icon: Cloud,
      },
      {
        title: "Full shell composition",
        description: "Full-space notebook workspace with rail, cells, comments, and compute.",
        href: "/full-shell-composition",
        icon: Frame,
      },
      {
        title: "Cloud dashboard",
        description: "Notebook home, continuation, workstation context, and sharing previews.",
        href: "/docs/cloud-dashboard",
        icon: LayoutDashboard,
      },
      {
        title: "Compute placement",
        description: "Rail, environment, and connect-flow options for workstations.",
        href: "/docs/compute-placement",
        icon: Workflow,
      },
      {
        title: "Workstation management",
        description: "Full-page paired-machine list, detail, pairing, and unpair flows.",
        href: "/docs/workstation-management",
        icon: Server,
      },
      {
        title: "Context controls",
        description: "Target-specific notebook actions for menus and toolbars.",
        href: "/docs/context-controls",
        icon: MousePointer2,
      },
      {
        title: "Comment surfaces",
        description: "Anchored discussion, attribution, and rendered markdown highlights.",
        href: "/docs/comment-surfaces",
        icon: MessageSquareText,
      },
      {
        title: "Notebook toolbar",
        description: "Runtime and command toolbar state across hosts.",
        href: "/docs/notebook-toolbar-surfaces",
        icon: PanelTop,
      },
      {
        title: "Notebook outline",
        description: "Rail-first navigation for long notebooks.",
        href: "/docs/notebook-outline",
        icon: PanelLeft,
      },
      {
        title: "Identity and environment",
        description: "Actors, access state, runtime, and package context.",
        href: "/docs/identity-environment-surfaces",
        icon: IdCard,
      },
    ],
  },
  {
    title: "Cells",
    entries: [
      {
        title: "Cell anatomy",
        description: "Inventory map for current nteract cells.",
        href: "/docs/cell-anatomy",
        icon: FileCode2,
      },
      {
        title: "Cell execution language",
        description: "Execution language and cell source states.",
        href: "/docs/cell-execution-language",
        icon: SquareCode,
      },
      {
        title: "Cell insertion affordances",
        description: "Insertion ribbons and add-cell controls.",
        href: "/docs/cell-insertion-affordances",
        icon: ListPlus,
      },
      {
        title: "Editor surfaces",
        description: "CodeMirror fixtures for notebook source editing.",
        href: "/docs/editor-surfaces",
        icon: TextCursorInput,
      },
      {
        title: "Search surfaces",
        description: "Find and history search over fixture notebook state.",
        href: "/docs/search-surfaces",
        icon: Search,
      },
    ],
  },
  {
    title: "Runtime",
    entries: [
      {
        title: "Runtime surfaces",
        description: "Trust and environment decisions with fixture state.",
        href: "/docs/runtime-surfaces",
        icon: ShieldCheck,
      },
      {
        title: "Package managers",
        description: "Dependency headers and package-state controls.",
        href: "/docs/package-manager-surfaces",
        icon: PackageCheck,
      },
      {
        title: "Read-only notebooks",
        description: "Hosted notebook cells through shared components.",
        href: "/docs/read-only-notebook-surfaces",
        icon: BookOpen,
      },
    ],
  },
  {
    title: "Rendering",
    entries: [
      {
        title: "Output renderers",
        description: "Runtime-free fixtures for output components.",
        href: "/docs/output-renderers",
        icon: Boxes,
      },
      {
        title: "Output isolation",
        description: "Frame policy, host context, and MCP output mapping.",
        href: "/docs/isolated-output-surfaces",
        icon: Frame,
      },
      {
        title: "Widget surfaces",
        description: "Fixture-backed ipywidget controls and adapter notes.",
        href: "/docs/widget-surfaces",
        icon: SlidersHorizontal,
      },
      {
        title: "Theme surfaces",
        description: "Classic and cream palettes under shared tokens.",
        href: "/docs/theme-surfaces",
        icon: Palette,
      },
    ],
  },
] satisfies readonly CatalogGroup[];

const catalogCount = catalogGroups.reduce((count, group) => count + group.entries.length, 0);

export default function Home() {
  return (
    <main className="min-h-dvh bg-fd-background text-fd-foreground">
      <div className="mx-auto max-w-6xl px-6 py-8 lg:py-10">
        <header className="flex flex-col gap-5 border-b border-fd-border pb-6 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-normal text-fd-muted-foreground">
              nteract/nteract
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-normal text-fd-foreground">
              Elements
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-fd-muted-foreground">
              {catalogCount} production-backed notebook surfaces for shell, cells, runtime, and
              rendering work.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link
              href="/docs"
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-fd-primary px-3 text-sm font-medium text-fd-primary-foreground"
            >
              Docs
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
            <Link
              href="https://github.com/nteract/nteract"
              className="inline-flex h-9 items-center rounded-md border border-fd-border px-3 text-sm font-medium text-fd-foreground transition-colors hover:bg-fd-muted/40"
            >
              GitHub
            </Link>
          </div>
        </header>

        <section className="grid gap-x-8 gap-y-7 py-7 lg:grid-cols-2">
          {catalogGroups.map((group) => (
            <section key={group.title} aria-labelledby={`${group.title.toLowerCase()}-group`}>
              <h2
                id={`${group.title.toLowerCase()}-group`}
                className="text-xs font-semibold uppercase tracking-normal text-fd-muted-foreground"
              >
                {group.title}
              </h2>
              <div className="mt-3 grid gap-2">
                {group.entries.map((entry) => (
                  <CatalogLink key={entry.href} entry={entry} />
                ))}
              </div>
            </section>
          ))}
        </section>
      </div>
    </main>
  );
}

function CatalogLink({ entry }: { entry: CatalogEntry }) {
  const Icon = entry.icon;
  return (
    <Link
      href={entry.href}
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-fd-border bg-fd-background px-3 py-2.5 transition-colors hover:bg-fd-muted/40"
    >
      <Icon className="size-4 text-fd-muted-foreground" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{entry.title}</span>
        <span className="mt-0.5 block truncate text-xs text-fd-muted-foreground">
          {entry.description}
        </span>
      </span>
      <ArrowRight className="size-3.5 text-fd-muted-foreground" aria-hidden="true" />
    </Link>
  );
}
