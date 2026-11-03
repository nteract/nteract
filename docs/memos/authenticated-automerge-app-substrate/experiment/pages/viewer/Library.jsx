// The Pages library, at / and /pages: every Page the account can open, with
// tabs for All, Your items and Shared with you, a Project filter, a sort, and
// group sections over the rows it has loaded. It renders from the shell
// chunk; nothing here imports the editor.
//
// One Listing (listing.mjs) owns the request and its rows. React keeps local
// UI state only: the search box's text, the grouping and the display. The
// view (search, tab, Project, sort, grouping) lives in the address, which the
// owner writes through onViewChange: a choice pushes a history entry, so
// Back undoes it; a typed search replaces the entry. Back and Forward between
// two library addresses hand the mounted library its new `view`: a grouping
// alone changes nothing on the wire, and focus stays where it was.
//
// A first page this tab showed before paints from memory (listing-cache.mjs)
// while the Listing asks for it again, so a return visit within the cache's
// age limit never starts blank. What a shown page says besides its rows (the
// account's quota, the principal that answered) goes to onAnswer.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  Boxes,
  Copy,
  FileText,
  Home,
  LayoutGrid,
  List,
  Plus,
  Rows3,
  Search,
  Trash2,
} from "lucide-react";
import {
  LIBRARY_SORTS,
  clampPagesQuery,
  groupApplies,
  libraryRequest,
  libraryPath,
  normalizeLibraryView,
  sameLibraryRequest,
  sameLibraryView,
} from "../shared/routes.mjs";
import {
  Listing,
  deviceRows,
  listingView,
  pageRow,
  pagesRequest,
  projectTitles,
} from "./listing.mjs";
import { DEVICE_GROUP, groupRows } from "./library-groups.mjs";
import { listingCache } from "./listing-cache.mjs";
import { useStore } from "./store.mjs";
import { readDisplayMode, writeDisplayMode } from "./display-mode.mjs";
import { timeCell } from "./relative-time.mjs";
import { Clock } from "./clock.mjs";
import { PageCardPreview } from "./PageCardPreview.jsx";
import { ChoiceMenu } from "./ChoiceMenu.jsx";
import { IndexNav, ListingFooter, follow, useConnected } from "./IndexViews.jsx";

/** The tabs, list_pages' `access`. */
export const LIBRARY_TABS = Object.freeze([
  { access: null, label: "All" },
  { access: "owned", label: "Your items" },
  { access: "shared", label: "Shared with you" },
]);

/** Why the Project filter is unavailable on the shared tab. */
export const SHARED_PROJECT_REASON =
  "Projects hold only your own Pages. Switch to All or Your items to filter by Project.";
/** Why date groups are unavailable under the title sort. */
export const DATE_GROUP_REASON = "Sort by Last activity to group by date";
/** The Project menu's label for a `project` the account can't list. */
export const UNKNOWN_PROJECT = "Unknown Project";
/** list_pages' code for a `project_id` the account can't list: deleted,
 * someone else's, or mistyped (worker/spaces.mjs spaceNotFound). */
export const PROJECT_NOT_FOUND = "project_not_found";
/** What the library says about a Project filter it can't name. */
export const UNKNOWN_PROJECT_MESSAGE = "This Project isn't one you can open.";

/** What an empty listing says, for the view it listed. */
export function emptyMessage(params) {
  if (params.query) return `No Pages match “${params.query}”.`;
  if (params.projectId) return "No Pages in this Project.";
  if (params.access === "shared") return "Nothing is shared with you yet.";
  if (params.access === "owned") return "You have no Pages yet. Start one with New Page.";
  return "Start a page and write together.";
}

/** Whether a key press belongs to a field or editor rather than the page. */
const typing = (target) =>
  !!target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');

