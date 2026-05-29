import Link from "next/link";
import { ArrowRight, Boxes, FileCode2, ListChecks, PanelLeft } from "lucide-react";
import { RailOutlineExample } from "@/components/rail-outline-example";

const entries = [
  {
    title: "Notebook outline",
    description: "A rail-first reading surface for long notebooks.",
    href: "/docs/notebook-outline",
    icon: PanelLeft,
  },
  {
    title: "Component burn-down",
    description: "Track notebook-specific components we should own.",
    href: "/docs/component-burndown",
    icon: ListChecks,
  },
  {
    title: "Cell anatomy",
    description: "Inventory map for current nteract cells.",
    href: "/docs/cell-anatomy",
    icon: FileCode2,
  },
  {
    title: "Rendering catalog",
    description: "Future home for markdown, output, and widget examples.",
    href: "/docs",
    icon: Boxes,
  },
];

export default function Home() {
  return (
    <main className="min-h-dvh bg-fd-background text-fd-foreground">
      <section className="mx-auto grid max-w-6xl gap-10 px-6 py-12 lg:grid-cols-[0.9fr_1.1fr] lg:py-16">
        <div className="flex flex-col justify-center">
          <p className="text-sm font-medium text-fd-muted-foreground">nteract/nteract</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-normal text-fd-foreground sm:text-5xl">
            Elements
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-fd-muted-foreground">
            A small in-repo catalog for notebook UI and rendering work. This is the path forward for
            examples that used to live around nteract/elements.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              href="/docs"
              className="inline-flex h-10 items-center gap-2 rounded-md bg-fd-primary px-4 text-sm font-medium text-fd-primary-foreground"
            >
              Open catalog
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link
              href="https://github.com/nteract/nteract"
              className="inline-flex h-10 items-center rounded-md border border-fd-border px-4 text-sm font-medium text-fd-foreground"
            >
              GitHub
            </Link>
          </div>
        </div>
        <RailOutlineExample />
      </section>

      <section className="border-t border-fd-border bg-fd-muted/20">
        <div className="mx-auto grid max-w-6xl gap-4 px-6 py-8 md:grid-cols-2 lg:grid-cols-4">
          {entries.map((entry) => (
            <Link
              key={entry.title}
              href={entry.href}
              className="rounded-lg border border-fd-border bg-fd-background p-4 transition-colors hover:bg-fd-muted/40"
            >
              <entry.icon className="mb-4 size-5 text-fd-muted-foreground" />
              <h2 className="text-sm font-semibold">{entry.title}</h2>
              <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{entry.description}</p>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
