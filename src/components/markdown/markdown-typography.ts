import type { CSSProperties } from "react";

export const markdownDocumentClassName =
  "not-prose select-text py-2 text-base leading-[1.68] text-foreground font-[var(--output-document-font)] [font-kerning:normal] [hyphens:auto] [text-rendering:optimizeLegibility] selection:bg-primary/15 selection:text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_abbr]:cursor-help [&_abbr]:decoration-dotted [&_abbr]:underline-offset-4 [&_figcaption]:mt-2 [&_figcaption]:font-[var(--output-ui-font)] [&_figcaption]:text-xs [&_figcaption]:leading-5 [&_figcaption]:text-muted-foreground [&_kbd]:rounded-sm [&_kbd]:border [&_kbd]:border-border [&_kbd]:bg-muted/60 [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:font-[var(--output-ui-font)] [&_kbd]:text-[0.82em] [&_.katex-display]:my-5 [&_.katex-display]:overflow-x-clip [&_.katex-display]:text-center [&_mark]:rounded-sm [&_mark]:bg-amber-200/70 [&_mark]:px-1 dark:[&_mark]:bg-amber-500/25 [&_small]:font-[var(--output-ui-font)] [&_small]:text-[0.82em] [&_small]:leading-normal [&_sub]:text-[0.75em] [&_sup]:text-[0.75em]";

export const markdownLinkClassName =
  "rounded-[2px] font-medium text-primary underline decoration-primary/45 decoration-1 underline-offset-4 transition-[background-color,color,text-decoration-color] hover:bg-primary/5 hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

export const markdownInlineCodeClassName =
  "rounded-sm border border-border/70 bg-muted/70 px-1.5 py-0.5 font-mono text-[0.88em] text-foreground break-words";

export const markdownCodeBlockShellClassName =
  "group/codeblock my-4 overflow-hidden border-l-2 border-border bg-muted/[0.14]";

export const markdownCodeBlockToolbarClassName =
  "flex min-h-7 items-center justify-between gap-3 px-3 pt-1.5 pb-0.5 font-[var(--output-ui-font)] text-[11px] leading-none text-muted-foreground";

export const markdownCodeBlockLabelClassName = "truncate font-medium text-muted-foreground/80";

export const markdownCodeBlockCopyButtonClassName =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-transparent bg-transparent text-muted-foreground transition-colors hover:border-border/70 hover:bg-background/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

export const markdownCodeBlockPreStyle = {
  borderRadius: 0,
  padding: "0.5rem 1rem 0.875rem",
} satisfies CSSProperties;

export const markdownParagraphClassName = "my-3 leading-relaxed [text-wrap:pretty]";

export const markdownDisplayMathClassName =
  "my-5 overflow-x-clip text-center [&_.katex-display]:my-0";

export const markdownInlineMathClassName =
  "inline align-baseline text-foreground [&_.katex]:text-[1.03em]";

export const markdownStrongClassName = "font-semibold text-foreground";

export const markdownEmphasisClassName = "italic text-foreground";

export const markdownDeleteClassName =
  "text-muted-foreground decoration-destructive/55 decoration-2";

export const markdownBlockquoteClassName =
  "relative my-5 border-l-[3px] border-primary/35 py-1.5 pr-2 pl-5 text-[1.02em] leading-[1.75] text-foreground/90 italic [&_strong]:text-foreground";

export const markdownDetailsClassName =
  "group/details my-5 overflow-hidden rounded-md border border-border/75 bg-muted/[0.14] shadow-sm open:bg-muted/[0.18] [&>:not(summary)]:mx-4 [&>:not(summary)]:my-3 [&>:last-child]:mb-4 [&>summary+*]:mt-3";

export const markdownSummaryClassName =
  "flex cursor-pointer list-none items-center gap-2 border-b border-transparent px-4 py-3 font-[var(--output-ui-font)] text-sm leading-5 font-semibold text-foreground transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 group-open/details:border-border/65 [&::-webkit-details-marker]:hidden";

export const markdownSummaryIndicatorClassName =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/6 font-[var(--output-ui-font)] text-[12px] leading-none text-primary transition-transform group-open/details:rotate-90";

