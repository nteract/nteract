"use client";

import {
  BookOpen,
  Copy,
  FileQuestion,
  Link2,
  Maximize2,
  PackageCheck,
  Pencil,
  Play,
  Plus,
  SearchCode,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { CommentMarkIcon } from "@/components/comments/CommentMarkIcon";
import { CodeMirrorEditor } from "@/components/editor/codemirror-editor";
import {
  NotebookCommandToolbar,
  NotebookContextMenu,
  type NotebookContextMenuGroup,
  type NotebookContextSurface,
} from "@/components/notebook";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/surface-primitives";
import { getElementsNotebookScenario } from "@/components/notebook-scenarios";

type ContextTargetKind = "source" | "markdown" | "output" | "package";

interface ContextTargetFixture {
  id: string;
  kind: ContextTargetKind;
  title: string;
  body: string;
  detail: string;
  code?: string;
}

const contextTargets = [
  {
    id: "source-derivative",
    kind: "source",
    title: "Selected source range",
    body: "derivative = sp.diff(f, x)",
    detail: "Cell 4 · line 12",
    code: [
      "x = sp.symbols('x')",
      "f = sp.sin(x) ** 2",
      "derivative = sp.diff(f, x)",
      "sp.simplify(derivative)",
    ].join("\n"),
  },
  {
    id: "markdown-heading",
    kind: "markdown",
    title: "Section heading",
    body: "Forecast review",
    detail: "Notebook outline · section 2",
    code: [
      "## Forecast review",
      "",
      "Compare the model output against recent station observations before publishing.",
    ].join("\n"),
  },
  {
    id: "output-chart",
    kind: "output",
    title: "Rendered chart output",
    body: "Plotly trend chart with one warning attached to the output frame.",
    detail: "Output 2 · text/html",
  },
  {
    id: "package-sympy",
    kind: "package",
    title: "sympy >= 1.13",
    body: "Dependency declared by the notebook environment summary.",
    detail: "pyproject.toml · runtime restart required",
  },
] satisfies readonly ContextTargetFixture[];

function icon(node: ReactNode) {
  return node;
}

function surfaceForTarget(target: ContextTargetFixture): NotebookContextSurface {
  return {
    kind: target.kind,
    title: target.title,
    description: target.body,
    detail: target.detail,
  };
}

function groupsForTarget(
  target: ContextTargetFixture,
  onAction: (target: ContextTargetFixture, action: string) => void,
): NotebookContextMenuGroup[] {
  const select = (label: string) => () => onAction(target, label);

  if (target.kind === "source") {
    return [
      {
        id: "comment",
        actions: [
          {
            id: "comment-selection",
            label: "Add comment",
            description: "Anchor a discussion to this source range.",
            icon: icon(<CommentMarkIcon />),
            shortcut: "C",
            onSelect: select("Add comment"),
          },
          {
            id: "explain-selection",
            label: "Ask agent about selection",
            description: "Send the selected code and cell context.",
            icon: icon(<Sparkles />),
            onSelect: select("Ask agent about selection"),
          },
        ],
      },
      {
        id: "cell",
        label: "Cell",
        actions: [
          {
            id: "run-cell",
            label: "Run cell",
            icon: icon(<Play />),
            shortcut: "Shift Enter",
            onSelect: select("Run cell"),
          },
          {
            id: "insert-code",
            label: "Insert code cell below",
            icon: icon(<Plus />),
            onSelect: select("Insert code cell below"),
          },
        ],
      },
      {
        id: "inspect",
        label: "Inspect",
        actions: [
          {
            id: "copy-link",
            label: "Copy cell link",
            icon: icon(<Link2 />),
            onSelect: select("Copy cell link"),
          },
          {
            id: "source-docs",
            label: "Open source editing docs",
            icon: icon(<BookOpen />),
            onSelect: select("Open source editing docs"),
          },
        ],
      },
    ];
  }

  if (target.kind === "markdown") {
    return [
      {
        id: "comment",
        actions: [
          {
            id: "comment-heading",
            label: "Add comment",
            description: "Anchor feedback to the rendered heading.",
            icon: icon(<CommentMarkIcon />),
            shortcut: "C",
            onSelect: select("Add comment"),
          },
          {
            id: "copy-heading",
            label: "Copy heading link",
            icon: icon(<Link2 />),
            onSelect: select("Copy heading link"),
          },
        ],
      },
      {
        id: "edit",
        label: "Edit",
        actions: [
          {
            id: "edit-heading",
            label: "Edit markdown source",
            icon: icon(<Pencil />),
            onSelect: select("Edit markdown source"),
          },
          {
            id: "insert-markdown",
            label: "Insert markdown below",
            icon: icon(<Plus />),
            onSelect: select("Insert markdown below"),
          },
        ],
      },
    ];
  }

  if (target.kind === "output") {
    return [
      {
        id: "comment",
        actions: [
          {
            id: "comment-output",
            label: "Add comment",
            description: "Attach discussion to the output frame.",
            icon: icon(<CommentMarkIcon />),
            shortcut: "C",
            onSelect: select("Add comment"),
          },
          {
            id: "expand-output",
            label: "Open output",
            icon: icon(<Maximize2 />),
            onSelect: select("Open output"),
          },
        ],
      },
      {
        id: "inspect",
        label: "Inspect",
        actions: [
          {
            id: "copy-output",
            label: "Copy output",
            icon: icon(<Copy />),
            onSelect: select("Copy output"),
          },
          {
            id: "renderer-docs",
            label: "Open renderer docs",
            icon: icon(<SearchCode />),
            onSelect: select("Open renderer docs"),
          },
        ],
      },
    ];
  }

  return [
    {
      id: "package",
      actions: [
        {
          id: "inspect-package",
          label: "Open package details",
          icon: icon(<PackageCheck />),
          onSelect: select("Open package details"),
        },
        {
          id: "comment-package",
          label: "Add comment",
          description: "Start a dependency-specific discussion.",
          icon: icon(<CommentMarkIcon />),
          onSelect: select("Add comment"),
        },
      ],
    },
    {
      id: "edit",
      label: "Edit",
      actions: [
        {
          id: "pin-package",
          label: "Pin version",
          icon: icon(<Pencil />),
          onSelect: select("Pin version"),
        },
        {
          id: "remove-package",
          label: "Remove dependency",
          icon: icon(<Trash2 />),
          destructive: true,
          onSelect: select("Remove dependency"),
        },
      ],
    },
  ];
}

export function ContextControlsExample() {
  const scenario = getElementsNotebookScenario("desktop-local-owner");
  const sourceTarget = contextTargets[0];
  const markdownTarget = contextTargets[1];
  const outputTarget = contextTargets[2];
  const packageTarget = contextTargets[3];
  const [activeTargetId, setActiveTargetId] = useState(contextTargets[0].id);
  const [lastAction, setLastAction] = useState("No context action selected");
  const [source, setSource] = useState(sourceTarget.code ?? "");
  const activeTarget = useMemo(
    () => contextTargets.find((target) => target.id === activeTargetId) ?? contextTargets[0],
    [activeTargetId],
  );

  const recordAction = (target: ContextTargetFixture, action: string) => {
    setActiveTargetId(target.id);
    setLastAction(`${action} · ${target.title}`);
  };

  return (
    <div className="not-prose space-y-6">
      <section className="border-l border-fd-border py-1 pl-4 text-fd-muted-foreground">
        <div className="flex items-start gap-3">
          <FileQuestion className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold text-fd-foreground">Context controls boundary</h2>
            <p className="mt-1 text-xs leading-5">
              The shared menu receives a surface descriptor and grouped actions. The docs page owns
              fixture actions only; notebook state, comments, runtime, package mutation, and docs
              routing stay with the host.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border">
          <NotebookCommandToolbar
            capabilities={scenario.capabilities}
            runtime="python"
            environmentManager="uv"
            runtimeStatus={{
              state: "idle",
              label: "Ready",
              ariaLabel: "Kernel ready",
              title: "Kernel ready",
            }}
            onAddCell={() => recordAction(activeTarget, "Add cell from toolbar")}
            onRunAllCells={() => recordAction(activeTarget, "Run all from toolbar")}
            onRestartRuntime={() => recordAction(activeTarget, "Restart from toolbar")}
            onTogglePackages={() => recordAction(activeTarget, "Open packages from toolbar")}
            utilityControls={
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => recordAction(activeTarget, "Add comment from toolbar")}
                >
                  <CommentMarkIcon className="size-3.5" aria-hidden="true" />
                  Comment
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => recordAction(activeTarget, "Open docs from toolbar")}
                >
                  <BookOpen className="size-3.5" aria-hidden="true" />
                  Docs
                </Button>
              </div>
            }
          />
        </div>

        <div className="bg-background">
          <div className="border-b border-fd-border px-4 py-3">
            <h2 className="text-sm font-semibold">Forecast Review.ipynb</h2>
            <div className="mt-1 text-xs text-fd-muted-foreground">
              Right-click source, markdown, output, or package context.
            </div>
          </div>

          <div className="divide-y divide-fd-border">
            <NotebookContextRegion
              active={activeTargetId === sourceTarget.id}
              target={sourceTarget}
              onAction={recordAction}
              onOpenChange={(open) => {
                if (open) setActiveTargetId(sourceTarget.id);
              }}
            >
              <div className="grid gap-3 p-4">
                <CellHeader label="Code" detail={sourceTarget.detail} />
                <div className="min-w-0 border-l-2 border-emerald-500 pl-3">
                  <CodeMirrorEditor
                    initialValue={source}
                    language="python"
                    lineWrapping
                    onValueChange={setSource}
                    className="min-h-28"
                  />
                </div>
              </div>
            </NotebookContextRegion>

            <NotebookContextRegion
              active={activeTargetId === markdownTarget.id}
              target={markdownTarget}
              onAction={recordAction}
              onOpenChange={(open) => {
                if (open) setActiveTargetId(markdownTarget.id);
              }}
            >
              <div className="grid gap-3 p-4">
                <CellHeader label="Markdown" detail={markdownTarget.detail} />
                <div className="border-l-2 border-sky-500 pl-3">
                  <h2 className="text-xl font-semibold tracking-normal text-fd-foreground">
                    Forecast review
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
                    Compare the model output against recent station observations before publishing.
                  </p>
                </div>
              </div>
            </NotebookContextRegion>

            <NotebookContextRegion
              active={activeTargetId === outputTarget.id}
              target={outputTarget}
              onAction={recordAction}
              onOpenChange={(open) => {
                if (open) setActiveTargetId(outputTarget.id);
              }}
            >
              <div className="grid gap-3 p-4">
                <CellHeader label="Output" detail={outputTarget.detail} />
                <div className="border-l-2 border-fd-border pl-3">
                  <div className="rounded-md border border-fd-border bg-fd-card p-3">
                    <div className="flex h-32 items-end gap-3">
                      {[42, 72, 58, 91, 65, 80].map((height, index) => (
                        <div
                          key={height}
                          className="flex h-full min-w-0 flex-1 items-end border-l border-fd-border/60 pl-1"
                        >
                          <div
                            className="w-full bg-emerald-500/70"
                            style={{ height: `${height}%` }}
                            aria-label={`Series ${index + 1}`}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 text-xs text-fd-muted-foreground">
                      Forecast score by observation window
                    </div>
                  </div>
                </div>
              </div>
            </NotebookContextRegion>

            <NotebookContextRegion
              active={activeTargetId === packageTarget.id}
              target={packageTarget}
              onAction={recordAction}
              onOpenChange={(open) => {
                if (open) setActiveTargetId(packageTarget.id);
              }}
            >
              <div className="grid gap-3 p-4">
                <CellHeader label="Environment" detail={packageTarget.detail} />
                <div className="border-l-2 border-fd-border pl-3">
                  <div className="grid gap-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="min-w-0">
                      <div className="font-mono text-sm text-fd-foreground">sympy &gt;= 1.13</div>
                      <div className="mt-1 text-xs leading-5 text-fd-muted-foreground">
                        Runtime package context follows the notebook rather than a separate package
                        manager page.
                      </div>
                    </div>
                    <div className="text-xs font-medium text-amber-700 dark:text-amber-300">
                      restart required
                    </div>
                  </div>
                </div>
              </div>
            </NotebookContextRegion>
          </div>

          <div className="border-t border-fd-border px-4 py-3 text-xs leading-5 text-fd-muted-foreground">
            <span className="font-medium text-fd-foreground">{activeTarget.title}</span>
            <span> · {activeTarget.detail}</span>
            <span className="block">{lastAction}</span>
          </div>
        </div>
      </section>
    </div>
  );
}

function CellHeader({ detail, label }: { detail: string; label: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <Eyebrow>{label}</Eyebrow>
      <div className="truncate text-xs text-fd-muted-foreground">{detail}</div>
    </div>
  );
}

function NotebookContextRegion({
  active,
  children,
  target,
  onAction,
  onOpenChange,
}: {
  active: boolean;
  children: ReactNode;
  target: ContextTargetFixture;
  onAction: (target: ContextTargetFixture, action: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <NotebookContextMenu
      surface={surfaceForTarget(target)}
      groups={groupsForTarget(target, onAction)}
      onOpenChange={onOpenChange}
    >
      <div
        className={cn(
          "min-w-0 transition-colors focus-within:bg-fd-muted/25 hover:bg-fd-muted/20",
          active && "bg-fd-muted/30",
        )}
        onClick={() => onAction(target, "Selected")}
      >
        {children}
      </div>
    </NotebookContextMenu>
  );
}
