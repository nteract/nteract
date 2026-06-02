import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { NotebookNoticeStack } from "./NotebookNotice";

export interface NotebookToolbarFrameProps {
  children: ReactNode;
  className?: string;
  notices?: ReactNode;
}

export function NotebookToolbarFrame({ children, className, notices }: NotebookToolbarFrameProps) {
  return (
    <header
      className={cn(
        "@container sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60 select-none",
        className,
      )}
      data-slot="notebook-toolbar-frame"
    >
      {children}
      {notices ? <NotebookNoticeStack>{notices}</NotebookNoticeStack> : null}
    </header>
  );
}
