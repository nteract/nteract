import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";
import {
  markdownFigureCaptionClassName,
  markdownFigureClassName,
  markdownImageClassName,
} from "./markdown-typography";

export function MarkdownFigure({ className, ...props }: ComponentPropsWithoutRef<"figure">) {
  return <figure className={cn(markdownFigureClassName, className)} {...props} />;
}

export function MarkdownImage({ className, ...props }: ComponentPropsWithoutRef<"img">) {
  return <img className={cn(markdownImageClassName, className)} {...props} />;
}

export function MarkdownFigureCaption({
  className,
  ...props
}: ComponentPropsWithoutRef<"figcaption">) {
  return <figcaption className={cn(markdownFigureCaptionClassName, className)} {...props} />;
}
