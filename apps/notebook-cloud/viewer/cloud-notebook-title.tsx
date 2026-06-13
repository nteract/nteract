import { useEffect, useState, type FormEvent } from "react";
import { Check, House, Loader2, PencilLine, X } from "lucide-react";
import { notebookRouteSegmentTitle } from "../src/notebook-route-title";
import type { CloudNotebookTitleDisplay } from "./cloud-notebook-title-state";

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
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(renameTitle);

  useEffect(() => {
    if (!editing) {
      setDraftTitle(renameTitle);
    }
  }, [editing, renameTitle]);

  const saveRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onRename || renameSaving) {
      return;
    }
    void Promise.resolve(onRename(draftTitle))
      .then((saved) => {
        if (saved) {
          setEditing(false);
        }
      })
      .catch(() => {});
  };

  const cancelRename = () => {
    if (renameSaving) {
      return;
    }
    setDraftTitle(renameTitle);
    setEditing(false);
  };

  return (
    <div className="cloud-notebook-title-group">
      <a
        className="cloud-notebook-home-link"
        href="/n"
        aria-label="Open notebooks dashboard"
        title="Notebooks"
      >
        <House aria-hidden="true" />
      </a>
      <div className="cloud-notebook-title" title={renameError ?? title.title}>
        {editing ? (
          <form className="cloud-notebook-title-form" onSubmit={saveRename}>
            <input
              aria-label="Notebook title"
              autoFocus
              disabled={renameSaving}
              maxLength={160}
              name="notebook-title"
              placeholder="Untitled notebook"
              type="text"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.currentTarget.value)}
            />
            <button
              type="submit"
              disabled={renameSaving}
              title="Save title"
              aria-label="Save title"
            >
              {renameSaving ? (
                <Loader2 className="cloud-notebook-title-spinner" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              disabled={renameSaving}
              title="Cancel rename"
              aria-label="Cancel rename"
              onClick={cancelRename}
            >
              <X aria-hidden="true" />
            </button>
          </form>
        ) : (
          <div className="cloud-notebook-title-static">
            <span>{title.label}</span>
            {canRename && onRename ? (
              <button
                type="button"
                className="cloud-notebook-title-edit-button"
                disabled={renameSaving}
                title="Rename notebook"
                aria-label={`Rename ${title.label}`}
                onClick={() => setEditing(true)}
              >
                <PencilLine aria-hidden="true" />
              </button>
            ) : null}
          </div>
        )}
        {renameError ? (
          <small className="cloud-notebook-title-status" role="status">
            {renameError}
          </small>
        ) : title.detail ? (
          <small>{title.detail}</small>
        ) : null}
      </div>
    </div>
  );
}

export function cloudNotebookRouteTitle(): CloudNotebookTitleDisplay {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const routeSlug = pathParts[0] === "n" ? pathParts[2] : null;
  const routeTitle = notebookRouteSegmentTitle(routeSlug);

  if (routeTitle) {
    return {
      label: routeTitle,
      detail: null,
      title: routeTitle,
    };
  }

  return {
    label: "Cloud Notebook",
    detail: null,
    title: "Cloud Notebook",
  };
}
