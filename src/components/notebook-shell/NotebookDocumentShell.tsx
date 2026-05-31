import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { NotebookShellCapabilities } from "./capabilities";

export interface NotebookDocumentShellProps {
  /**
   * Use `main` for hosted/document routes and `div` when an app-level main
   * landmark already exists.
   */
  rootElement?: "div" | "main";
  header?: ReactNode;
  rail?: ReactNode;
  toolbar?: ReactNode;
  notices?: ReactNode;
  children: ReactNode;
  capabilities?: NotebookShellCapabilities;
  className?: string;
  headerClassName?: string;
  headerLabel?: string;
  bodyClassName?: string;
  stageClassName?: string;
  toolbarClassName?: string;
  toolbarLabel?: string;
  noticesClassName?: string;
  stageLabel?: string;
}

export function NotebookDocumentShell({
  rootElement = "div",
  header,
  rail,
  toolbar,
  notices,
  children,
  capabilities,
  className,
  headerClassName,
  headerLabel,
  bodyClassName,
  stageClassName,
  toolbarClassName,
  toolbarLabel,
  noticesClassName,
  stageLabel = "Notebook",
}: NotebookDocumentShellProps) {
  const Root = rootElement as ElementType;
  const hasHeader = Boolean(header);

  const stage = (
    <section
      className={cn("flex min-w-0 flex-1 flex-col", stageClassName)}
      aria-label={stageLabel}
      data-slot="notebook-document-stage"
    >
      {toolbar ? (
        <div
          className={toolbarClassName}
          aria-label={toolbarLabel}
          data-slot="notebook-document-toolbar"
        >
          {toolbar}
        </div>
      ) : null}
      {notices ? (
        <div className={noticesClassName} data-slot="notebook-document-notices">
          {notices}
        </div>
      ) : null}
      {children}
    </section>
  );

  const body = hasHeader ? (
    <div
      className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden", bodyClassName)}
      data-slot="notebook-document-body"
    >
      {rail}
      {stage}
    </div>
  ) : (
    <>
      {rail}
      {stage}
    </>
  );

  return (
    <Root
      className={cn("flex min-h-0 flex-1 overflow-hidden", hasHeader && "flex-col", className)}
      data-authenticated={capabilities?.auth.canUseAuthenticatedIdentity}
      data-access-level={capabilities?.access.level}
      data-access-source={capabilities?.access.source}
      data-can-edit={capabilities?.canEditCells}
      data-can-execute={capabilities?.canExecute}
      data-can-share={capabilities?.canManageSharing}
      data-slot="notebook-document-shell"
    >
      {header ? (
        <div
          className={headerClassName}
          aria-label={headerLabel}
          data-slot="notebook-document-header-frame"
        >
          {header}
        </div>
      ) : null}
      {body}
    </Root>
  );
}
