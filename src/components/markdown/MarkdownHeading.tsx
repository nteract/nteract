import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { markdownHeadingAnchorClassName, markdownHeadingClassName } from "./markdown-typography";

export type MarkdownHeadingElement = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

interface MarkdownHeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  anchorHref?: string;
  anchorLabel?: string;
  children: ReactNode;
  element: MarkdownHeadingElement;
}

export function MarkdownHeading({
  anchorHref,
  anchorLabel,
  children,
  className,
  element: Heading,
  ...props
}: MarkdownHeadingProps) {
  return (
    <Heading className={cn(markdownHeadingClassName(Heading), className)} {...props}>
      {children}
      {anchorHref && anchorLabel ? (
        <a aria-label={anchorLabel} className={markdownHeadingAnchorClassName} href={anchorHref}>
          #
        </a>
      ) : null}
    </Heading>
  );
}

export function markdownHeadingElement(element: string): MarkdownHeadingElement {
  if (element === "h1") return "h1";
  if (element === "h2") return "h2";
  if (element === "h3") return "h3";
  if (element === "h4") return "h4";
  if (element === "h5") return "h5";
  return "h6";
}
