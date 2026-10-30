import { matchingPages } from "./page-list.mjs";
import { pagePath, spacePath, isPlainNavigation } from "../shared/routes.mjs";
import { useEffect, useRef, useState } from "react";
import { Boxes, Check, FileText, Plus, Search, Trash2, X } from "lucide-react";

export function PagePicker({
  open,
  pages,
  currentId,
  onClose,
  onOpen,
  onCreate,
  onTrash,
  spaces = [],
  currentSpaceId,
  onOpenSpace,
  creating,
  error,
}) {
  const dialog = useRef(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const element = dialog.current;
    if (open && !element.open) {
      setQuery("");
      element.showModal();
      element.querySelector("input")?.focus();
    } else if (!open && element.open) element.close();
  }, [open]);
  const matches = matchingPages(pages, query);
  return (
    <dialog
      ref={dialog}
      className="page-picker"
      aria-labelledby="page-picker-title"
      onClose={() => {
        if (!dialog.current.open) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="picker-content">
        <div className="picker-heading">
          <h2 id="page-picker-title">Pages</h2>
          <button className="icon-button" aria-label="Close Pages" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <label className="picker-search">
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="Search Pages"
            placeholder="Search pages"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        </label>
        <button className="primary picker-create" disabled={creating} onClick={onCreate}>
          <Plus size={18} aria-hidden="true" /> New Page
        </button>
        {error && (
          <p className="error picker-error" role="alert">
            {error}
          </p>
        )}
        <nav className="picker-list" aria-label="Pages">
          {matches.map((page) => (
            <a
              className="picker-page"
              href={pagePath(page.page_id)}
              key={page.page_id}
              aria-current={page.page_id === currentId ? "page" : undefined}
              onClick={(event) => {
                if (!isPlainNavigation(event)) return;
                event.preventDefault();
                onClose();
                void onOpen(page.page_id);
              }}
            >
              <FileText size={18} aria-hidden="true" />
              <span>{page.title || "Untitled"}</span>
              {page.page_id === currentId && <Check size={16} aria-hidden="true" />}
            </a>
          ))}
          {!matches.length && (
            <p className="muted">{query ? "No matching pages." : "No pages yet."}</p>
          )}
        </nav>
        {onOpenSpace && spaces.length > 0 && (
          <nav className="picker-list picker-spaces" aria-label="Spaces">
            <h3 className="picker-section">Spaces</h3>
            {matchingPages(spaces, query).map((space) => (
              <a
                className="picker-page"
                href={spacePath(space.space_id)}
                key={space.space_id}
                aria-current={space.space_id === currentSpaceId ? "page" : undefined}
                onClick={(event) => {
                  if (!isPlainNavigation(event)) return;
                  event.preventDefault();
                  onClose();
                  onOpenSpace(space.space_id);
                }}
              >
                <Boxes size={18} aria-hidden="true" />
                <span>{space.title || "Untitled"}</span>
              </a>
            ))}
          </nav>
        )}
        {onTrash && (
          <button
            className="subtle-button picker-trash"
            onClick={() => {
              onClose();
              onTrash();
            }}
          >
            <Trash2 size={16} aria-hidden="true" /> Trash
          </button>
        )}
      </div>
    </dialog>
  );
}
