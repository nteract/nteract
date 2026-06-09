import type { FormEvent } from "react";
import {
  BookOpen,
  Check,
  Clock,
  ExternalLink,
  Globe2,
  Loader2,
  PencilLine,
  Radio,
  Share2,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import {
  cloudNotebookDisplayTitle,
  cloudNotebookShortId,
  type CloudNotebookDashboardMetric,
  type CloudNotebookDashboardModel,
  type CloudNotebookDashboardSection,
  type CloudNotebookListItem,
} from "./notebook-dashboard";
import type { CloudNotebookRenameState } from "./cloud-viewer-types";

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
  renameState: CloudNotebookRenameState | null;
  renameSavingId: string | null;
  onOpenRename: (notebook: CloudNotebookListItem) => void;
  onCancelRename: () => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const continued = model.continueNotebook;

  return (
    <div className="cloud-dashboard">
      {continued ? (
        <section className="cloud-dashboard-continue" aria-labelledby="cloud-dashboard-continue">
          <div className="cloud-dashboard-continue-main">
            <p>Continue</p>
            <h2 id="cloud-dashboard-continue">{cloudNotebookDisplayTitle(continued)}</h2>
            <div className="cloud-dashboard-continue-facts">
              <span>
                <Clock aria-hidden="true" />
                {formatNotebookUpdatedAt(continued.updated_at)}
              </span>
              <span>
                <UserRound aria-hidden="true" />
                {formatNotebookScope(continued.scope)}
              </span>
              <span>
                {continued.latest_revision_id ? (
                  <Globe2 aria-hidden="true" />
                ) : (
                  <Radio aria-hidden="true" />
                )}
                {continued.latest_revision_id ? "published revision" : "not published"}
              </span>
            </div>
          </div>
          <a className="cloud-dashboard-primary-link" href={continued.viewer_url}>
            Open
            <ExternalLink aria-hidden="true" />
          </a>
        </section>
      ) : null}

      <section className="cloud-dashboard-summary" aria-label="Notebook summary">
        {model.metrics.map((metric) => (
          <CloudNotebookDashboardMetric key={metric.label} metric={metric} />
        ))}
      </section>

      <section className="cloud-dashboard-grid">
        <section className="cloud-dashboard-notebooks" aria-label="Notebook rooms">
          {model.sections.map((section) => (
            <CloudNotebookDashboardSectionView
              key={section.id}
              section={section}
              canRename={canRename}
              renameState={renameState}
              renameSavingId={renameSavingId}
              onOpenRename={onOpenRename}
              onCancelRename={onCancelRename}
              onRenameTitleChange={onRenameTitleChange}
              onSaveRename={onSaveRename}
            />
          ))}
        </section>
        <aside className="cloud-dashboard-aside" aria-label="Notebook workspace">
          <section>
            <p className="cloud-dashboard-aside-kicker">Compute</p>
            <h2>Workstations</h2>
            <p>
              Workstation status appears inside each notebook room once a compute target is
              selected.
            </p>
          </section>
          <section>
            <p className="cloud-dashboard-aside-kicker">Sharing</p>
            <h2>Public previews</h2>
            <p>Published notebooks can expose safe metadata and revision-aware preview images.</p>
          </section>
        </aside>
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
  onRenameTitleChange,
  onSaveRename,
}: {
  section: CloudNotebookDashboardSection;
  canRename: boolean;
  renameState: CloudNotebookRenameState | null;
  renameSavingId: string | null;
  onOpenRename: (notebook: CloudNotebookListItem) => void;
  onCancelRename: () => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const action = canRename ? section.action : null;

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
        ) : null}
      </div>
      <ul className="cloud-notebook-list">
        {section.notebooks.map((notebook) => (
          <li key={notebook.notebook_id}>
            <CloudNotebookDashboardRow
              notebook={notebook}
              canRename={canRename}
              renameTitle={
                renameState?.notebookId === notebook.notebook_id ? renameState.title : null
              }
              renameSaving={renameSavingId === notebook.notebook_id}
              onOpenRename={onOpenRename}
              onCancelRename={onCancelRename}
              onRenameTitleChange={onRenameTitleChange}
              onSaveRename={onSaveRename}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CloudNotebookDashboardMetric({ metric }: { metric: CloudNotebookDashboardMetric }) {
  const Icon = cloudNotebookDashboardMetricIcons[metric.icon];
  return (
    <div className="cloud-dashboard-summary-item">
      <span>
        <Icon aria-hidden="true" />
        {metric.label}
      </span>
      <strong>{metric.value}</strong>
      <p>{metric.detail}</p>
    </div>
  );
}

const cloudNotebookDashboardMetricIcons = {
  notebooks: BookOpen,
  owned: UserRound,
  published: Zap,
} satisfies Record<CloudNotebookDashboardMetric["icon"], typeof BookOpen>;

function CloudNotebookDashboardRow({
  notebook,
  canRename,
  renameTitle,
  renameSaving,
  onOpenRename,
  onCancelRename,
  onRenameTitleChange,
  onSaveRename,
}: {
  notebook: CloudNotebookListItem;
  canRename: boolean;
  renameTitle: string | null;
  renameSaving: boolean;
  onOpenRename: (notebook: CloudNotebookListItem) => void;
  onCancelRename: () => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (renameTitle !== null) {
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

  const hasTitle = Boolean(notebook.title?.trim());

  return (
    <div className="cloud-notebook-list-row">
      <a className="cloud-notebook-list-main" href={notebook.viewer_url}>
        <span className="cloud-notebook-list-title">{cloudNotebookDisplayTitle(notebook)}</span>
        {hasTitle ? null : (
          <span className="cloud-notebook-list-detail">
            Created {formatNotebookUpdatedAt(notebook.created_at)}
          </span>
        )}
        <span className="cloud-notebook-list-row-facts">
          <span>
            <UserRound aria-hidden="true" />
            {formatNotebookScope(notebook.scope)}
          </span>
          <span data-state={notebook.latest_revision_id ? "published" : "unpublished"}>
            {notebook.latest_revision_id ? (
              <Share2 aria-hidden="true" />
            ) : (
              <Radio aria-hidden="true" />
            )}
            {notebook.latest_revision_id ? "published revision" : "not published"}
          </span>
        </span>
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

function formatNotebookScope(scope: CloudNotebookListItem["scope"]): string {
  switch (scope) {
    case "owner":
      return "owner";
    case "editor":
      return "editor";
    case "runtime_peer":
      return "runtime";
    case "viewer":
      return "viewer";
  }
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
