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
  PackageCheck,
  Palette,
  PanelLeft,
  PanelTop,
  Search,
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
    title: "Workspace",
    entries: [
      {
        title: "Cloud dashboard",
        description: "Notebook home, recent work, workstation state, and sharing.",
        href: "/docs/cloud-dashboard",
        icon: LayoutDashboard,
      },
      {
        title: "Compute placement",
        description: "Workstation selection and environment context.",
        href: "/docs/compute-placement",
        icon: Workflow,
      },
      {
        title: "Identity and environment",
        description: "User context, access state, and runtime connection.",
        href: "/docs/identity-environment-surfaces",
        icon: IdCard,
      },
      {
        title: "Cloud notebook shell",
        description: "Presence, sync state, collaboration, and sharing controls.",
        href: "/docs/cloud-notebook-shell",
        icon: Cloud,
      },
    ],
  },
  {
    title: "Notebook",
    entries: [
      {
        title: "Notebook toolbar",
        description: "Execution controls, kernel state, and runtime commands.",
        href: "/docs/notebook-toolbar-surfaces",
        icon: PanelTop,
      },
      {
        title: "Notebook outline",
        description: "Navigation and document structure for long notebooks.",
        href: "/docs/notebook-outline",
        icon: PanelLeft,
      },
      {
        title: "Cell execution language",
        description: "Execution state, queued runs, and cell status.",
        href: "/docs/cell-execution-language",
        icon: SquareCode,
      },
      {
        title: "Cell insertion affordances",
        description: "Add code, markdown, and data cells.",
        href: "/docs/cell-insertion-affordances",
        icon: ListPlus,
      },
      {
        title: "Search surfaces",
        description: "Find in notebook and execution history.",
        href: "/docs/search-surfaces",
        icon: Search,
      },
      {
        title: "Editor surfaces",
        description: "Code editing with syntax highlighting and completion.",
        href: "/docs/editor-surfaces",
        icon: TextCursorInput,
      },
    ],
  },
  {
    title: "Execution & Output",
    entries: [
      {
        title: "Output renderers",
        description: "Rich outputs: tables, charts, dataframes, and artifacts.",
        href: "/docs/output-renderers",
        icon: Boxes,
      },
      {
        title: "Widget surfaces",
        description: "Interactive controls and ipywidget components.",
        href: "/docs/widget-surfaces",
        icon: SlidersHorizontal,
      },
      {
        title: "Output isolation",
        description: "Secure rendering and sandboxed output frames.",
        href: "/docs/isolated-output-surfaces",
        icon: Frame,
      },
      {
        title: "Runtime surfaces",
        description: "Environment trust, kernel state, and execution context.",
        href: "/docs/runtime-surfaces",
        icon: ShieldCheck,
      },
      {
        title: "Package managers",
        description: "Dependency management and package installation state.",
        href: "/docs/package-manager-surfaces",
        icon: PackageCheck,
      },
    ],
  },
  {
    title: "Components",
    entries: [
      {
        title: "Cell anatomy",
        description: "Cell structure and component inventory.",
        href: "/docs/cell-anatomy",
        icon: FileCode2,
      },
      {
        title: "Read-only notebooks",
        description: "Published notebook views without execution.",
        href: "/docs/read-only-notebook-surfaces",
        icon: BookOpen,
      },
      {
        title: "Theme surfaces",
        description: "Color palettes and visual styling.",
        href: "/docs/theme-surfaces",
        icon: Palette,
      },
      {
        title: "Notebook shell capabilities",
        description: "Host capabilities and feature detection.",
        href: "/docs/notebook-shell-capabilities",
        icon: ToggleLeft,
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
              {catalogCount} notebook workspace surfaces for workspace, execution, and data
              workflows.
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

        <section className="grid gap-x-8 gap-y-8 py-8 lg:grid-cols-2">
          {catalogGroups.map((group) => (
            <section key={group.title} aria-labelledby={`${group.title.toLowerCase()}-group`}>
              <h2
                id={`${group.title.toLowerCase()}-group`}
                className="border-b border-fd-border pb-2 text-sm font-semibold text-fd-foreground"
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
      className="group grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-fd-border bg-fd-background px-3.5 py-2.5 transition-colors hover:border-fd-foreground/20 hover:bg-fd-muted/30"
    >
      <Icon className="size-4 text-fd-muted-foreground transition-colors group-hover:text-fd-foreground" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{entry.title}</span>
        <span className="mt-0.5 block truncate text-xs leading-5 text-fd-muted-foreground">
          {entry.description}
        </span>
      </span>
      <ArrowRight className="size-3.5 text-fd-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
    </Link>
  );
}