export const markdownDetailsBodyClassName =
  "px-4 pt-1 pb-4 text-[0.96em] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0";

export const markdownListMarkerClassName = "marker:text-primary/65 marker:font-semibold";

export const markdownTaskListClassName =
  "my-4 ml-0 list-none space-y-1 rounded-md border border-border/70 bg-muted/[0.12] p-2";

export const markdownTaskListItemClassName =
  "group/task grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-sm px-2 py-1.5 transition-colors hover:bg-muted/35";

export const markdownTaskCheckboxClassName =
  "relative mt-[0.18em] inline-grid size-5 shrink-0 place-items-center";

export const markdownTaskCheckboxGlyphClassName =
  "pointer-events-none grid size-4 place-items-center rounded-sm border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40 peer-focus-visible:ring-offset-1 peer-disabled:opacity-100";

export const markdownTaskContentClassName = "min-w-0 leading-relaxed";

export const markdownThematicBreakClassName = "my-7 border-0 border-t border-border/70";

export const markdownTableWrapperClassName =
  "my-5 overflow-x-auto border-y border-border/80 bg-background";

export const markdownTableClassName =
  "min-w-full border-collapse font-[var(--output-ui-font)] text-sm leading-normal";

export const markdownTableHeadClassName = "bg-muted/65";

export const markdownTableRowClassName = "odd:bg-muted/[0.05] hover:bg-muted/[0.09]";

export const markdownTableHeaderCellClassName =
  "border-b border-r border-border/80 px-3 py-2.5 text-left font-semibold text-foreground last:border-r-0";

export const markdownTableCellClassName =
  "border-r border-t border-border/70 px-3 py-2.5 align-top text-muted-foreground first:text-foreground last:border-r-0";

export const markdownImageClassName =
  "my-5 h-auto max-w-full rounded-sm border border-border/80 bg-muted/15 shadow-sm";

export const markdownFigureClassName = "my-5";

export const markdownFigureCaptionClassName =
  "mt-2 font-[var(--output-ui-font)] text-xs leading-5 text-muted-foreground";

export const markdownFootnotesClassName =
  "mt-8 border-t border-border/70 pt-4 font-[var(--output-ui-font)] text-sm leading-6 text-muted-foreground";

export const markdownFootnoteBackrefClassName =
  "ml-1 font-[var(--output-ui-font)] text-xs no-underline hover:bg-transparent";

export const markdownFootnoteRefClassName =
  "mx-0.5 inline-flex min-w-4 translate-y-[-0.22em] justify-center rounded-full border border-primary/20 bg-primary/6 px-1 font-[var(--output-ui-font)] text-[0.68em] leading-4 text-primary no-underline decoration-transparent hover:bg-primary/10 hover:decoration-transparent";

export const markdownHeadingAnchorClassName =
  "ml-2 inline-flex translate-y-[-0.08em] rounded-[2px] font-[var(--output-ui-font)] text-[0.58em] font-medium text-muted-foreground/40 no-underline decoration-transparent transition-colors hover:bg-primary/5 hover:text-primary focus-visible:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

export function markdownHeadingClassName(element: string) {
  if (element === "h1") {
    return "group/markdown-heading scroll-mt-16 mt-7 mb-4 text-[2rem] leading-[1.08] font-semibold [text-wrap:balance]";
  }
  if (element === "h2") {
    return "group/markdown-heading scroll-mt-16 mt-7 mb-3 text-2xl leading-tight font-semibold [text-wrap:balance]";
  }
  if (element === "h3") {
    return "group/markdown-heading scroll-mt-16 mt-6 mb-2.5 text-xl leading-tight font-semibold [text-wrap:balance]";
  }
  if (element === "h4") {
    return "group/markdown-heading scroll-mt-16 mt-4 mb-2 text-lg leading-tight font-semibold";
  }
  if (element === "h5") {
    return "group/markdown-heading scroll-mt-16 mt-3.5 mb-1.5 text-base leading-tight font-semibold";
  }
  return "group/markdown-heading scroll-mt-16 mt-3 mb-1.5 text-sm leading-tight font-semibold text-muted-foreground";
}
