import { useEffect, useRef, useState } from "react";
import { Boxes, FileText, Plus } from "lucide-react";
import { PROJECTS_PATH, pagePath, projectPath, isPlainNavigation } from "../shared/routes.mjs";
import { listProjectPages, projectTree, visibleCrumbs } from "./projects.mjs";

/** Rows under a Project's home Page: the Project's Pages without the home
 * row, one level shallower since the home Page stands for the Project. */
export function projectPageRows(pages) {
  // Without the home row its children have no listed parent, so the tree
  // puts them at the top level.
  return projectTree(pages.filter((page) => !page.home));
}

function PageRows({ rows, onOpen }) {
  return rows.map(({ page, depth }) => (
    <li
      className="page-row"
      key={page.page_id}
      style={{ paddingInlineStart: `${0.5 + depth * 1.25}rem` }}
    >
      <a
        className="page-card"
        href={pagePath(page.page_id)}
        onClick={(event) => {
          if (!isPlainNavigation(event)) return;
          event.preventDefault();
          void onOpen(page.page_id);
        }}
      >
        <FileText size={19} aria-hidden="true" />
        <span className="page-card-title">{page.title || "Untitled"}</span>
      </a>
    </li>
  ));
}

/** One Project: its heading opens the home Page, then its other Pages as a
 * tree. Owner-only for now. `onCreate()` adds a Page at the top level (the
 * caller runs it as a cancellable draft). The Project and its Pages load
 * separately, so New Page works as soon as the Project answers, even while
 * the list loads or after it fails. Loading and errors stay local. */
export function ProjectView({ tool, projectId, onOpen, onBack, onCreate, creating = false }) {
  const [project, setProject] = useState(null);
  const [pages, setPages] = useState(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const revision = ++generation.current;
    setProject(null);
    setPages(null);
    setError("");
    const failed = (cause) => {
      if (revision === generation.current) setError(cause.message);
    };
    tool("get_project", { project_id: projectId }).then((loaded) => {
      if (revision === generation.current) setProject(loaded);
    }, failed);
    listProjectPages(tool, projectId).then((listed) => {
      if (revision === generation.current) setPages(listed);
    }, failed);
    return () => {
      generation.current++;
    };
  }, [projectId]);
  const rows = pages ? projectPageRows(pages) : null;
  const title = project?.title || "Project";
  const homeId = project?.home_page_id;
  const newPage = (
    <button className="primary" onClick={() => onCreate?.()} disabled={creating || !project}>
      <Plus size={18} aria-hidden="true" /> New Page
    </button>
  );
  return (
    <main className="page-library project-view">
      <div className="library-heading">
        <div>
          <a
            className="subtle-button project-back"
            href={PROJECTS_PATH}
            onClick={(event) => {
              if (!isPlainNavigation(event)) return;
              event.preventDefault();
              onBack();
            }}
          >
            Projects
          </a>
          <h1>
            {homeId ? (
              <a
                className="project-heading-link"
                href={pagePath(homeId)}
                title="Open the Project's home Page"
                onClick={(event) => {
                  if (!isPlainNavigation(event)) return;
                  event.preventDefault();
                  void onOpen(homeId);
                }}
              >
                {title}
              </a>
            ) : (
              title
            )}
          </h1>
          {project?.description && (
            <p className="muted project-description">{project.description}</p>
          )}
        </div>
        {/* Until the list answers, or when it fails, New Page stays here; an
            empty Project carries it in its empty state instead. */}
        {project && rows?.length !== 0 && <div className="library-actions">{newPage}</div>}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!rows && !error && <p role="status">Loading…</p>}
      {rows && rows.length === 0 && (
        <div className="project-empty">
          <p className="muted">No Pages yet</p>
          {newPage}
        </div>
      )}
      {rows && rows.length > 0 && (
        <ul className="page-list page-cards" aria-label={`Pages in ${title}`}>
          <PageRows rows={rows} onOpen={onOpen} />
        </ul>
      )}
    </main>
  );
}

/** On a Project's home Page, under the body: the Project's Pages and an
 * inline "+ New Page" row that adds one at the top level. Owner only; the
 * caller decides. `pages` are the Project's listed Pages. */
export function ProjectPages({ title, pages, onOpen, onCreate, creating = false }) {
  const rows = projectPageRows(pages);
  return (
    <section className="project-pages" aria-label={`Pages in ${title || "Project"}`}>
      <h2 className="project-pages-heading">Pages</h2>
      <ul className="page-list page-cards">
        <PageRows rows={rows} onOpen={onOpen} />
        <li className="page-row project-new-page">
          <button
            type="button"
            className="page-card subtle-button"
            onClick={() => onCreate()}
            disabled={creating}
          >
            <Plus size={19} aria-hidden="true" />
            <span className="page-card-title">New Page</span>
          </button>
        </li>
      </ul>
    </section>
  );
}

/** Pages in a Project, counted for its chip: the home Page isn't one. */
export const projectPageCount = (pages) => pages.filter((page) => !page.home).length;

/** On a Project's home Page, in place of the breadcrumb that repeats the
 * title: "Project · N Pages", opening the Project view. A null `count`
 * (still loading) shows "Project". */
export function ProjectChip({ projectId, count, onOpenProject }) {
  return (
    <nav className="breadcrumbs project-chip-nav" aria-label="Project">
      <a
        className="project-chip"
        href={projectPath(projectId)}
        onClick={(event) => {
          if (!isPlainNavigation(event)) return;
          event.preventDefault();
          onOpenProject(projectId);
        }}
      >
        <Boxes size={14} aria-hidden="true" />
        {count === null || count === undefined
          ? "Project"
          : `Project · ${count} ${count === 1 ? "Page" : "Pages"}`}
      </a>
    </nav>
  );
}

/** Project › parent Pages above an open Page's title. The Project crumb also
 * stands for its home Page. */
export function Breadcrumbs({ crumbs, onOpenProject, onOpenPage }) {
  if (!crumbs?.length) return null;
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumbs">
      <ol>
        {visibleCrumbs(crumbs).map((crumb) => (
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
