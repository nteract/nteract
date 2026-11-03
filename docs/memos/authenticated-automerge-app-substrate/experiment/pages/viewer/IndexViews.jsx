// The index routes: /projects lists every Project the account can open and
// /pages every Page, newest first. Both render from the shell chunk; nothing
// here imports the editor. Each screen runs one Listing (listing.mjs); its
// rows and request state live in that store, and React keeps only local UI
// state: the search box's text and /pages' list or grid display.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, FileText, Home, LayoutGrid, List, Plus, Search } from "lucide-react";
import {
  clampPagesQuery,
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
import { readDisplayMode, writeDisplayMode } from "./display-mode.mjs";
import { timeCell } from "./relative-time.mjs";
import { Clock } from "./clock.mjs";
import { PageCardPreview } from "./PageCardPreview.jsx";
import { ProjectCreator } from "./ProjectCreator.jsx";

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

/** A Listing or Clock made once per mount, connected while mounted. */
function useConnected(create) {
  const [connectable] = useState(create);
  useEffect(() => connectable.connect(), [connectable]);
  return connectable;
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
  clock: givenClock,
}) {
  const [text, setText] = useState(query);
  const clock = useConnected(() => givenClock ?? new Clock());
  const now = useStore(clock.store);
  const listing = useConnected(
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
  const [display, setDisplay] = useState(() => readDisplayMode(browser()));
  const chooseDisplay = useCallback((mode) => {
    const shown = writeDisplayMode(browser(), mode);
    if (shown) setDisplay(shown);
  }, []);
  const titles = useMemo(() => projectTitles(projects), [projects]);
  const rows = useMemo(
    () => snapshot.items.map((page) => pageRow(page, titles)),
    [snapshot.items, titles],
  );
  const Rows = display === "grid" ? PageGrid : PageList;
  return (
    <main className="page-library index-view index-pages">
      <IndexNav current="pages" onNavigate={onNavigate} />
      <div className="library-heading index-heading">
        <h1>Pages</h1>
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
              value={text}
              onChange={(event) => {
                // Clamped here rather than by maxLength, which counts code
                // units and can keep half of an emoji.
                const value = clampPagesQuery(event.target.value);
                setText(value);
                listing.search(value);
              }}
            />
          </label>
        </form>
      </div>
      <div className="index-toolbar">
        <DisplayToggle mode={display} onChange={chooseDisplay} />
      </div>
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
        <Rows
          rows={rows}
          busy={view.searching}
          now={now}
          onOpen={onOpen}
          onOpenProject={onOpenProject}
          onWarm={onWarm}
        />
      )}
      <ListingFooter view={view} listing={listing} label="Pages" onRetry={onRetry} />
    </main>
  );
}

/** The window whose localStorage holds the display mode, when there is one. */
const browser = () => (typeof window === "undefined" ? undefined : window);

/** Grid or list, for /pages. */
function DisplayToggle({ mode, onChange }) {
  return (
    <div className="index-display" role="group" aria-label="Display">
      {DISPLAY_CHOICES.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          className="icon-button index-display-button"
          aria-label={label}
          aria-pressed={mode === value}
          onClick={() => onChange(value)}
        >
          <Icon aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
const DISPLAY_CHOICES = Object.freeze([
  { value: "grid", label: "Grid view", Icon: LayoutGrid },
  { value: "list", label: "List view", Icon: List },
]);

const PageIcon = ({ home, className, size }) =>
  home ? (
    <Home className={className} size={size} aria-hidden="true" />
  ) : (
    <FileText className={className} size={size} aria-hidden="true" />
  );

/** A row's Updated time: the compact label on screen, and the relative and
 * full local time for screen readers. */
function UpdatedTime({ value, now }) {
  const cell = timeCell(value, now);
  const Tag = cell.dateTime ? "time" : "span";
  return (
    <Tag className="index-time" dateTime={cell.dateTime ?? undefined}>
      <span aria-hidden="true">{cell.label}</span>
      <span className="sr-only">{cell.spoken}</span>
    </Tag>
  );
}

/** List mode: Name, Source and Updated columns. The column labels are
 * visual only; each cell names itself to assistive tech. The Name link
 * covers the row, and a Project label sits above it as its own link. */
function PageList({ rows, busy, now, onOpen, onOpenProject, onWarm }) {
  return (
    <div className="index-table">
      <div className="index-columns" aria-hidden="true">
        <span className="index-column-name">Name</span>
        <span className="index-column-source">Source</span>
        <span className="index-column-updated">Updated</span>
      </div>
      <ul className="index-list index-page-list" aria-label="All Pages" aria-busy={busy}>
        {rows.map((row) => (
          <li className="index-row index-page-row" key={row.id}>
            <div className="index-cell-name">
              <PageIcon home={row.home} className="index-row-icon" size={19} />
              <a
                className="index-row-link"
                href={row.href}
                onPointerDown={onWarm}
                onClick={follow(() => onOpen(row.id))}
              >
                {row.title}
              </a>
            </div>
            <div className="index-cell-source">
              {row.project ? (
                <a
                  className="index-row-project"
                  href={row.project.href}
                  aria-label={`Project ${row.project.title}`}
                  onClick={follow(() => onOpenProject(row.project.id))}
                >
                  <Boxes size={13} aria-hidden="true" />
                  <span>{row.project.title}</span>
                </a>
              ) : row.shared ? (
                <span className="index-row-shared">Shared</span>
              ) : (
                <span className="index-row-none" aria-hidden="true">
                  —
                </span>
              )}
            </div>
            <div className="index-cell-updated">
              <UpdatedTime value={row.updatedAt} now={now} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Grid mode: each card is one link to its Page, so it carries no Project
 * label (a link inside a link). */
function PageGrid({ rows, busy, onOpen, onWarm }) {
  return (
    <ul className="index-grid" aria-label="All Pages" aria-busy={busy}>
      {rows.map((row) => (
        <li className="index-card" key={row.id}>
          <a
            className="index-card-link"
            href={row.href}
            onPointerDown={onWarm}
            onClick={follow(() => onOpen(row.id))}
          >
            <span className="index-card-header">
              <PageIcon home={row.home} className="index-card-icon" size={16} />
              <span className="index-card-title" title={row.title}>
                {row.title}
              </span>
            </span>
            <PageCardPreview home={row.home} />
          </a>
        </li>
      ))}
    </ul>
  );
}
