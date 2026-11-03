// The index nav, /projects, and the pieces the Pages library (Library.jsx)
// shares with it. Both screens render from the shell chunk; nothing here
// imports the editor. Each runs one Listing (listing.mjs); its rows and
// request state live in that store, and React keeps only local UI state.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, Plus } from "lucide-react";
import { PROJECTS_PATH, isPlainNavigation } from "../shared/routes.mjs";
import { Listing, listingView, projectRow, projectsRequest } from "./listing.mjs";
import { useStore } from "./store.mjs";
import { ProjectCreator } from "./ProjectCreator.jsx";

/** Where the index nav leads. `kind` is what onNavigate receives. The Pages
 * library's canonical address is /; /pages shows the same screen. */
export const INDEX_LINKS = Object.freeze([
  { kind: "pages", href: "/", label: "Pages" },
  { kind: "projects", href: PROJECTS_PATH, label: "Projects" },
]);

/** Plain clicks on an in-app link run `action`; modified clicks keep the
 * browser's own behavior (new tab, copy link). */
export const follow = (action) => (event) => {
  if (!isPlainNavigation(event)) return;
  event.preventDefault();
  action();
};

/** Pages and Projects, at the top of each listing screen. */
export function IndexNav({ current, onNavigate }) {
  return (
    <nav className="index-nav" aria-label="Browse">
      {INDEX_LINKS.map(({ kind, href, label }) => (
        <a
          key={kind}
          href={href}
          aria-current={kind === current ? "page" : undefined}
          onClick={follow(() => onNavigate(kind))}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

/** A Listing or Clock made once per mount, connected while mounted. */
export function useConnected(create) {
  const [connectable] = useState(create);
  useEffect(() => connectable.connect(), [connectable]);
  return connectable;
}

/** What shows under the rows: Load more, its progress, or its retry. */
export function ListingFooter({ view, listing, label, onRetry }) {
  if (view.loadingMore)
    return (
      <button className="subtle-button index-more" disabled>
        Loading…
      </button>
    );
  if (view.stalled)
    return (
      <button className="subtle-button index-more" onClick={() => onRetry(() => listing.more())}>
        Try again
      </button>
    );
  if (view.canLoadMore)
    return (
      <button className="subtle-button index-more" onClick={() => listing.more()}>
        Load more {label}
      </button>
    );
  return null;
}

/** Loading, failure and empty states for /projects. */
function ListingStatus({ view, empty, onRetry, listing }) {
  if (view.loading) return <p role="status">Loading…</p>;
  if (view.failed)
    return (
      <p className="index-status">
        <button className="subtle-button" onClick={() => onRetry(() => listing.load(view.params))}>
          Try again
        </button>
      </p>
    );
  if (view.empty) return <p className="muted index-status">{empty}</p>;
  return null;
}

export function ProjectsIndex({
  tool,
  onNavigate,
  onOpenProject,
  onProjectCreated = onOpenProject,
  onError,
  onRetry,
}) {
  const [creating, setCreating] = useState(false);
  const listing = useConnected(
    () =>
      new Listing({
        fetch: projectsRequest(tool),
        report: onError,
        idOf: (project) => project.project_id,
      }),
  );
  useEffect(() => void listing.load(), [listing]);
  const snapshot = useStore(listing.store);
  const view = listingView(snapshot);
  const rows = useMemo(() => snapshot.items.map(projectRow), [snapshot.items]);

  const onCreated = useCallback(
    (receipt) => {
      setCreating(false);
      onProjectCreated(receipt.project_id);
    },
    [onProjectCreated],
  );

  return (
    <main className="page-library index-view">
      <IndexNav current="projects" onNavigate={onNavigate} />
      <div className="library-heading">
        <h1>Projects</h1>
        <button className="primary" onClick={() => setCreating(true)}>
          <Plus size={18} aria-hidden="true" />
          New Project
        </button>
      </div>
      <ListingStatus
        view={view}
        listing={listing}
        onRetry={onRetry}
        empty="No Projects yet. Create one with New Project, or ask an agent to."
      />
      {!view.failed && rows.length > 0 && (
        <ul className="index-list" aria-label="Projects">
          {rows.map((row) => (
            <li className="index-row" key={row.id}>
              <Boxes className="index-row-icon" size={19} aria-hidden="true" />
              <div className="index-row-body">
                <a
                  className="index-row-link"
                  href={row.href}
                  onClick={follow(() => onOpenProject(row.id))}
                >
                  {row.title}
                </a>
                {row.description && <p className="index-row-detail">{row.description}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ListingFooter view={view} listing={listing} label="Projects" onRetry={onRetry} />
      {creating && (
        <ProjectCreator tool={tool} onClose={() => setCreating(false)} onCreated={onCreated} />
      )}
    </main>
  );
}
