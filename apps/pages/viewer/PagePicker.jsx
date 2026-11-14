import { matchingPages } from "./page-list.mjs";
import {
  PROJECTS_PATH,
  pageLinkPath,
  pageTitleSlug,
  projectPath,
  isPlainNavigation,
} from "../shared/routes.mjs";
import { useEffect, useRef, useState } from "react";
import { Boxes, Check, FileText, Files, Plus, Search, Trash2, X } from "lucide-react";

/** `createProject` (`{ project_id, title }`), when the current Page is in a
 * Project this account owns or edits, splits New Page into "In <Project>", which
 * calls `onCreateInProject(project_id)`, and "In Your items" (`onCreate`).
 * `loading` says the Pages are still on their way: rather than none, or,
 * while rows this tab remembered show, rather than all of them. */
export function PagePicker({
  open,
  pages,
  loading = false,
  currentId,
  onClose,
  onOpen,
  onCreate,
  onTrash,
  onOpenIndex,
  projects = [],
  currentProjectId,
  onOpenProject,
  onCreateProject,
  createProject,
  onCreateInProject,
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
        {onOpenIndex && (
          <nav className="picker-index" aria-label="Browse">
            {[
              { kind: "pages", href: "/", label: "All Pages", Icon: Files },
              { kind: "projects", href: PROJECTS_PATH, label: "All Projects", Icon: Boxes },
            ].map(({ kind, href, label, Icon }) => (
              <a
                key={kind}
                href={href}
                onClick={(event) => {
                  if (!isPlainNavigation(event)) return;
                  event.preventDefault();
                  onClose();
                  onOpenIndex(kind);
                }}
              >
                <Icon size={16} aria-hidden="true" />
                {label}
              </a>
            ))}
          </nav>
        )}
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
        {createProject && onCreateInProject ? (
          // The current Page is in a Project: New Page can land there or in
          // Your items.
          <div className="picker-create-choices" role="group" aria-label="New Page">
            <button
              className="primary picker-create"
              disabled={creating}
              title={`New Page in ${createProject.title || "Project"}`}
              onClick={() => onCreateInProject(createProject.project_id)}
            >
              <Plus size={18} aria-hidden="true" />
              <span className="picker-create-label">New Page</span>{" "}
              <span className="picker-create-where">{`In ${createProject.title || "Project"}`}</span>
            </button>
            <button className="subtle-button picker-create" disabled={creating} onClick={onCreate}>
              <Plus size={18} aria-hidden="true" />
              <span className="picker-create-label">New Page</span>{" "}
              <span className="picker-create-where">In Your items</span>
            </button>
          </div>
        ) : (
          <button className="primary picker-create" disabled={creating} onClick={onCreate}>
            <Plus size={18} aria-hidden="true" /> New Page
          </button>
        )}
        {error && (
          <p className="error picker-error" role="alert">
            {error}
          </p>
        )}
        <nav className="picker-list" aria-label="Pages" aria-busy={loading}>
          {matches.map((page) => (
            <a
              className="picker-page"
              href={pageLinkPath(page)}
              key={page.page_id}
              aria-current={page.page_id === currentId ? "page" : undefined}
              onClick={(event) => {
                if (!isPlainNavigation(event)) return;
                event.preventDefault();
                onClose();
                void onOpen(page.page_id, { slug: pageTitleSlug(page.title) });
              }}
            >
              <FileText size={18} aria-hidden="true" />
              <span>{page.title || "Untitled"}</span>
              {page.page_id === currentId && <Check size={16} aria-hidden="true" />}
            </a>
          ))}
          {!matches.length ? (
            <p className="muted" role={loading ? "status" : undefined}>
              {loading ? "Loading…" : query ? "No matching pages." : "No pages yet."}
            </p>
          ) : (
            loading && (
              <p className="muted picker-loading" role="status">
                Loading every Page…
              </p>
            )
          )}
        </nav>
        {onOpenProject && (projects.length > 0 || onCreateProject) && (
          <nav className="picker-list picker-projects" aria-label="Projects">
            <div className="picker-section-heading">
              <h3 className="picker-section">Projects</h3>
              {onCreateProject && (
                <button
                  type="button"
                  className="subtle-button picker-new-project"
                  onClick={() => {
                    onClose();
                    onCreateProject();
                  }}
                >
                  <Plus size={16} aria-hidden="true" /> New Project
                </button>
              )}
            </div>
            {matchingPages(projects, query).map((project) => (
              <a
                className="picker-page"
                href={projectPath(project.project_id)}
                key={project.project_id}
                aria-current={project.project_id === currentProjectId ? "page" : undefined}
                onClick={(event) => {
                  if (!isPlainNavigation(event)) return;
                  event.preventDefault();
                  onClose();
                  onOpenProject(project.project_id);
                }}
              >
                <Boxes size={18} aria-hidden="true" />
                <span>{project.title || "Untitled"}</span>
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
