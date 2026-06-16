import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Check, Loader2, PencilLine, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DocumentTitleDisplay {
  label: string;
  detail: string | null;
  title: string;
}

export interface DocumentTitleClassNames {
  group?: string;
  homeLink?: string;
  title?: string;
  staticTitle?: string;
  form?: string;
  editButton?: string;
  status?: string;
  spinner?: string;
}

export interface DocumentTitleProps {
  canRename?: boolean;
  classNames?: DocumentTitleClassNames;
  homeAriaLabel?: string;
  homeHref?: string;
  homeIcon?: ReactNode;
  homeTitle?: string;
  inputAriaLabel?: string;
  inputName?: string;
  placeholder?: string;
  renameButtonTitle?: string;
  renameError?: string | null;
  renameSaving?: boolean;
  renameTitle: string;
  title: DocumentTitleDisplay;
  onRename?: (title: string) => boolean | Promise<boolean>;
}

export function DocumentTitle({
  canRename = false,
  classNames,
  homeAriaLabel = "Open documents",
  homeHref,
  homeIcon,
  homeTitle = "Documents",
  inputAriaLabel = "Document title",
  inputName = "document-title",
  placeholder = "Untitled document",
  renameButtonTitle = "Rename document",
  renameError = null,
  renameSaving = false,
  renameTitle,
  title,
  onRename,
}: DocumentTitleProps) {
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
    <div className={cn("document-title-group", classNames?.group)}>
      {homeHref ? (
        <a
          className={cn("document-title-home-link", classNames?.homeLink)}
          href={homeHref}
          aria-label={homeAriaLabel}
          title={homeTitle}
        >
          {homeIcon}
        </a>
      ) : null}
      <div className={cn("document-title", classNames?.title)} title={renameError ?? title.title}>
        {editing ? (
          <form className={cn("document-title-form", classNames?.form)} onSubmit={saveRename}>
            <input
              aria-label={inputAriaLabel}
              autoFocus
              disabled={renameSaving}
              maxLength={160}
              name={inputName}
              placeholder={placeholder}
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
                <Loader2
                  className={cn("document-title-spinner", classNames?.spinner)}
                  aria-hidden="true"
                />
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
          <div className={cn("document-title-static", classNames?.staticTitle)}>
            <span>{title.label}</span>
            {canRename && onRename ? (
              <button
                type="button"
                className={cn("document-title-edit-button", classNames?.editButton)}
                disabled={renameSaving}
                title={renameButtonTitle}
                aria-label={`Rename ${title.label}`}
                onClick={() => setEditing(true)}
              >
                <PencilLine aria-hidden="true" />
              </button>
            ) : null}
          </div>
        )}
        {renameError ? (
          <small className={cn("document-title-status", classNames?.status)} role="status">
            {renameError}
          </small>
        ) : title.detail ? (
          <small>{title.detail}</small>
        ) : null}
      </div>
    </div>
  );
}
