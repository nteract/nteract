// The index routes: /projects lists every Project the account can open and
// /pages every Page, newest first. Both render from the shell chunk; nothing
// here imports the editor. Each screen runs one Listing (listing.mjs); its
// rows and request state live in that store, and React keeps only the search
// box's text.
import { useEffect, useMemo, useState } from "react";
import { Boxes, FileText, Home, Search } from "lucide-react";
import {
  PAGES_QUERY_MAX,
  PROJECTS_PATH,
  isPlainNavigation,
  normalizePagesQuery,
} from "../shared/routes.mjs";
import {
  Listing,
  listingView,
  pageRow,
  pagesRequest,
  projectRow,
  projectTitles,
  projectsRequest,
} from "./listing.mjs";
import { useStore } from "./store.mjs";

/** Where the index nav leads. `kind` is what onNavigate receives. */
export const INDEX_LINKS = Object.freeze([
  { kind: "home", href: "/", label: "Home" },
  { kind: "pages", href: "/pages", label: "All Pages" },
  { kind: "projects", href: PROJECTS_PATH, label: "Projects" },
]);

/** Plain clicks on an in-app link run `action`; modified clicks keep the
 * browser's own behavior (new tab, copy link). */
const follow = (action) => (event) => {
  if (!isPlainNavigation(event)) return;
  event.preventDefault();
  action();
};

/** Home, All Pages and Projects, at the top of each listing screen. */
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

function useListing(create) {
  const [listing] = useState(create);
  useEffect(() => listing.connect(), [listing]);
  return listing;
}

/** What shows under the rows: Load more, its progress, or its retry. */
function ListingFooter({ view, listing, label, onRetry }) {
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

/** Loading, failure and empty states shared by both screens. */
function ListingStatus({ view, empty, onRetry, listing }) {
  if (view.loading) return <p role="status">Loading…</p>;
  if (view.failed)
    return (
      <p className="index-status">
        <button className="subtle-button" onClick={() => onRetry(() => listing.load(view.query))}>
          Try again
        </button>
      </p>
    );
  if (view.empty) return <p className="muted index-status">{empty}</p>;
  return null;
}

export function ProjectsIndex({ tool, onNavigate, onOpenProject, onError, onRetry }) {
  const listing = useListing(
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
  return (
    <main className="page-library index-view">
      <IndexNav current="projects" onNavigate={onNavigate} />
      <div className="library-heading">
        <h1>Projects</h1>
      </div>
      <ListingStatus
        view={view}
        listing={listing}
        onRetry={onRetry}
        empty="No Projects yet. An agent can create one with create_project."
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
    </main>
  );
}

export function PagesIndex({
  tool,
  query,
  projects,
  onNavigate,
  onQueryChange,
  onOpen,
  onOpenProject,
  onWarm,
  onError,
  onRetry,
}) {
  const [text, setText] = useState(query);
  const listing = useListing(
    () =>
      new Listing({
        fetch: pagesRequest(tool),
        report: onError,
        idOf: (page) => page.page_id,
      }),
  );
  useEffect(() => {
    // Mounting lists the route's own query, so it never reports a change:
    // only a search typed here moves the address, and the owner checks that
    // the address is still this screen's.
    let reported = normalizePagesQuery(query);
    listing.load(reported);
    const subscription = listing.store
      .select((current) => current.state.query)
      .subscribe((listed) => {
        if (listed === undefined || listed === reported) return;
        reported = listed;
        onQueryChange(listed);
      });
    return () => subscription.unsubscribe();
  }, [listing]);
  const snapshot = useStore(listing.store);
  const view = listingView(snapshot);
  const titles = useMemo(() => projectTitles(projects), [projects]);
  const rows = useMemo(
    () => snapshot.items.map((page) => pageRow(page, titles)),
    [snapshot.items, titles],
  );
  return (
    <main className="page-library index-view">
      <IndexNav current="pages" onNavigate={onNavigate} />
      <div className="library-heading">
        <h1>All Pages</h1>
      </div>
      <form
        className="index-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          listing.load(text);
        }}
      >
        <label className="picker-search library-search">
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="Search all Pages"
            placeholder="Search Pages"
            type="search"
            enterKeyHint="search"
            maxLength={PAGES_QUERY_MAX}
            value={text}
            onChange={(event) => {
              const value = event.target.value.slice(0, PAGES_QUERY_MAX);
              setText(value);
              listing.search(value);
            }}
          />
        </label>
      </form>
      {view.searching && (
        <p role="status" className="muted index-searching">
          Searching…
        </p>
      )}
      <ListingStatus
        view={view}
        listing={listing}
        onRetry={onRetry}
        empty={view.query ? `No Pages match “${view.query}”.` : "No Pages yet."}
      />
      {!view.failed && rows.length > 0 && (
        <ul className="index-list" aria-label="All Pages" aria-busy={view.searching}>
          {rows.map((row) => (
            <li className="index-row" key={row.id}>
              {row.home ? (
                <Home className="index-row-icon" size={19} aria-hidden="true" />
              ) : (
                <FileText className="index-row-icon" size={19} aria-hidden="true" />
              )}
              <div className="index-row-body">
                <a
                  className="index-row-link"
                  href={row.href}
                  onPointerDown={onWarm}
                  onClick={follow(() => onOpen(row.id))}
                >
                  {row.title}
                </a>
                {(row.project || row.shared) && (
                  <p className="index-row-meta">
                    {row.project && (
                      <a
                        className="index-row-project"
                        href={row.project.href}
                        aria-label={`Project ${row.project.title}`}
                        onClick={follow(() => onOpenProject(row.project.id))}
                      >
                        <Boxes size={13} aria-hidden="true" />
                        <span>{row.project.title}</span>
                      </a>
                    )}
                    {row.shared && <span className="index-row-shared">Shared with you</span>}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ListingFooter view={view} listing={listing} label="Pages" onRetry={onRetry} />
    </main>
  );
}
