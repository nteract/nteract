import { DocumentTitle } from "@/components/notebook/DocumentTitle";
import {
  cloudNotebookRouteTitleFromPathname,
  type CloudNotebookTitleDisplay,
} from "./cloud-notebook-title-state";

export function CloudNotebookTitle({
  canRename = false,
  renameError = null,
  renameSaving = false,
  renameTitle,
  title,
  onRename,
}: {
  canRename?: boolean;
  renameError?: string | null;
  renameSaving?: boolean;
  renameTitle: string;
  title: CloudNotebookTitleDisplay;
  onRename?: (title: string) => boolean | Promise<boolean>;
}) {
  return (
    <DocumentTitle
      title={title}
      renameTitle={renameTitle}
      canRename={canRename}
      renameSaving={renameSaving}
      renameError={renameError}
      onRename={onRename}
      inputAriaLabel="Notebook title"
      inputName="notebook-title"
      placeholder="Untitled notebook"
      renameButtonTitle="Rename notebook"
      classNames={cloudNotebookTitleClassNames}
    />
  );
}

export const cloudNotebookTitleClassNames = {
  group: "cloud-notebook-title-group",
  title: "cloud-notebook-title",
  staticTitle: "cloud-notebook-title-static",
  form: "cloud-notebook-title-form",
  editButton: "cloud-notebook-title-edit-button",
  status: "cloud-notebook-title-status",
  spinner: "cloud-notebook-title-spinner",
};

export function cloudNotebookRouteTitle(): CloudNotebookTitleDisplay {
  return cloudNotebookRouteTitleFromPathname(window.location.pathname);
}