export function Library({
  tool,
  principal = null,
  view: shown,
  projects,
  drafts = [],
  notice = "",
  creating = false,
  grid = false,
  onNavigate,
  onViewChange,
  onOpen,
  onOpenProject,
  onCreate,
  onTrash,
  onCopyLink,
  onWarm,
  onError,
  onRetry,
  onAnswer,
  cache = listingCache,
  clock: givenClock,
}) {
  const start = useMemo(() => normalizeLibraryView(shown), []);
  const [text, setText] = useState(start.query);
  const [group, setGroup] = useState(start.group);
  const clock = useConnected(() => givenClock ?? new Clock());
  const now = useStore(clock.store);
  // The owner's latest callbacks, for the listing's subscription and replies.
  const latest = useRef(null);
  latest.current = { onViewChange, onAnswer, onError };
  const listing = useConnected(() => {
    const created = new Listing({
      fetch: pagesRequest(tool),
      // A Project the account can't list says so beside its filter, with
      // the way out, rather than in the banner.
      report: (message) => {
        if (created.snapshot().state.code !== PROJECT_NOT_FOUND) latest.current.onError(message);
      },
      idOf: (page) => page.page_id,
      cache: cache?.scope(principal) ?? null,
      onShown: ({ quota, principal: answeredBy }) =>
        latest.current.onAnswer?.({ quota, principal: answeredBy }),
    });
    return created;
  });
  // The request the address last showed. Mounting lists the route's own view,
  // so it never reports a change; a choice reports itself before it loads, and
  // a typed search is reported once it lists.
  const reported = useRef(libraryRequest(start));
  const groupNow = useRef(group);
  groupNow.current = group;
  useEffect(() => {
    reported.current = libraryRequest(start);
    listing.load(start);
    const subscription = listing.store
      .select((current) => current.state.params, sameLibraryRequest)
      .subscribe((listed) => {
        if (!listed || sameLibraryRequest(listed, reported.current)) return;
        reported.current = listed;
        latest.current.onViewChange(normalizeLibraryView({ ...listed, group: groupNow.current }), {
          replace: true,
        });
      });
    return () => subscription.unsubscribe();
  }, [listing]);
  // A new `view` from the owner (Back or Forward to another library address)
  // takes effect here; one this library reported itself already shows.
  const shownKey = libraryPath("/", normalizeLibraryView(shown));
  const applied = useRef(shownKey);
  useEffect(() => {
    if (applied.current === shownKey) return;
    applied.current = shownKey;
    const next = normalizeLibraryView(shown);
    setGroup(next.group);
    if (sameLibraryRequest(next, listing.params())) return;
    setText(next.query);
    reported.current = libraryRequest(next);
    listing.load(next);
  }, [shownKey, listing]);
  const snapshot = useStore(listing.store);
  const view = listingView(snapshot);
  // The params a choice starts from: what is listed, with the text typed so
  // far, so a choice made mid-search carries it. Choosing what already shows
  // (the current tab, say) does nothing, unless the listing failed.
  const choose = (patch) => {
    const current = normalizeLibraryView({ ...listing.params(), query: text, group });
    const next = normalizeLibraryView({ ...current, ...patch });
    if (sameLibraryView(next, current) && !view.failed) return;
    setGroup(next.group);
    reported.current = libraryRequest(next);
    applied.current = libraryPath("/", next);
    latest.current.onViewChange(next, { replace: false });
    if (!sameLibraryRequest(next, listing.params()) || view.failed) listing.load(next);
  };

  const [display, setDisplay] = useState(() => (grid ? readDisplayMode(browser()) : "list"));
  const chooseDisplay = useCallback((mode) => {
    const shown = writeDisplayMode(browser(), mode);
    if (shown) setDisplay(shown);
  }, []);

  const search = useRef(null);
  useEffect(() => {
    const focusSearch = (event) => {
      if (event.key !== "/" || event.defaultPrevented || event.metaKey || event.ctrlKey) return;
      if (event.altKey || typing(event.target) || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      search.current?.focus();
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);

  const params = view.params;
  const titles = useMemo(() => projectTitles(projects), [projects]);
  const items = view.failed ? EMPTY : snapshot.items;
  const local = useMemo(
    () => deviceRows(drafts, items, params, { failed: view.failed }),
    [drafts, items, params, view.failed],
  );
  const rows = useMemo(
    () => [
      ...local.map((page) => pageRow(page, titles, { local: true })),
      ...items.map((page) => pageRow(page, titles)),
    ],
    [local, items, titles],
  );
  const shownGroup = groupApplies(group, params.sort) ? group : null;
  const sections = useMemo(() => groupRows(rows, shownGroup, { now }), [rows, shownGroup, now]);

  // The controls show what was chosen, which a slow request hasn't listed yet.
  const chosen = normalizeLibraryView({ ...params, query: text, group });
  // A `project` list_pages refused as one the account can't list. The
  // account's Projects can't decide it: they are list_projects' first page,
  // and a Project created a moment ago may not be in them yet.
  const unknownProject =
    !!chosen.projectId &&
    view.failureCode === PROJECT_NOT_FOUND &&
    params.projectId === chosen.projectId;
  const projectChoices = useMemo(() => {
    const known = (projects ?? []).map((project) => ({
      value: project.project_id,
      label: project.title || "Untitled",
    }));
    if (chosen.projectId && !known.some((choice) => choice.value === chosen.projectId))
      known.unshift({
        value: chosen.projectId,
        label: unknownProject ? UNKNOWN_PROJECT : "Project",
      });
    return [{ value: null, label: "Any project" }, ...known];
  }, [projects, chosen.projectId, unknownProject]);
  const groupChoices = [
    { value: null, label: "None", short: "No grouping" },
    { value: "project", label: "Project", short: "By Project" },
    {
      value: "date",
      label: "Date",
      short: "By date",
      disabled: !groupApplies("date", chosen.sort),
      note: groupApplies("date", chosen.sort) ? null : DATE_GROUP_REASON,
    },
  ];
  const Rows = display === "grid" ? PageGrid : PageList;
  const empty = view.empty && rows.length === 0 && !unknownProject;
  return (
    <main className="page-library index-view library-view">
      <IndexNav current="pages" onNavigate={onNavigate} />
      <div className="library-header">
        {/* Phones hide it from view: the nav above already says Pages. */}
        <h1 className="library-title">Pages</h1>
        <form
          className="index-search library-search-form"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            // A search reports itself once it lists, like typing.
            listing.load({ ...listing.params(), query: text });
          }}
        >
          <label className="picker-search library-search">
            <Search size={18} aria-hidden="true" />
            <input
              ref={search}
              aria-label="Search Pages"
              aria-keyshortcuts="/"
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
            {!text && (
              <kbd className="library-search-key" aria-hidden="true">
                /
              </kbd>
            )}
          </label>
        </form>
        <div className="library-actions">
          <button className="subtle-button" onClick={onTrash}>
            <Trash2 size={16} aria-hidden="true" /> Trash
          </button>
          <button className="primary" onClick={onCreate} disabled={creating}>
            <Plus size={18} aria-hidden="true" /> New Page
          </button>
        </div>
      </div>
      <div className="library-controls">
        <div className="library-tabs" role="group" aria-label="Show">
          {LIBRARY_TABS.map(({ access, label }) => (
            <button
              key={label}
              type="button"
              className="library-tab"
              aria-pressed={chosen.access === access}
              onClick={() => choose(access === "owned" ? { access } : { access, projectId: null })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="library-options">
          <ChoiceMenu
            label="Project"
            icon={Boxes}
            align="start"
            choices={projectChoices}
            value={chosen.projectId}
            unavailable={chosen.access === "shared" ? SHARED_PROJECT_REASON : null}
            onChoose={(projectId) => choose({ projectId })}
          />
          <ChoiceMenu
            label="Sort"
            icon={ArrowDownUp}
            choices={LIBRARY_SORTS}
            value={chosen.sort}
            onChoose={(sort) => choose({ sort })}
          />
          <ChoiceMenu
            label="Group"
            icon={Rows3}
            choices={groupChoices}
            value={chosen.group}
            onChoose={(next) => choose({ group: next })}
          />
          {grid && <DisplayToggle mode={display} onChange={chooseDisplay} />}
        </div>
      </div>
      {notice && (
        <p className="muted quota-notice" role="status">
          {notice}
        </p>
      )}
      {unknownProject && (
        <p className="library-filter-notice" role="status">
          <span>{UNKNOWN_PROJECT_MESSAGE}</span>
          <button
            type="button"
            className="subtle-button"
            onClick={() => choose({ projectId: null })}
          >
            Clear Project filter
          </button>
        </p>
      )}
      {view.searching && (
        <p role="status" className="muted index-searching">
          {params.query || text ? "Searching…" : "Loading…"}
        </p>
      )}
      {view.loading && (
        <p role="status" className="muted index-status">
          Loading…
        </p>
      )}
      {view.failed && !unknownProject && (
        <p className="index-status">
          <button className="subtle-button" onClick={() => onRetry(() => listing.load(params))}>
            Try again
          </button>
        </p>
      )}
      {empty && <p className="muted index-status library-empty">{emptyMessage(params)}</p>}
      {rows.length > 0 && (
        <Rows
          sections={sections}
          grouping={shownGroup}
          busy={view.searching || view.refreshing}
          now={now}
          onOpen={onOpen}
          onOpenProject={onOpenProject}
          onCopyLink={onCopyLink}
          onWarm={onWarm}
        />
      )}
      {!view.failed && (
        <ListingFooter view={view} listing={listing} label="Pages" onRetry={onRetry} />
      )}
    </main>
  );
}

const EMPTY = Object.freeze([]);

/** The window whose localStorage holds the display mode, when there is one. */
const browser = () => (typeof window === "undefined" ? undefined : window);

/** Grid or list. Shown only when grid cards are enabled (feature-flags.mjs). */
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

/** A row's Last activity time: the compact label on screen, and the relative
 * and full local time for screen readers ("Last active 2 days ago, …"). */
function ActivityTime({ value, now }) {
  const cell = timeCell(value, now);
  const Tag = cell.dateTime ? "time" : "span";
  return (
    <Tag className="index-time" dateTime={cell.dateTime ?? undefined}>
      <span aria-hidden="true">{cell.label}</span>
      <span className="sr-only">{cell.spoken}</span>
    </Tag>
  );
}

/** A group's heading: its label (a Project links to the Project) and how
 * many of its rows have loaded. */
function GroupHeading({ id, section, onOpenProject }) {
  const count = section.rows.length;
  return (
    <h2 className="library-group-heading" id={id}>
      {section.href ? (
        <a
          className="library-group-label"
          href={section.href}
          onClick={follow(() => onOpenProject(section.projectId))}
        >
          <Boxes size={14} aria-hidden="true" />
          <span>{section.label}</span>
        </a>
      ) : (
        <span className="library-group-label">{section.label}</span>
      )}
      <span className="library-group-count">
        <span aria-hidden="true">{count}</span>
        <span className="sr-only">
          {count} {count === 1 ? "Page" : "Pages"}
        </span>
      </span>
    </h2>
  );
}

/** One section per group, or one unlabeled list. Each list is named for its
 * group, or "Pages". */
function Sections({ sections, onOpenProject, children }) {
  const prefix = useId();
  return sections.map((section, index) =>
    section.label === null ? (
      <div key={section.key}>{children(section, "Pages")}</div>
    ) : (
      <section key={section.key} className="library-group" aria-labelledby={`${prefix}-${index}`}>
        <GroupHeading id={`${prefix}-${index}`} section={section} onOpenProject={onOpenProject} />
        {children(section, section.label)}
      </section>
    ),
  );
}

/** Where a row comes from, in the Source column. A row only this browser
 * holds says "On this device", unless its group heading already does. */
function Source({ row, grouping, onOpenProject }) {
  if (row.local && grouping)
    return (
      <span className="index-row-none" aria-hidden="true">
        —
      </span>
    );
  if (row.local) return <span className="index-row-local">{DEVICE_GROUP.label}</span>;
  if (row.project)
    return (
      <a
        className="index-row-project"
        href={row.project.href}
        aria-label={`Project ${row.project.title}`}
        onClick={follow(() => onOpenProject(row.project.id))}
      >
        <Boxes size={13} aria-hidden="true" />
        <span>{row.project.title}</span>
      </a>
    );
  if (row.shared) return <span className="index-row-shared">Shared</span>;
  return (
    <span className="index-row-none" aria-hidden="true">
      —
    </span>
  );
}

/** List mode: Name, Source and Last activity columns, and a Copy link
 * action. The column labels are visual only; each cell names itself to
 * assistive tech. The Name link covers the row; the Project label and Copy
 * link sit above it as their own targets. Grouped by Project, the group
 * heading names each row's source, so the Source column goes. */
function PageList({ sections, grouping, busy, now, onOpen, onOpenProject, onCopyLink, onWarm }) {
  const source = grouping !== "project";
  return (
    <div
      className={`index-table library-results${source ? "" : " index-table-no-source"}`}
      aria-busy={busy}
    >
      <div className="index-columns" aria-hidden="true">
        <span className="index-column-name">Name</span>
        {source && <span className="index-column-source">Source</span>}
        <span className="index-column-updated">Last activity</span>
        <span />
      </div>
      <Sections sections={sections} onOpenProject={onOpenProject}>
        {(section, name) => (
          <ul className="index-list index-page-list" aria-label={name}>
            {section.rows.map((row) => (
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
                {source && (
                  <div className="index-cell-source">
                    <Source row={row} grouping={grouping} onOpenProject={onOpenProject} />
                  </div>
                )}
                <div className="index-cell-updated">
                  <ActivityTime value={row.activityAt} now={now} />
                </div>
                <div className="index-cell-actions">
                  <button
                    type="button"
                    className="icon-button index-row-action"
                    aria-label={`Copy link to ${row.title}`}
                    title="Copy link"
                    onClick={() => onCopyLink(row.id)}
                  >
                    <Copy size={16} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Sections>
    </div>
  );
}

/** Grid mode: each card is one link to its Page, so it carries no Project
 * label (a link inside a link). */
function PageGrid({ sections, busy, onOpen, onOpenProject, onWarm }) {
  return (
    <div className="library-results" aria-busy={busy}>
      <Sections sections={sections} onOpenProject={onOpenProject}>
        {(section, name) => (
          <ul className="index-grid" aria-label={name}>
            {section.rows.map((row) => (
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
        )}
      </Sections>
    </div>
  );
}
