import { useEffect, useRef, useState } from "react";
import { FileText, Home, Plus } from "lucide-react";
import { pagePath, projectPath, isPlainNavigation } from "../shared/routes.mjs";
import { createPageInProject, listProjectPages, projectTree } from "./projects.mjs";

/** One Project: its home Page, then its Pages as a tree. Owner-only for now.
 * Loading and errors stay local and simple here; the Project view moves to the
 * shared RxJS store pattern when the Pages state-machine tooling lands. */
export function ProjectView({ tool, projectId, onOpen, onBack, onCreated }) {
  const [project, setProject] = useState(null);
  const [pages, setPages] = useState(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const revision = ++generation.current;
    setProject(null);
    setPages(null);
    setError("");
    Promise.all([
      tool("get_project", { project_id: projectId }),
      listProjectPages(tool, projectId),
    ]).then(
      ([loaded, listed]) => {
        if (revision !== generation.current) return;
        setProject(loaded);
        setPages(listed);
      },
      (cause) => {
        if (revision === generation.current) setError(cause.message);
      },
    );
    return () => {
      generation.current++;
    };
  }, [projectId]);
  async function create() {
    setCreating(true);
    setError("");
    try {
      const created = await createPageInProject(tool, projectId);
      onCreated?.();
      await onOpen(created.page_id);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setCreating(false);
    }
  }
  const link = (page, children) => (
    <a
      className="page-card"
      href={pagePath(page.page_id)}
      onClick={(event) => {
        if (!isPlainNavigation(event)) return;
        event.preventDefault();
        void onOpen(page.page_id);
      }}
    >
      {children}
    </a>
  );
  const tree = pages ? projectTree(pages) : null;
  return (
    <main className="page-library project-view">
      <div className="library-heading">
        <div>
          <button className="subtle-button project-back" onClick={onBack}>
            All pages
          </button>
          <h1>{project?.title ?? "Project"}</h1>
          {project?.description && (
            <p className="muted project-description">{project.description}</p>
          )}
        </div>
        <div className="library-actions">
          <button className="primary" onClick={create} disabled={creating || !project}>
            <Plus size={18} aria-hidden="true" /> New Page in this Project
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!tree && !error && <p role="status">Loading…</p>}
      {tree && (
        <ul className="page-list page-cards" aria-label={`Pages in ${project?.title ?? "Project"}`}>
          {tree.map(({ page, depth }) => (
            <li
              className={page.home ? "page-row project-home" : "page-row"}
              key={page.page_id}
              style={{ paddingInlineStart: `${0.5 + depth * 1.25}rem` }}
            >
              {link(
                page,
                <>
                  {page.home ? (
                    <Home size={19} aria-hidden="true" />
                  ) : (
                    <FileText size={19} aria-hidden="true" />
                  )}
                  <span className="page-card-title">{page.title || "Untitled"}</span>
                  {page.home && <span className="page-card-meta">Home</span>}
                </>,
              )}
            </li>
          ))}
          {tree.length < 2 && <li className="muted project-empty">No other Pages yet.</li>}
        </ul>
      )}
    </main>
  );
}

/** Project › parent Pages above an open Page's title. */
export function Breadcrumbs({ crumbs, onOpenProject, onOpenPage }) {
  if (!crumbs?.length) return null;
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumbs">
      <ol>
        {crumbs.map((crumb) => (
          <li key={crumb.project_id ?? crumb.page_id}>
            <a
              href={
                crumb.kind === "project" ? projectPath(crumb.project_id) : pagePath(crumb.page_id)
              }
              onClick={(event) => {
                if (!isPlainNavigation(event)) return;
                event.preventDefault();
                if (crumb.kind === "project") onOpenProject(crumb.project_id);
                else void onOpenPage(crumb.page_id);
              }}
            >
              {crumb.title || "Untitled"}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
