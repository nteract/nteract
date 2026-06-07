export const markdownDocumentClassName =
  "not-prose select-text py-2 text-base leading-[1.68] text-foreground font-[var(--output-document-font)] [font-kerning:normal] [hyphens:auto] [text-rendering:optimizeLegibility] selection:bg-primary/15 selection:text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_abbr]:cursor-help [&_abbr]:decoration-dotted [&_abbr]:underline-offset-4 [&_figcaption]:mt-2 [&_figcaption]:font-[var(--output-ui-font)] [&_figcaption]:text-xs [&_figcaption]:leading-5 [&_figcaption]:text-muted-foreground [&_kbd]:rounded-sm [&_kbd]:border [&_kbd]:border-border [&_kbd]:bg-muted/60 [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:font-[var(--output-ui-font)] [&_kbd]:text-[0.82em] [&_.katex-display]:my-5 [&_.katex-display]:overflow-x-auto [&_.katex-display]:rounded-sm [&_.katex-display]:border-y [&_.katex-display]:border-border/70 [&_.katex-display]:bg-muted/[0.16] [&_.katex-display]:px-4 [&_.katex-display]:py-4 [&_.katex-display]:text-center [&_mark]:rounded-sm [&_mark]:bg-amber-200/70 [&_mark]:px-1 dark:[&_mark]:bg-amber-500/25 [&_small]:font-[var(--output-ui-font)] [&_small]:text-[0.82em] [&_small]:leading-normal [&_sub]:text-[0.75em] [&_sup]:text-[0.75em]";

export const markdownLinkClassName =
  "rounded-[2px] font-medium text-primary underline decoration-primary/45 decoration-1 underline-offset-4 transition-[background-color,color,text-decoration-color] hover:bg-primary/5 hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

export const markdownInlineCodeClassName =
  "rounded-sm border border-border/70 bg-muted/70 px-1.5 py-0.5 font-mono text-[0.88em] text-foreground break-words";

export const markdownParagraphClassName = "my-3 leading-relaxed [text-wrap:pretty]";

export const markdownDisplayMathClassName =
  "my-5 overflow-x-auto rounded-sm border-y border-border/70 bg-muted/[0.16] px-4 py-4 text-center [&_.katex-display]:my-0";

export const markdownInlineMathClassName =
  "inline align-baseline text-foreground [&_.katex]:text-[1.03em]";

export const markdownStrongClassName = "font-semibold text-foreground";

export const markdownEmphasisClassName = "italic text-muted-foreground";

export const markdownDeleteClassName =
  "text-muted-foreground decoration-destructive/55 decoration-2";

export const markdownBlockquoteClassName =
  "relative my-5 border-l-[3px] border-primary/45 bg-muted/[0.20] py-3 pr-4 pl-5 text-[0.98em] leading-[1.72] text-muted-foreground italic";

export const markdownListMarkerClassName = "marker:text-primary/65 marker:font-semibold";

export const markdownThematicBreakClassName = "my-7 border-0 border-t border-border/70";

export const markdownTableWrapperClassName =
  "my-5 overflow-x-auto rounded-sm border border-border/80 bg-background shadow-sm";

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

export const markdownHeadingAnchorClassName =
  "ml-2 inline-flex translate-y-[-0.08em] rounded-[2px] font-[var(--output-ui-font)] text-[0.58em] font-medium text-muted-foreground/40 no-underline decoration-transparent transition-colors hover:bg-primary/5 hover:text-primary focus-visible:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

export function markdownHeadingClassName(element: string) {
  if (element === "h1") {
    return "group/markdown-heading scroll-mt-16 mt-7 mb-4 text-[2rem] leading-[1.08] font-semibold [text-wrap:balance]";
  }
  if (element === "h2") {
    return "group/markdown-heading relative scroll-mt-16 mt-7 mb-3 border-b border-border/70 pb-2 text-2xl leading-tight font-semibold [text-wrap:balance] after:absolute after:bottom-[-1px] after:left-0 after:h-px after:w-16 after:bg-primary/50 after:content-['']";
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
