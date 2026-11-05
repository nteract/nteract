import { Boxes, FileText, Plus } from "lucide-react";
import { pagePath, projectPath, isPlainNavigation } from "../shared/routes.mjs";
import { projectTree, visibleCrumbs } from "./projects.mjs";

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
