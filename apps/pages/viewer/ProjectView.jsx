import { Boxes, FileText, Plus } from "lucide-react";
import { pageLinkPath, pageTitleSlug, projectPath, isPlainNavigation } from "../shared/routes.mjs";
import { projectTree } from "./projects.mjs";

function PageRows({ rows, onOpen }) {
  return rows.map(({ page, depth }) => (
    <li
      className="page-row"
      key={page.page_id}
      style={{ paddingInlineStart: `${0.5 + depth * 1.25}rem` }}
    >
      <a
        className="page-card"
        href={pageLinkPath(page)}
        onClick={(event) => {
          if (!isPlainNavigation(event)) return;
          event.preventDefault();
          void onOpen(page.page_id, { slug: pageTitleSlug(page.title) });
        }}
      >
        <FileText size={19} aria-hidden="true" />
        <span className="page-card-title">{page.title || "Untitled"}</span>
      </a>
    </li>
  ));
}

/** Under a Project's content: its Pages and an
 * inline "+ New Page" row that adds one at the top level. For the Project's
 * owner and editors; the caller decides. `pages` are the Project's listed Pages. */
export function ProjectPages({ title, pages, onOpen, onCreate, creating = false }) {
  const rows = projectTree(pages);
  return (
    <section className="project-pages" aria-label={`Pages in ${title || "Project"}`}>
      <h2 className="project-pages-heading">Pages</h2>
      <ul className="page-list page-cards">
        <PageRows rows={rows} onOpen={onOpen} />
        {onCreate && (
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
        )}
      </ul>
    </section>
  );
}

/** Above a Project's content, in place of the breadcrumb that repeats the
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

/** Project › parent Pages above an open Page's title. */
export function Breadcrumbs({ crumbs, onOpenProject, onOpenPage }) {
  if (!crumbs?.length) return null;
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumbs">
      <ol>
        {crumbs.map((crumb) => (
          <li key={crumb.project_id ?? crumb.page_id}>
            <a
              href={crumb.kind === "project" ? projectPath(crumb.project_id) : pageLinkPath(crumb)}
              onClick={(event) => {
                if (!isPlainNavigation(event)) return;
                event.preventDefault();
                if (crumb.kind === "project") onOpenProject(crumb.project_id);
                else void onOpenPage(crumb.page_id, { slug: pageTitleSlug(crumb.title) });
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
