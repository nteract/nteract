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
// In grid mode each card loads its Page's card preview as it scrolls into
// view (page-cards.mjs); the loader lives as long as this mount.
//
// Group headings fold their rows. Which groups are folded is local UI state,
// kept per account and grouping in this browser (library-folds.mjs), so a
// fold survives a reload, Load more and rows that join the group later.
//
// The heading row, the tabs and the menus never move with the results. The
// results sit in one body with a fixed floor: loading, empty and failed
// states share one box there, and a new request shows as a bar along the
// control row and dimmed rows, never as a line pushed in above them.
//
// A first page this tab showed before paints from memory (listing-cache.mjs)
// while the Listing asks for it again, so a return visit within the cache's
// age limit never starts blank. What a shown page says besides its rows (the
// account's quota, the principal that answered) goes to onAnswer.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  ArrowUpRight,
  Boxes,
  CalendarDays,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FileText,
  HardDrive,
  LayoutGrid,
  List,
  Plus,
  Rows3,
  Search,
  Trash2,
  UserRound,
  Users,
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
import { DEVICE_GROUP, groupAccent, groupRows } from "./library-groups.mjs";
import {
  allFolded,
  foldAll,
  readFolds,
  toggleFold,
  unfoldAll,
  writeFolds,
} from "./library-folds.mjs";
import { listingCache } from "./listing-cache.mjs";
import { useStore } from "./store.mjs";
import { readDisplayMode, writeDisplayMode } from "./display-mode.mjs";
import { timeCell } from "./relative-time.mjs";
import { Clock } from "./clock.mjs";
import { PageCardPreview } from "./PageCardPreview.jsx";
import { IDLE_CARD, PageCards, cardKeyOf } from "./page-cards.mjs";
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
/** The Group menu's actions over every shown group. */
export const FOLD_ALL = "Fold all";
export const UNFOLD_ALL = "Unfold all";
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

  const [display, setDisplay] = useState(() => readDisplayMode(browser()));
  // Card previews for grid mode, one loader per mount. List mode never asks,
  // and neither does a grid that doesn't know its account.
  const cards = useConnected(() => new PageCards({ tool, principal }));
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
  const contents = useMemo(
    () => new Set((projects ?? []).map((project) => project.document_id).filter(Boolean)),
    [projects],
  );
  const local = useMemo(
    () => deviceRows(drafts, items, params, { failed: view.failed, contents }),
    [drafts, items, params, view.failed, contents],
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
  // Folds for the grouping that shows. The account this library listed for
  // owns them; one it doesn't know folds for this visit only.
  const [folds, setFolds] = useState(() => readFolds(browser(), principal));
  const folded = shownGroup ? (folds[shownGroup] ?? EMPTY) : EMPTY;
  const shownKeys = useMemo(
    () => sections.filter((section) => section.label !== null).map((section) => section.key),
    [sections],
  );
  const changeFolds = (next) => {
    if (!shownGroup) return;
    const kept = writeFolds(browser(), principal, shownGroup, next);
    setFolds((current) => ({ ...current, [shownGroup]: kept }));
  };
  const toggleGroup = (key) => changeFolds(toggleFold(folded, key));

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
  const foldActions = shownGroup
    ? [
        {
          label: FOLD_ALL,
          icon: ChevronsDownUp,
          disabled: allFolded(folded, shownKeys),
          onSelect: () => changeFolds(foldAll(folded, shownKeys)),
        },
        {
          label: UNFOLD_ALL,
          icon: ChevronsUpDown,
          disabled: folded.length === 0,
          onSelect: () => changeFolds(unfoldAll()),
        },
      ]
    : EMPTY;
  const Rows = display === "grid" ? PageGrid : PageList;
  const empty = view.empty && rows.length === 0 && !unknownProject;
  // A request for another view: the bar runs and the rows it replaces dim.
  const pending = view.loading || view.searching;
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
            actions={foldActions}
          />
          <DisplayToggle mode={display} onChange={chooseDisplay} />
        </div>
        <span className="library-progress" data-active={pending} aria-hidden="true" />
      </div>
      {notice && (
        <p className="muted quota-notice" role="status">
          {notice}
        </p>
      )}
      <div className="library-body" data-stale={view.searching}>
        {/* Announces a request over rows that still show; the bar above is
            its visible half. */}
        <p className="sr-only" role="status">
          {view.searching ? (params.query || text ? "Searching…" : "Loading…") : ""}
        </p>
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
        {view.loading && (
          <p role="status" className="muted index-status library-state">
            Loading…
          </p>
        )}
        {view.failed && !unknownProject && (
          <p className="index-status library-state">
            <button className="subtle-button" onClick={() => onRetry(() => listing.load(params))}>
              Try again
            </button>
          </p>
        )}
        {empty && (
          <p className="muted index-status library-empty library-state">{emptyMessage(params)}</p>
        )}
        {rows.length > 0 && (
          <Rows
            sections={sections}
            grouping={shownGroup}
            folded={folded}
            onToggle={toggleGroup}
            busy={view.searching || view.refreshing}
            now={now}
            onOpen={onOpen}
            onOpenProject={onOpenProject}
            onCopyLink={onCopyLink}
            onWarm={onWarm}
            cards={cards}
          />
        )}
        {!view.failed && (
          <ListingFooter view={view} listing={listing} label="Pages" onRetry={onRetry} />
        )}
      </div>
    </main>
  );
}

const EMPTY = Object.freeze([]);

/** The window whose localStorage holds the display mode, when there is one. */
const browser = () => (typeof window === "undefined" ? undefined : window);

/** Grid or list, remembered for this browser. */
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

