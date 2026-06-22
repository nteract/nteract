import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
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
  onHomeClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onRename?: (title: string) => boolean | Promise<boolean>;
  placeholder?: string;
  renameButtonTitle?: string;
  renameError?: string | null;
  renameSaving?: boolean;
  renameTitle: string;
  title: DocumentTitleDisplay;
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
  onHomeClick,
  onRename,
  placeholder = "Untitled document",
  renameButtonTitle = "Rename document",
  renameError = null,
  renameSaving = false,
  renameTitle,
  title,
}: DocumentTitleProps) {
  const [editing, setEditing] = useState(false);
  const draftTitleRef = useRef(renameTitle);
  const editableRef = useRef<HTMLSpanElement | null>(null);
  const canShowRename = canRename && Boolean(onRename);

  useEffect(() => {
    if (!editing) {
      draftTitleRef.current = renameTitle;
    }
  }, [editing, renameTitle]);

  useLayoutEffect(() => {
    if (!editing || !editableRef.current) {
      return;
    }
    const editable = editableRef.current;
    editable.textContent = draftTitleRef.current;
    editable.focus();
    placeCaretAtEnd(editable);
  }, [editing]);

  const beginEditing = () => {
    if (!canShowRename || renameSaving) {
      return;
    }
    draftTitleRef.current = renameTitle;
    setEditing(true);
  };

  const commitRename = (titleDraft = draftTitleRef.current) => {
    if (!onRename || renameSaving) {
      return;
    }
    try {
      const result = onRename(normalizeTitleDraft(titleDraft));
      if (typeof result === "boolean") {
        if (result) {
          setEditing(false);
        }
        return;
      }
      void result
        .then((saved) => {
          if (saved) {
            setEditing(false);
          }
        })
        .catch(() => {});
    } catch {
      // The host owns rename error state; keep editing so the user can retry.
    }
  };

  const saveRename = () => {
    commitRename(updateDraftFromEditable());
  };

  const cancelRename = () => {
    if (renameSaving) {
      return;
    }
    draftTitleRef.current = renameTitle;
    setEditing(false);
  };

  const updateDraftFromEditable = (): string => {
    const nextTitle = editableTitleDraft(editableRef.current?.textContent ?? "");
    if ((editableRef.current?.textContent ?? "") !== nextTitle && editableRef.current) {
      editableRef.current.textContent = nextTitle;
      placeCaretAtEnd(editableRef.current);
    }
    draftTitleRef.current = nextTitle;
    return nextTitle;
  };

  const handleEditableKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename(updateDraftFromEditable());
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRename();
    }
  };

  const handleStaticTitleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      beginEditing();
    }
  };

  const handleEditablePaste = (event: ClipboardEvent<HTMLSpanElement>) => {
    event.preventDefault();
    const text = normalizeTitleDraft(event.clipboardData.getData("text/plain"));
    insertPlainTextAtSelection(event.currentTarget, text);
    updateDraftFromEditable();
  };

  return (
    <div className={cn("document-title-group", classNames?.group)}>
      {homeHref ? (
        <a
          className={cn("document-title-home-link", classNames?.homeLink)}
          href={homeHref}
          aria-label={homeAriaLabel}
          title={homeTitle}
          onClick={onHomeClick}
        >
          {homeIcon}
        </a>
      ) : null}
      <div className={cn("document-title", classNames?.title)} title={renameError ?? title.title}>
        <div
          className={cn("document-title-form", classNames?.form)}
          data-editing={editing ? "true" : "false"}
        >
          <span
            aria-disabled={editing && renameSaving ? true : undefined}
            aria-label={editing ? inputAriaLabel : undefined}
            className={cn(!editing && classNames?.staticTitle)}
            contentEditable={editing && !renameSaving}
            data-name={editing ? inputName : undefined}
            data-placeholder={placeholder}
            data-renameable={!editing && canShowRename ? "true" : undefined}
            data-slot="document-title-label"
            onClick={!editing && canShowRename ? beginEditing : undefined}
            onInput={editing ? updateDraftFromEditable : undefined}
            onKeyDown={editing ? handleEditableKeyDown : handleStaticTitleKeyDown}
            onPaste={editing ? handleEditablePaste : undefined}
            ref={editableRef}
            role={editing ? "textbox" : canShowRename ? "button" : undefined}
            spellCheck={editing ? "true" : undefined}
            suppressContentEditableWarning
            tabIndex={editing || canShowRename ? 0 : undefined}
          >
            {editing ? null : title.label}
          </span>
          {canShowRename ? (
            <span className="document-title-actions" data-slot="document-title-actions">
              {editing ? (
                <>
                  <button
                    type="button"
                    disabled={renameSaving}
                    title="Save title"
                    aria-label="Save title"
                    onClick={saveRename}
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
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={cn("document-title-edit-button", classNames?.editButton)}
                    disabled={renameSaving}
                    title={renameButtonTitle}
                    aria-label={`Rename ${title.label}`}
                    onClick={beginEditing}
                  >
                    <PencilLine aria-hidden="true" />
                  </button>
                  <span className="document-title-action-placeholder" aria-hidden="true" />
                </>
              )}
            </span>
          ) : null}
        </div>
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

function normalizeTitleDraft(value: string): string {
  return editableTitleDraft(value).trim();
}

function editableTitleDraft(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 160);
}

function placeCaretAtEnd(editable: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertPlainTextAtSelection(editable: HTMLElement, text: string): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !editable.contains(selection.anchorNode)) {
    editable.textContent = editableTitleDraft(`${editable.textContent ?? ""}${text}`);
    placeCaretAtEnd(editable);
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(document.createTextNode(text));
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}
