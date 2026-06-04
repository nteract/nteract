import { Fragment } from "react";
import type {
  MarkdownProjectionBlock,
  MarkdownProjectionPlan,
  MarkdownProjectionRun,
} from "~/lib/markdown-projection";
import { cn } from "@/lib/utils";
import type { MarkdownHeadingAnchor } from "@/components/outputs/markdown-heading-anchors";

interface ProjectedMarkdownViewProps {
  plan: MarkdownProjectionPlan;
  className?: string;
  headingAnchors?: readonly MarkdownHeadingAnchor[];
  onLinkClick?: (url: string) => void;
}

export function ProjectedMarkdownView({
  plan,
  className,
  headingAnchors = [],
  onLinkClick,
}: ProjectedMarkdownViewProps) {
  const runsByBlock = new Map<string, MarkdownProjectionRun[]>();
  for (const run of plan.runs) {
    const runs = runsByBlock.get(run.blockId);
    if (runs) {
      runs.push(run);
    } else {
      runsByBlock.set(run.blockId, [run]);
    }
  }

  return (
    <div
      data-slot="projected-markdown-output"
      className={cn(
        "select-text py-1 text-base leading-[1.65] font-serif text-foreground",
        className,
      )}
    >
      {plan.blocks.map((block) => (
        <ProjectedMarkdownBlock
          key={block.blockId}
          block={block}
          headingAnchor={headingAnchorForBlock(block, headingAnchors)}
          runs={runsByBlock.get(block.blockId) ?? []}
          onLinkClick={onLinkClick}
        />
      ))}
    </div>
  );
}

interface ProjectedMarkdownBlockProps {
  block: MarkdownProjectionBlock;
  headingAnchor?: MarkdownHeadingAnchor;
  runs: MarkdownProjectionRun[];
  onLinkClick?: (url: string) => void;
}

function ProjectedMarkdownBlock({
  block,
  headingAnchor,
  runs,
  onLinkClick,
}: ProjectedMarkdownBlockProps) {
  if (block.kind === "heading") {
    const Heading = headingTag(block.element);
    return (
      <Heading
        id={headingAnchor?.headingAnchorId}
        data-nteract-heading-anchor={headingAnchor?.headingAnchorId}
        data-nteract-outline-item-id={headingAnchor?.itemId}
        className={headingClass(block.element)}
      >
        {renderRuns(runs, onLinkClick)}
      </Heading>
    );
  }

  if (block.kind === "list") {
    const items = groupListRuns(runs);
    return (
      <ul className="my-3 list-disc pl-6">
        {items.map(({ key, runs }) => (
          <li key={key} className="my-1">
            {renderRuns(runs, onLinkClick)}
          </li>
        ))}
      </ul>
    );
  }

  if (block.kind === "code") {
    return (
      <pre className="my-2 overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-sm leading-relaxed whitespace-pre-wrap">
        <code>{block.text}</code>
      </pre>
    );
  }

  if (block.kind === "math") {
    return (
      <pre className="my-2 overflow-x-auto rounded border border-border/60 px-3 py-2 font-mono text-sm leading-relaxed whitespace-pre-wrap">
        <code>{block.text}</code>
      </pre>
    );
  }

  if (block.kind === "table") {
    return (
      <pre className="my-2 overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-sm leading-relaxed whitespace-pre-wrap">
        {block.text}
      </pre>
    );
  }

  if (block.kind === "paragraph") {
    return <p className="my-3">{renderRuns(runs, onLinkClick)}</p>;
  }

  return block.text ? <div className="my-3">{renderRuns(runs, onLinkClick)}</div> : null;
}

function headingAnchorForBlock(
  block: MarkdownProjectionBlock,
  headingAnchors: readonly MarkdownHeadingAnchor[],
): MarkdownHeadingAnchor | undefined {
  if (block.kind !== "heading") return undefined;

  return headingAnchors.find((anchor) => {
    if (block.anchorSlug && anchor.anchor === block.anchorSlug) return true;
    return anchor.title === block.text && `h${anchor.level}` === block.element;
  });
}

function headingTag(element: string): "h1" | "h2" | "h3" {
  if (element === "h1") return "h1";
  if (element === "h2") return "h2";
  return "h3";
}

function headingClass(element: string) {
  if (element === "h1") return "mt-6 mb-4 text-3xl leading-tight font-bold";
  if (element === "h2") return "mt-5 mb-3 text-2xl leading-tight font-bold";
  return "mt-4 mb-2 text-xl leading-tight font-bold";
}

function groupListRuns(runs: MarkdownProjectionRun[]) {
  const groups = new Map<number, MarkdownProjectionRun[]>();
  for (const run of runs) {
    const itemIndex = run.listItemIndex ?? 0;
    const group = groups.get(itemIndex);
    if (group) {
      group.push(run);
    } else {
      groups.set(itemIndex, [run]);
    }
  }

  return Array.from(groups, ([key, runs]) => ({ key, runs }));
}

function renderRuns(runs: MarkdownProjectionRun[], onLinkClick?: (url: string) => void) {
  if (runs.length === 0) return null;

  return runs.map((run) => <Fragment key={run.inlineId}>{renderRun(run, onLinkClick)}</Fragment>);
}

function renderRun(run: MarkdownProjectionRun, onLinkClick?: (url: string) => void) {
  const text = run.renderedText;
  if (!text) return null;

  if (run.href) {
    return (
      <a
        href={run.href}
        title={run.title}
        className="text-primary underline-offset-2 hover:underline"
        onClick={(event) => {
          event.preventDefault();
          onLinkClick?.(run.href ?? "");
        }}
      >
        {text}
      </a>
    );
  }

  if (run.semantic === "strong") return <strong>{text}</strong>;
  if (run.semantic === "inline-code") {
    return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">{text}</code>;
  }
  if (run.semantic === "code-block" || run.semantic === "math-source") return text;
  if (run.semantic === "link-label") return text;

  return text;
}
