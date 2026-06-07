export const markdownDocumentClassName =
  "not-prose select-text py-2 text-base leading-[1.65] text-foreground font-[var(--output-document-font)] [font-kerning:normal] [hyphens:auto] [text-rendering:optimizeLegibility] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_kbd]:rounded-sm [&_kbd]:border [&_kbd]:border-border [&_kbd]:bg-muted/60 [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:font-[var(--output-ui-font)] [&_kbd]:text-[0.82em] [&_mark]:rounded-sm [&_mark]:bg-amber-200/70 [&_mark]:px-1 dark:[&_mark]:bg-amber-500/25 [&_sub]:text-[0.75em] [&_sup]:text-[0.75em]";

export const markdownLinkClassName =
  "rounded-[2px] font-medium text-primary underline decoration-primary/45 decoration-1 underline-offset-4 transition-[background-color,color,text-decoration-color] hover:bg-primary/5 hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

export const markdownInlineCodeClassName =
  "rounded-sm bg-muted/75 px-1.5 py-0.5 font-mono text-[0.9em] text-foreground";

export const markdownBlockquoteClassName =
  "my-4 border-l-[3px] border-primary/30 pl-4 text-muted-foreground italic";

export const markdownListMarkerClassName = "marker:text-muted-foreground marker:font-medium";

export function markdownHeadingClassName(element: string) {
  if (element === "h1") return "mt-6 mb-4 text-[1.875rem] leading-tight font-bold";
  if (element === "h2") {
    return "mt-[1.35rem] mb-3 border-b border-border/70 pb-1.5 text-2xl leading-tight font-bold";
  }
  if (element === "h3") return "mt-[1.2rem] mb-2.5 text-xl leading-tight font-semibold";
  if (element === "h4") return "mt-4 mb-2 text-lg leading-tight font-semibold";
  if (element === "h5") return "mt-3.5 mb-1.5 text-base leading-tight font-semibold";
  return "mt-3 mb-1.5 text-sm leading-tight font-semibold text-muted-foreground";
}