/** The icon beside a group's label, by its accent (groupAccent). */
const GROUP_ICONS = Object.freeze({
  shared: Users,
  device: HardDrive,
  items: UserRound,
  date: CalendarDays,
});

/** A group's heading: a disclosure button that folds the group's rows, with
 * its label and how many of its rows have loaded, which stay when folded. A
 * Project group links to its Project beside the button. The accent (a bar,
 * a tint and the label's color) helps the eye; the label names the group. */
function GroupHeading({ labelId, listId, section, folded, onToggle, onOpenProject }) {
  const count = section.rows.length;
  const { accent, recency } = groupAccent(section);
  const Icon = GROUP_ICONS[accent] ?? Boxes;
  return (
    <h2 className="library-group-heading" data-accent={accent} data-recency={recency ?? undefined}>
      <button
        type="button"
        className="library-group-toggle"
        aria-expanded={!folded}
        aria-controls={listId}
        onClick={() => onToggle(section.key)}
      >
        <ChevronRight className="library-group-chevron" size={16} aria-hidden="true" />
        <Icon className="library-group-icon" size={14} aria-hidden="true" />
        <span className="library-group-label" id={labelId}>
          {section.label}
        </span>
        <span className="library-group-count">
          <span aria-hidden="true">{count}</span>
          <span className="sr-only">
            {count} {count === 1 ? "Page" : "Pages"}
          </span>
        </span>
      </button>
      {section.href && (
        <a
          className="icon-button library-group-open"
          href={section.href}
          aria-label={`Open Project ${section.label}`}
          title="Open Project"
          onClick={follow(() => onOpenProject(section.projectId))}
        >
          <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      )}
    </h2>
  );
}

/** One section per group, or one unlabeled list. Each list is named for its
 * group, or "Pages". `children(section, name, list)` draws a section's list;
 * `list` holds its `id` and whether it is `folded`, when it draws nothing
 * but the empty, hidden list its heading controls. */
function Sections({ sections, folded, onToggle, onOpenProject, children }) {
  const prefix = useId();
  return sections.map((section, index) => {
    if (section.label === null)
      return (
        <div key={section.key}>{children(section, "Pages", { id: undefined, folded: false })}</div>
      );
    const shut = folded.includes(section.key);
    const list = { id: `${prefix}-list-${index}`, folded: shut };
    return (
      <section
        key={section.key}
        className="library-group"
        data-folded={shut}
        aria-labelledby={`${prefix}-label-${index}`}
      >
        <GroupHeading
          labelId={`${prefix}-label-${index}`}
          listId={list.id}
          section={section}
          folded={shut}
          onToggle={onToggle}
          onOpenProject={onOpenProject}
        />
        {children(section, section.label, list)}
      </section>
    );
  });
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
function PageList({
  sections,
  grouping,
  folded,
  onToggle,
  busy,
  now,
  onOpen,
  onOpenProject,
  onCopyLink,
  onWarm,
}) {
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
      <Sections
        sections={sections}
        folded={folded}
        onToggle={onToggle}
        onOpenProject={onOpenProject}
      >
        {(section, name, list) => (
          <ul
            className="index-list index-page-list"
            aria-label={name}
            id={list.id}
            hidden={list.folded}
          >
            {(list.folded ? EMPTY : section.rows).map((row) => (
              <li className="index-row index-page-row" key={row.id}>
                <div className="index-cell-name">
                  <FileText className="index-row-icon" size={19} aria-hidden="true" />
                  <a
                    className="index-row-link"
                    href={row.href}
                    onPointerDown={onWarm}
                    onClick={follow(() => onOpen(row.id, { slug: row.slug }))}
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
                    onClick={() => onCopyLink(row.id, row.href)}
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
function PageGrid({ sections, folded, onToggle, busy, onOpen, onOpenProject, onWarm, cards }) {
  // The order batches top up in (page-cards.mjs): the cards as shown, which
  // leaves out a folded group's.
  useEffect(
    () =>
      cards.arrange(
        sections.flatMap((section) => (folded.includes(section.key) ? [] : section.rows)),
      ),
    [cards, sections, folded],
  );
  return (
    <div className="library-results" aria-busy={busy}>
      <Sections
        sections={sections}
        folded={folded}
        onToggle={onToggle}
        onOpenProject={onOpenProject}
      >
        {(section, name, list) => (
          <ul className="index-grid" aria-label={name} id={list.id} hidden={list.folded}>
            {(list.folded ? EMPTY : section.rows).map((row) => (
              <GridCard key={row.id} row={row} cards={cards} onOpen={onOpen} onWarm={onWarm} />
            ))}
          </ul>
        )}
      </Sections>
    </div>
  );
}

/** One grid card. A row the server listed asks for its card once it nears
 * the viewport; a row only this browser holds has none to ask for. */
function GridCard({ row, cards, onOpen, onWarm }) {
  const element = useRef(null);
  const key = cardKeyOf(row);
  const listed = !row.local;
  useEffect(
    () => (listed ? cards.observe(element.current, row) : undefined),
    // `row` is read when the key changes; its other fields don't change the ask.
    [cards, key, listed],
  );
  const state = useStore(cards.store, (current) => current.get(key) ?? IDLE_CARD);
  return (
    <li className="index-card" ref={element}>
      <a
        className="index-card-link"
        href={row.href}
        onPointerDown={onWarm}
        onClick={follow(() => onOpen(row.id, { slug: row.slug }))}
      >
        <span className="index-card-header">
          <FileText className="index-card-icon" size={16} aria-hidden="true" />
          <span className="index-card-title" title={row.title}>
            {row.title}
          </span>
        </span>
        <PageCardPreview card={state.name === "shown" ? state.card : null} />
      </a>
    </li>
  );
}
