import { useEffect, useRef, useState } from "react";
import { Check, FileText, Plus, Search, X } from "lucide-react";

export function PagePicker({ open, pages, currentId, onClose, onOpen, onCreate, creating, error }) {
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
  const matches = pages.filter((page) =>
    (page.title || "Untitled").toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
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
            <button
              className="picker-page"
              key={page.page_id}
              aria-current={page.page_id === currentId ? "page" : undefined}
              onClick={() => {
                onClose();
                void onOpen(page.page_id);
              }}
            >
              <FileText size={18} aria-hidden="true" />
              <span>{page.title || "Untitled"}</span>
              {page.page_id === currentId && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
          {!matches.length && (
            <p className="muted">{query ? "No matching pages." : "No pages yet."}</p>
          )}
        </nav>
      </div>
    </dialog>
  );
}
