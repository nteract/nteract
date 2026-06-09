import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  Clock3,
  Columns3,
  Command,
  Database,
  FilePlus2,
  Filter,
  FolderOpen,
  Globe2,
  Grid3X3,
  Inbox,
  ListFilter,
  ListTree,
  MoreHorizontal,
  PanelLeft,
  Pin,
  RefreshCw,
  Search,
  Server,
  Share2,
  Sparkles,
  Star,
  Table2,
  UserRound,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  accessLabel,
  computeLabel,
  dashboardCounts,
  displayTitle,
  notebooksForActivityBucket,
  notebooksForProject,
  pinnedNotebookIds,
  projectNames,
  shareLabel,
  sharingFacts,
  shortId,
  sortedNotebooks,
  workstationFacts,
  type NotebookFixture,
} from "./dashboard-data";

type FrameMode = "desktop" | "narrow";
type DesignId =
  | "switcher"
  | "triage"
  | "plain-list"
  | "document-home"
  | "inbox"
  | "cleanup-rail"
  | "workspace-filters"
  | "activity-log"
  | "finder-columns"
  | "pinned-recent"
  | "file-browser"
  | "strict-cards";

interface DesignDefinition {
  id: DesignId;
  priority: number;
  title: string;
  label: string;
  summary: string;
  reason: string;
  icon: typeof Search;
  Component: () => ReactNode;
}

const favoriteStorageKey = "nteract-cloud-dashboard-design-favorite";

const designs = [
  {
    id: "switcher",
    priority: 1,
    title: "Notebook Switcher First",
    label: "Switcher",
    summary: "Search-first home for dense notebook lists.",
    reason: "Best first prototype when testing notebooks drown the real work.",
    icon: Command,
    Component: NotebookSwitcherFirst,
  },
  {
    id: "triage",
    priority: 2,
    title: "Triage Buckets",
    label: "Triage",
    summary: "Recent, needs title, and published buckets.",
    reason: "Turns smoke-test clutter into a cleanup problem without hiding it.",
    icon: ListFilter,
    Component: TriageBuckets,
  },
  {
    id: "plain-list",
    priority: 3,
    title: "Plain Recent List",
    label: "Recent list",
    summary: "A quiet sortable-looking list with only durable facts.",
    reason: "Closest to the current app’s restraint and easiest to ship.",
    icon: Table2,
    Component: PlainRecentList,
  },
  {
    id: "document-home",
    priority: 4,
    title: "Document Home",
    label: "Document",
    summary: "Centered notebook home with one calm continuation path.",
    reason: "Keeps the page feeling like nteract rather than a SaaS dashboard.",
    icon: BookOpen,
    Component: DocumentHome,
  },
  {
    id: "inbox",
    priority: 5,
    title: "Inbox Style",
    label: "Inbox",
    summary: "Filters on the left, notebook messages on the right.",
    reason: "Good for repeated triage across a large notebook inventory.",
    icon: Inbox,
    Component: InboxStyle,
  },
  {
    id: "cleanup-rail",
    priority: 6,
    title: "Compact Recents + Cleanup Rail",
    label: "Cleanup rail",
    summary: "Recents stay primary; cleanup actions move to a side rail.",
    reason: "Keeps workstation and sharing facts app-level without prose blocks.",
    icon: PanelLeft,
    Component: CompactRecentsCleanupRail,
  },
  {
    id: "workspace-filters",
    priority: 7,
    title: "Workspace Filters",
    label: "Filters",
    summary: "Counts become filter chips instead of dashboard metrics.",
    reason: "Retains useful numbers while making them actionable.",
    icon: Filter,
    Component: WorkspaceFilters,
  },
  {
    id: "activity-log",
    priority: 8,
    title: "Activity Log",
    label: "Activity",
    summary: "Today, yesterday, and earlier groups.",
    reason: "Optimized for scanning what changed instead of reading cards.",
    icon: Clock3,
    Component: ActivityLog,
  },
  {
    id: "finder-columns",
    priority: 9,
    title: "Finder Columns",
    label: "Columns",
    summary: "Project, notebook, and details columns.",
    reason: "Useful when projects matter more than recency.",
    icon: Columns3,
    Component: FinderColumns,
  },
  {
    id: "pinned-recent",
    priority: 10,
    title: "Pinned + Recent",
    label: "Pinned",
    summary: "Pinned notebooks above a regular recent list.",
    reason: "Needs product support for pins, but solves smoke-noise directly.",
    icon: Pin,
    Component: PinnedAndRecent,
  },
  {
    id: "file-browser",
    priority: 11,
    title: "Bare File Browser",
    label: "Browser",
    summary: "Dense file-table treatment.",
    reason: "The least producty option and the easiest to read at volume.",
    icon: FolderOpen,
    Component: BareFileBrowser,
  },
  {
    id: "strict-cards",
    priority: 12,
    title: "Strict Cards",
    label: "Cards",
    summary: "Small notebook cards with no decorative treatment.",
    reason: "Kept as a lower-priority visual counterpoint.",
    icon: Grid3X3,
    Component: StrictCards,
  },
] as const satisfies readonly DesignDefinition[];

