import { useMemo, useState, type FormEvent } from "react";
import {
  BookOpen,
  Check,
  Clock,
  ExternalLink,
  Loader2,
  PencilLine,
  Search,
  Share2,
  UserRound,
  X,
} from "lucide-react";
import {
  cloudNotebookDisplayTitle,
  cloudNotebookShortId,
  projectCloudNotebookDashboardView,
  type CloudNotebookDashboardFilterId,
  type CloudNotebookDashboardModel,
  type CloudNotebookDashboardRow,
  type CloudNotebookDashboardRowFact,
  type CloudNotebookDashboardSection,
  type CloudNotebookListItem,
} from "./notebook-dashboard";

interface CloudNotebookDashboardRenameState {
  notebookId: string;
  title: string;
}

export function CloudNotebookDashboard({
  model,
  canRename,
  renameState,
  renameSavingId,
  onOpenRename,
  onCancelRename,
  onRenameTitleChange,
  onSaveRename,
}: {
  model: CloudNotebookDashboardModel;
  canRename: boolean;
  renameState: CloudNotebookDashboardRenameState | null;
  renameSavingId: string | null;
  onOpenRename: (notebook: CloudNotebookListItem) => void;
  onCancelRename: () => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const continued = model.continueRow;
  const [query, setQuery] = useState("");
  const [filterId, setFilterId] = useState<CloudNotebookDashboardFilterId>("all");
  const view = useMemo(
    () => projectCloudNotebookDashboardView(model, { filterId, query }),
    [filterId, model, query],
  );

  return (
    <div className="cloud-dashboard">
      {continued ? (
        <section className="cloud-dashboard-continue" aria-labelledby="cloud-dashboard-continue">
          <div className="cloud-dashboard-continue-main">
            <p>Continue</p>
            <h2 id="cloud-dashboard-continue">{cloudNotebookDisplayTitle(continued.notebook)}</h2>
            <div className="cloud-dashboard-continue-facts">
              <span>
                <Clock aria-hidden="true" />
                {formatNotebookUpdatedAt(continued.notebook.updated_at)}
              </span>
              {continued.facts.map((fact) => (
                <CloudNotebookDashboardFact key={fact.kind} fact={fact} />
              ))}
            </div>
          </div>
          <a className="cloud-dashboard-primary-link" href={continued.notebook.viewer_url}>
            Open notebook
            <ExternalLink aria-hidden="true" />
          </a>
        </section>
      ) : null}
      <section className="cloud-dashboard-switcher" aria-label="Notebook home">
        <section className="cloud-dashboard-main" aria-label="Notebook switcher">
          <div className="cloud-dashboard-search-row">
            <label className="cloud-dashboard-search">
              <Search aria-hidden="true" />
              <input
                type="search"
                value={query}
                placeholder="Search notebooks"
                aria-label="Search notebooks"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            {view.showResultCount ? (
              <span className="cloud-dashboard-result-count" aria-live="polite">
                {view.resultCount} notebook{view.resultCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          <nav className="cloud-dashboard-filters" aria-label="Notebook filters">
            {view.filterGroups.map((group) => (
              <div
                key={group.id}
                className="cloud-dashboard-filter-group"
                data-group={group.id}
                aria-label={group.label}
              >
                {group.filters.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    aria-label={`${filter.label}: ${filter.count} notebook${
                      filter.count === 1 ? "" : "s"
                    }`}
                    aria-pressed={view.filterId === filter.id}
                    data-active={view.filterId === filter.id ? "true" : undefined}
                    onClick={() => setFilterId(filter.id)}
                  >
                    <span>{filter.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          {view.sections.length > 0 ? (
            <div className="cloud-dashboard-notebooks">
              {view.sections.map((section) => (
                <CloudNotebookDashboardSectionView
                  key={section.id}
                  section={section}
                  canRename={canRename}
                  renameState={renameState}
                  renameSavingId={renameSavingId}
                  onOpenRename={onOpenRename}
                  onCancelRename={onCancelRename}
                  onSelectFilter={setFilterId}
                  onRenameTitleChange={onRenameTitleChange}
                  onSaveRename={onSaveRename}
                />
              ))}
            </div>
          ) : (
            <div className="cloud-notebook-list-state" data-kind="empty" role="status">
              <BookOpen aria-hidden="true" />
              <span>{view.emptyMessage}</span>
            </div>
          )}
        </section>
      </section>
    </div>
  );
}

function CloudNotebookDashboardSectionView({
  section,
  canRename,
  renameState,
  renameSavingId,
  onOpenRename,
  onCancelRename,
  onSelectFilter,
  onRenameTitleChange,
  onSaveRename,
}: {
  section: CloudNotebookDashboardSection;
  canRename: boolean;
  renameState: CloudNotebookDashboardRenameState | null;
  renameSavingId: string | null;
  onOpenRename: (notebook: CloudNotebookListItem) => void;
  onCancelRename: () => void;
  onSelectFilter: (filterId: CloudNotebookDashboardFilterId) => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const action = section.action?.kind === "rename" && !canRename ? null : section.action;
  const hiddenCount = Math.max(0, section.totalCount - section.notebooks.length);
  const overflowAction = section.overflowAction;
  const actionAlreadyReviewsOverflow =
    action?.kind === "filter" && action.filterId === overflowAction?.filterId;

  return (
    <section className="cloud-dashboard-notebook-section" data-section={section.id}>
      <div className="cloud-dashboard-section-heading">
        <div>
          <h2>{section.title}</h2>
          <p>{section.detail}</p>
        </div>
        {action?.kind === "rename" ? (
          <button
            type="button"
            className="cloud-dashboard-section-action"
            onClick={() => onOpenRename(action.notebook)}
          >
            <PencilLine aria-hidden="true" />
            {action.label}
          </button>
        ) : action?.kind === "filter" ? (
          <button
            type="button"
            className="cloud-dashboard-section-action"
            onClick={() => onSelectFilter(action.filterId)}
          >
            {action.label}
          </button>
        ) : null}
      </div>
      <ul className="cloud-notebook-list">
        {section.rows.map((row) => (
          <li key={row.notebook.notebook_id}>
            <CloudNotebookDashboardRow
              row={row}
              canRename={canRename}
              renameTitle={
                renameState?.notebookId === row.notebook.notebook_id ? renameState.title : null
              }
              renameSaving={renameSavingId === row.notebook.notebook_id}
              onOpenRename={onOpenRename}
              onCancelRename={onCancelRename}
              onRenameTitleChange={onRenameTitleChange}
              onSaveRename={onSaveRename}
            />
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && overflowAction ? (
        <p className="cloud-dashboard-section-footnote">
          Showing {section.notebooks.length} of {section.totalCount}.
          {actionAlreadyReviewsOverflow ? null : (
            <>
              {" "}
              Use the{" "}
              <button type="button" onClick={() => onSelectFilter(overflowAction.filterId)}>
                {overflowAction.label}
              </button>{" "}
              filter to review the rest.
            </>
          )}
        </p>
      ) : null}
    </section>
  );
}

function CloudNotebookDashboardRow({
  row,
  canRename,
  renameTitle,
  renameSaving,
  onOpenRename,
  onCancelRename,
  onRenameTitleChange,
  onSaveRename,
}: {
  row: CloudNotebookDashboardRow;
  canRename: boolean;
  renameTitle: string | null;
  renameSaving: boolean;
  onOpenRename: (notebook: CloudNotebookListItem) => void;
  onCancelRename: () => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (renameTitle !== null) {
    const notebook = row.notebook;
    return (
      <form className="cloud-notebook-list-rename-form" onSubmit={onSaveRename}>
        <input
          aria-label={`Notebook title for ${cloudNotebookShortId(notebook.notebook_id)}`}
          type="text"
          value={renameTitle}
          maxLength={160}
          placeholder="Untitled notebook"
          disabled={renameSaving}
          onChange={(event) => onRenameTitleChange(event.currentTarget.value)}
        />
        <button type="submit" disabled={renameSaving} title="Save title" aria-label="Save title">
          {renameSaving ? (
            <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          disabled={renameSaving}
          title="Cancel rename"
          aria-label="Cancel rename"
          onClick={onCancelRename}
        >
          <X aria-hidden="true" />
        </button>
      </form>
    );
  }

  const { notebook } = row;
  const hasTitle = Boolean(notebook.title?.trim());
  const detail = hasTitle
    ? row.contextLabel
    : row.identityLabel
      ? `Created ${formatNotebookUpdatedAt(notebook.created_at)} · ${row.identityLabel}`
      : `Created ${formatNotebookUpdatedAt(notebook.created_at)}`;

  return (
    <div className="cloud-notebook-list-row">
      <a className="cloud-notebook-list-main" href={notebook.viewer_url}>
        <span className="cloud-notebook-list-title">{cloudNotebookDisplayTitle(notebook)}</span>
        {detail ? <span className="cloud-notebook-list-detail">{detail}</span> : null}
        {row.facts.length > 0 ? (
          <span className="cloud-notebook-list-row-facts">
            {row.facts.map((fact) => (
              <CloudNotebookDashboardFact key={fact.kind} fact={fact} />
            ))}
          </span>
        ) : null}
      </a>
      <span className="cloud-notebook-list-updated">
        <Clock aria-hidden="true" />
        {formatNotebookUpdatedAt(notebook.updated_at)}
      </span>
      <span className="cloud-notebook-list-row-actions">
        {canRename && canRenameCloudNotebook(notebook) ? (
          <button
            type="button"
            className="cloud-notebook-list-icon-button"
            title="Rename notebook"
            aria-label={`Rename ${cloudNotebookDisplayTitle(notebook)}`}
            onClick={() => onOpenRename(notebook)}
          >
            <PencilLine aria-hidden="true" />
          </button>
        ) : null}
        <a
          className="cloud-notebook-list-icon-button"
          href={notebook.viewer_url}
          title="Open notebook"
          aria-label={`Open ${cloudNotebookDisplayTitle(notebook)}`}
        >
          <ExternalLink aria-hidden="true" />
        </a>
      </span>
    </div>
  );
}

function canRenameCloudNotebook(notebook: CloudNotebookListItem): boolean {
  return notebook.scope === "owner" || notebook.scope === "editor";
}

function CloudNotebookDashboardFact({ fact }: { fact: CloudNotebookDashboardRowFact }) {
  if (fact.kind === "published") {
    return (
      <span data-state="published">
        <Share2 aria-hidden="true" />
        {fact.label}
      </span>
    );
  }

  return (
    <span>
      <UserRound aria-hidden="true" />
      {fact.label}
    </span>
  );
}

function formatNotebookUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
