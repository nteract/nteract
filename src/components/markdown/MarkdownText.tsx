import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";
import {
  markdownBlockquoteClassName,
  markdownDeleteClassName,
  markdownEmphasisClassName,
  markdownInlineCodeClassName,
  markdownStrongClassName,
} from "./markdown-typography";

export function MarkdownBlockquote({
  className,
  ...props
}: ComponentPropsWithoutRef<"blockquote">) {
  return <blockquote className={cn(markdownBlockquoteClassName, className)} {...props} />;
}

export function MarkdownInlineCode({ className, ...props }: ComponentPropsWithoutRef<"code">) {
  return <code className={cn(markdownInlineCodeClassName, className)} {...props} />;
}

export function MarkdownStrong({ className, ...props }: ComponentPropsWithoutRef<"strong">) {
  return <strong className={cn(markdownStrongClassName, className)} {...props} />;
}

export function MarkdownEmphasis({ className, ...props }: ComponentPropsWithoutRef<"em">) {
  return <em className={cn(markdownEmphasisClassName, className)} {...props} />;
}

export function MarkdownDelete({ className, ...props }: ComponentPropsWithoutRef<"del">) {
  return <del className={cn(markdownDeleteClassName, className)} {...props} />;
}