export function CloudDashboardDesignLab() {
  const [selectedId, setSelectedId] = useState<DesignId>(readSelectedDesign);
  const [favoriteId, setFavoriteId] = useState<DesignId | null>(readFavoriteDesign);
  const [frameMode, setFrameMode] = useState<FrameMode>("desktop");
  const selectedDesign = designs.find((design) => design.id === selectedId) ?? designs[0];
  const selectedIsFavorite = favoriteId === selectedDesign.id;

  function selectDesign(designId: DesignId) {
    setSelectedId(designId);
    window.localStorage.setItem("nteract-cloud-dashboard-selected-design", designId);
  }

  function toggleFavorite() {
    const nextFavorite = selectedIsFavorite ? null : selectedDesign.id;
    setFavoriteId(nextFavorite);
    if (nextFavorite) {
      window.localStorage.setItem(favoriteStorageKey, nextFavorite);
    } else {
      window.localStorage.removeItem(favoriteStorageKey);
    }
  }

  return (
    <main className="design-lab-shell">
      <aside className="design-lab-sidebar" aria-label="Dashboard designs">
        <div className="design-lab-brand">
          <span>nteract</span>
          <strong>Cloud dashboard designs</strong>
        </div>
        <ol className="design-list">
          {designs.map((design) => (
            <li key={design.id}>
              <button
                type="button"
                className="design-list-button"
                data-active={design.id === selectedDesign.id}
                onClick={() => selectDesign(design.id)}
              >
                <span className="design-list-rank">{design.priority}</span>
                <span className="design-list-main">
                  <span>{design.label}</span>
                  <small>{design.summary}</small>
                </span>
                {favoriteId === design.id ? (
                  <Star className="favorite-star" aria-hidden="true" />
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      </aside>

      <section className="design-lab-workspace">
        <header className="design-lab-toolbar">
          <div className="selected-design-heading">
            <span>Priority {selectedDesign.priority}</span>
            <h1>{selectedDesign.title}</h1>
            <p>{selectedDesign.reason}</p>
          </div>
          <div className="design-lab-actions">
            <div className="segmented-control" aria-label="Preview size">
              <button
                type="button"
                aria-pressed={frameMode === "desktop"}
                onClick={() => setFrameMode("desktop")}
              >
                Desktop
              </button>
              <button
                type="button"
                aria-pressed={frameMode === "narrow"}
                onClick={() => setFrameMode("narrow")}
              >
                Narrow
              </button>
            </div>
            <button
              type="button"
              className="favorite-button"
              data-active={selectedIsFavorite}
              onClick={toggleFavorite}
            >
              {selectedIsFavorite ? <Check aria-hidden="true" /> : <Star aria-hidden="true" />}
              {selectedIsFavorite ? "Picked" : "Pick"}
            </button>
          </div>
        </header>

        <div className="preview-stage" data-frame={frameMode}>
          <section className="preview-frame" data-design={selectedDesign.id}>
            <selectedDesign.Component />
          </section>
        </div>
      </section>
    </main>
  );
}

function readSelectedDesign(): DesignId {
  if (typeof window === "undefined") {
    return "switcher";
  }
  const selected = window.localStorage.getItem("nteract-cloud-dashboard-selected-design");
  return designs.some((design) => design.id === selected) ? (selected as DesignId) : "switcher";
}

function readFavoriteDesign(): DesignId | null {
  if (typeof window === "undefined") {
    return null;
  }
  const favorite = window.localStorage.getItem(favoriteStorageKey);
  return designs.some((design) => design.id === favorite) ? (favorite as DesignId) : null;
}

function NotebookSwitcherFirst() {
  const topNotebooks = sortedNotebooks.slice(0, 12);
  return (
    <DashboardChrome eyebrow="Notebook home" title="Find a notebook" variant="switcher">
      <div className="switcher-layout">
        <section className="switcher-main" aria-label="Notebook switcher">
          <label className="search-command">
            <Search aria-hidden="true" />
            <input value="revenue, smoke, renderer..." readOnly aria-label="Search notebooks" />
            <kbd>⌘K</kbd>
          </label>
          <div className="switcher-list">
            {topNotebooks.map((notebook) => (
              <CompactNotebookRow key={notebook.id} notebook={notebook} />
            ))}
          </div>
        </section>
        <aside className="quiet-side-panel" aria-label="Workspace summary">
          <ContinuePanel notebook={sortedNotebooks[0]} />
          <AppStatePanel />
        </aside>
      </div>
    </DashboardChrome>
  );
}

function TriageBuckets() {
  const untitled = sortedNotebooks.filter((notebook) => !notebook.title?.trim()).slice(0, 7);
  const recent = sortedNotebooks.slice(0, 7);
  const published = sortedNotebooks.filter((notebook) => notebook.shareState === "published");
  return (
    <DashboardChrome eyebrow="Notebook home" title="Notebook triage" variant="triage">
      <div className="bucket-grid">
        <Bucket title="Recent work" count={recent.length} icon={<Clock3 aria-hidden="true" />}>
          {recent.map((notebook) => (
            <SmallNotebookItem key={notebook.id} notebook={notebook} />
          ))}
        </Bucket>
        <Bucket title="Needs title" count={untitled.length} icon={<Sparkles aria-hidden="true" />}>
          {untitled.map((notebook) => (
            <SmallNotebookItem key={notebook.id} notebook={notebook} />
          ))}
        </Bucket>
        <Bucket title="Published" count={published.length} icon={<Globe2 aria-hidden="true" />}>
          {published.map((notebook) => (
            <SmallNotebookItem key={notebook.id} notebook={notebook} />
          ))}
        </Bucket>
      </div>
    </DashboardChrome>
  );
}

function PlainRecentList() {
  return (
    <DashboardChrome eyebrow="nteract" title="Notebook home" variant="plain-list" compact>
      <SummaryStrip />
      <section className="plain-list" aria-label="Recent notebooks">
        {sortedNotebooks.slice(0, 18).map((notebook) => (
          <DetailedNotebookRow key={notebook.id} notebook={notebook} />
        ))}
      </section>
    </DashboardChrome>
  );
}

function DocumentHome() {
  return (
    <DashboardChrome eyebrow="nteract" title="Notebook home" variant="document-home" compact>
      <div className="document-home">
        <ContinuePanel notebook={sortedNotebooks[0]} subdued />
        <section className="document-list" aria-label="Recent notebook documents">
          {sortedNotebooks.slice(0, 14).map((notebook) => (
            <DocumentNotebookRow key={notebook.id} notebook={notebook} />
          ))}
        </section>
      </div>
    </DashboardChrome>
  );
}

function InboxStyle() {
  const filters = [
    ["Recent", dashboardCounts.visible],
    ["Owned", dashboardCounts.owned],
    ["Shared", sharingFacts.shared],
    ["Published", dashboardCounts.published],
    ["Untitled", dashboardCounts.untitled],
  ] as const;
  return (
    <DashboardChrome eyebrow="Notebook home" title="Inbox" variant="inbox" compact>
      <div className="inbox-layout">
        <nav className="inbox-filters" aria-label="Notebook filters">
          {filters.map(([label, count], index) => (
            <button type="button" key={label} data-active={index === 0}>
              <span>{label}</span>
              <strong>{count}</strong>
            </button>
          ))}
        </nav>
        <section className="inbox-list" aria-label="Notebook inbox">
          {sortedNotebooks.slice(0, 16).map((notebook) => (
            <InboxNotebookRow key={notebook.id} notebook={notebook} />
          ))}
        </section>
      </div>
    </DashboardChrome>
  );
}

function CompactRecentsCleanupRail() {
  const untitled = sortedNotebooks.filter((notebook) => !notebook.title?.trim());
  return (
    <DashboardChrome
      eyebrow="Notebook home"
      title="Recent notebooks"
      variant="cleanup-rail"
      compact
    >
      <div className="cleanup-layout">
        <section className="plain-list" aria-label="Recent notebooks">
          {sortedNotebooks.slice(0, 12).map((notebook) => (
            <DetailedNotebookRow key={notebook.id} notebook={notebook} />
          ))}
        </section>
        <aside className="cleanup-panel" aria-label="Notebook actions">
          <ActionItem
            icon={<Sparkles aria-hidden="true" />}
            title="Title next"
            detail={`${untitled.length} untitled rooms`}
          />
          <ActionItem
            icon={<Globe2 aria-hidden="true" />}
            title="Published"
            detail={`${sharingFacts.published} revision previews`}
          />
          <ActionItem
            icon={<Server aria-hidden="true" />}
            title={workstationFacts.defaultName}
            detail={workstationFacts.status}
          />
        </aside>
      </div>
    </DashboardChrome>
  );
}

function WorkspaceFilters() {
  const filters = [
    ["All", dashboardCounts.visible],
    ["Owned", dashboardCounts.owned],
    ["Editable", dashboardCounts.editable],
    ["Published", dashboardCounts.published],
    ["Untitled", dashboardCounts.untitled],
  ] as const;
  return (
    <DashboardChrome eyebrow="Workspace" title="Notebooks" variant="workspace-filters" compact>
      <section className="filter-strip" aria-label="Notebook filters">
        {filters.map(([label, count], index) => (
          <button type="button" key={label} data-active={index === 0}>
            <span>{label}</span>
            <strong>{count}</strong>
          </button>
        ))}
      </section>
      <section className="plain-list" aria-label="Filtered notebooks">
        {sortedNotebooks.slice(0, 15).map((notebook) => (
          <DetailedNotebookRow key={notebook.id} notebook={notebook} />
        ))}
      </section>
    </DashboardChrome>
  );
}

function ActivityLog() {
  return (
    <DashboardChrome eyebrow="Notebook home" title="Activity" variant="activity-log" compact>
      <div className="activity-sections">
        <ActivitySection title="Today" notebooks={notebooksForActivityBucket("today")} />
        <ActivitySection title="Yesterday" notebooks={notebooksForActivityBucket("yesterday")} />
        <ActivitySection
          title="Earlier"
          notebooks={notebooksForActivityBucket("earlier").slice(0, 8)}
        />
      </div>
    </DashboardChrome>
  );
}

function FinderColumns() {
  const selectedProject = projectNames[0];
  const projectNotebooks = notebooksForProject(selectedProject);
  const selectedNotebook = projectNotebooks[0] ?? sortedNotebooks[0];
  return (
    <DashboardChrome
      eyebrow="Notebook home"
      title="Browse by project"
      variant="finder-columns"
      compact
    >
      <div className="finder-layout">
        <section className="finder-column" aria-label="Projects">
          {projectNames.map((project, index) => (
            <button key={project} type="button" data-active={index === 0}>
              <FolderOpen aria-hidden="true" />
              <span>{project}</span>
              <strong>{notebooksForProject(project).length}</strong>
            </button>
          ))}
        </section>
        <section className="finder-column" aria-label="Project notebooks">
          {projectNotebooks.map((notebook, index) => (
            <button key={notebook.id} type="button" data-active={index === 0}>
              <BookOpen aria-hidden="true" />
              <span>{displayTitle(notebook)}</span>
            </button>
          ))}
        </section>
        <aside className="finder-detail" aria-label="Selected notebook">
          <span>{selectedNotebook.project}</span>
          <h2>{displayTitle(selectedNotebook)}</h2>
          <p>{selectedNotebook.summary}</p>
          <dl>
            <div>
              <dt>Access</dt>
              <dd>{accessLabel(selectedNotebook)}</dd>
            </div>
            <div>
              <dt>Sharing</dt>
              <dd>{shareLabel(selectedNotebook)}</dd>
            </div>
            <div>
              <dt>Compute</dt>
              <dd>{computeLabel(selectedNotebook)}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </DashboardChrome>
  );
}

function PinnedAndRecent() {
  const pinned = sortedNotebooks.filter((notebook) =>
    pinnedNotebookIds.includes(notebook.id as (typeof pinnedNotebookIds)[number]),
  );
  return (
    <DashboardChrome
      eyebrow="Notebook home"
      title="Pinned and recent"
      variant="pinned-recent"
      compact
    >
      <section className="pinned-grid" aria-label="Pinned notebooks">
        {pinned.map((notebook) => (
          <PinnedCard key={notebook.id} notebook={notebook} />
        ))}
      </section>
      <section className="plain-list" aria-label="Recent notebooks">
        {sortedNotebooks.slice(0, 12).map((notebook) => (
          <DetailedNotebookRow key={notebook.id} notebook={notebook} />
        ))}
      </section>
    </DashboardChrome>
  );
}

function BareFileBrowser() {
  return (
    <DashboardChrome eyebrow="Notebook home" title="Files" variant="file-browser" compact>
      <div className="file-toolbar" aria-label="File browser controls">
        <button type="button">
          <ListTree aria-hidden="true" />
          Name
        </button>
        <button type="button">
          <Clock3 aria-hidden="true" />
          Modified
        </button>
        <button type="button">
          <MoreHorizontal aria-hidden="true" />
        </button>
      </div>
      <table className="file-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Access</th>
            <th>Share</th>
            <th>Modified</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {sortedNotebooks.slice(0, 18).map((notebook) => (
            <tr key={notebook.id}>
              <td>
                <span>{displayTitle(notebook)}</span>
                <small>{shortId(notebook)}</small>
              </td>
              <td>{accessLabel(notebook)}</td>
              <td>{shareLabel(notebook)}</td>
              <td>{notebook.updatedLabel}</td>
              <td>
                <ArrowUpRight aria-hidden="true" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </DashboardChrome>
  );
}

function StrictCards() {
  return (
    <DashboardChrome eyebrow="Notebook home" title="Notebook cards" variant="strict-cards" compact>
      <section className="strict-card-grid" aria-label="Notebook cards">
        {sortedNotebooks.slice(0, 12).map((notebook) => (
          <StrictNotebookCard key={notebook.id} notebook={notebook} />
        ))}
      </section>
    </DashboardChrome>
  );
}

function DashboardChrome({
  eyebrow,
  title,
  children,
  compact = false,
  variant,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  compact?: boolean;
  variant: DesignId;
}) {
  return (
    <div className="dashboard-prototype" data-compact={compact} data-variant={variant}>
      <header className="prototype-header">
        <div>
          <a href="/" aria-label="nteract home">
            {eyebrow}
          </a>
          <h2>{title}</h2>
        </div>
        <div className="prototype-actions">
          <button type="button" aria-label="Refresh">
            <RefreshCw aria-hidden="true" />
          </button>
          <button type="button" aria-label="New notebook">
            <FilePlus2 aria-hidden="true" />
          </button>
          <button type="button" aria-label="Account">
            <UserRound aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="prototype-body">{children}</div>
    </div>
  );
}

function SummaryStrip() {
  const stats = [
    ["Visible", dashboardCounts.visible],
    ["Owned", dashboardCounts.owned],
    ["Published", dashboardCounts.published],
    ["Untitled", dashboardCounts.untitled],
  ] as const;
  return (
    <section className="summary-strip" aria-label="Notebook summary">
      {stats.map(([label, count]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{count}</strong>
        </div>
      ))}
    </section>
  );
}

function ContinuePanel({
  notebook,
  subdued = false,
}: {
  notebook: NotebookFixture;
  subdued?: boolean;
}) {
  return (
    <section className="continue-panel" data-subdued={subdued} aria-label="Continue notebook">
      <span>Continue</span>
      <h3>{displayTitle(notebook)}</h3>
      <p>{notebook.summary}</p>
      <div className="inline-meta">
        <Meta icon={<Clock3 aria-hidden="true" />} label={notebook.updatedLabel} />
        <Meta icon={<UserRound aria-hidden="true" />} label={accessLabel(notebook)} />
        <Meta icon={<Share2 aria-hidden="true" />} label={shareLabel(notebook)} />
      </div>
      <button type="button">
        Open
        <ArrowRight aria-hidden="true" />
      </button>
    </section>
  );
}

function AppStatePanel() {
  return (
    <section className="app-state-panel" aria-label="Workspace state">
      <div>
        <Server aria-hidden="true" />
        <span>{workstationFacts.defaultName}</span>
        <strong>{workstationFacts.status}</strong>
      </div>
      <p>{workstationFacts.detail}</p>
      <div>
        <Globe2 aria-hidden="true" />
        <span>Published previews</span>
        <strong>{sharingFacts.published}</strong>
      </div>
    </section>
  );
}

function Bucket({
  title,
  count,
  icon,
  children,
}: {
  title: string;
  count: number;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="bucket-panel">
      <header>
        {icon}
        <h3>{title}</h3>
        <strong>{count}</strong>
      </header>
      <div>{children}</div>
    </section>
  );
}

function ActionItem({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <button type="button" className="action-item">
      {icon}
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <ArrowRight aria-hidden="true" />
    </button>
  );
}

function ActivitySection({
  title,
  notebooks,
}: {
  title: string;
  notebooks: readonly NotebookFixture[];
}) {
  return (
    <section className="activity-section">
      <h3>{title}</h3>
      <div>
        {notebooks.map((notebook) => (
          <ActivityNotebookRow key={notebook.id} notebook={notebook} />
        ))}
      </div>
    </section>
  );
}

function CompactNotebookRow({ notebook }: { notebook: NotebookFixture }) {
  return (
    <button type="button" className="compact-row">
      <BookOpen aria-hidden="true" />
      <span>
        <strong>{displayTitle(notebook)}</strong>
        <small>
          {notebook.project} · {notebook.updatedLabel}
        </small>
      </span>
      <ShareState notebook={notebook} />
    </button>
  );
}

function DetailedNotebookRow({ notebook }: { notebook: NotebookFixture }) {
  return (
    <article className="detailed-row">
      <a href="/" aria-label={`Open ${displayTitle(notebook)}`}>
        <strong>{displayTitle(notebook)}</strong>
        <span>{notebook.summary}</span>
        <span className="inline-meta">
          <Meta icon={<UserRound aria-hidden="true" />} label={accessLabel(notebook)} />
          <Meta icon={<Share2 aria-hidden="true" />} label={shareLabel(notebook)} />
          <Meta icon={<Database aria-hidden="true" />} label={computeLabel(notebook)} />
        </span>
      </a>
      <time>{notebook.updatedLabel}</time>
      <button type="button" aria-label={`Open ${displayTitle(notebook)}`}>
        <ArrowUpRight aria-hidden="true" />
      </button>
    </article>
  );
}

function DocumentNotebookRow({ notebook }: { notebook: NotebookFixture }) {
  return (
    <article className="document-row">
      <BookOpen aria-hidden="true" />
      <a href="/">
        <strong>{displayTitle(notebook)}</strong>
        <span>
          {notebook.project} · {notebook.updatedLabel}
        </span>
      </a>
      <ShareState notebook={notebook} />
    </article>
  );
}

function InboxNotebookRow({ notebook }: { notebook: NotebookFixture }) {
  return (
    <article className="inbox-row">
      <span className="inbox-dot" data-share={notebook.shareState} />
      <a href="/">
        <strong>{displayTitle(notebook)}</strong>
        <span>{notebook.summary}</span>
      </a>
      <span>{notebook.project}</span>
      <time>{notebook.updatedLabel}</time>
    </article>
  );
}

function SmallNotebookItem({ notebook }: { notebook: NotebookFixture }) {
  return (
    <a className="small-notebook-item" href="/">
      <span>
        <strong>{displayTitle(notebook)}</strong>
        <small>
          {notebook.project} · {notebook.updatedLabel}
        </small>
      </span>
      <ArrowUpRight aria-hidden="true" />
    </a>
  );
}

function ActivityNotebookRow({ notebook }: { notebook: NotebookFixture }) {
  return (
    <article className="activity-row">
      <time>{notebook.updatedLabel}</time>
      <a href="/">
        <strong>{displayTitle(notebook)}</strong>
        <span>{notebook.project}</span>
      </a>
      <ShareState notebook={notebook} />
    </article>
  );
}

function PinnedCard({ notebook }: { notebook: NotebookFixture }) {
  return (
    <article className="pinned-card">
      <Pin aria-hidden="true" />
      <a href="/">
        <strong>{displayTitle(notebook)}</strong>
        <span>{notebook.summary}</span>
      </a>
      <span>{notebook.updatedLabel}</span>
    </article>
  );
}

function StrictNotebookCard({ notebook }: { notebook: NotebookFixture }) {
  return (
    <article className="strict-card">
      <header>
        <BookOpen aria-hidden="true" />
        <ShareState notebook={notebook} />
      </header>
      <a href="/">{displayTitle(notebook)}</a>
      <p>{notebook.summary}</p>
      <footer>
        <span>{accessLabel(notebook)}</span>
        <time>{notebook.updatedLabel}</time>
      </footer>
    </article>
  );
}

function ShareState({ notebook }: { notebook: NotebookFixture }) {
  return (
    <span className="share-state" data-share={notebook.shareState}>
      {notebook.shareState === "published" ? (
        <Globe2 aria-hidden="true" />
      ) : (
        <Share2 aria-hidden="true" />
      )}
      {shareLabel(notebook)}
    </span>
  );
}

function Meta({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span>
      {icon}
      {label}
    </span>
  );
}
