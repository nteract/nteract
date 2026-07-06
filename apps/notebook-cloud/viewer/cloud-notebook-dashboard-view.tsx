import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  Clock,
  Code,
  FileText,
  Layers,
  Loader2,
  PencilLine,
  Play,
  Share2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NotebookCellStrip } from "@/components/notebook/NotebookCellStrip";
import { LanguageMark } from "@/components/runtime/LanguageMark";
import { NotebookCompositionTicks } from "@/components/notebook/NotebookCompositionTicks";
import { RuntimeStatusDot } from "@/components/runtime/RuntimeStatusDot";
import {
  cloudNotebookCoverUrl,
  cloudNotebookDashboardOpenUrl,
  cloudNotebookDisplayTitle,
  cloudNotebookLanguageDisplayLabel,
  cloudNotebookShortId,
  projectCloudNotebookDashboardView,
  type CloudNotebookDashboardFilterId,
  type CloudNotebookDashboardModel,
  type CloudNotebookDashboardRow,
  type CloudNotebookDashboardSection,
  type CloudNotebookListItem,
  type CloudNotebookPresencePeer,
} from "./notebook-dashboard";
import {
  cloudPresenceColor,
  cloudPresenceContrastColor,
  cloudPresenceInitials,
  cloudVisiblePeerLabel,
} from "./presence";

interface CloudNotebookDashboardRenameState {
  notebookId: string;
  title: string;
}

export function CloudNotebookDashboard({
  model,
  canRename,
  query,
  renameState,
  renameSavingId,
  onOpenNotebookIntent,
  onOpenRename,
  onCancelRename,
  onQueryChange,
  onRenameTitleChange,
  onSaveRename,
}: {
  model: CloudNotebookDashboardModel;
  canRename: boolean;
  query?: string;
  renameState: CloudNotebookDashboardRenameState | null;
  renameSavingId: string | null;
  onOpenNotebookIntent?: () => void;
  onOpenRename: (notebook: CloudNotebookListItem) => void;
  onCancelRename: () => void;
  onQueryChange?: (query: string) => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [internalQuery, setInternalQuery] = useState("");
  const [filterId, setFilterId] = useState<CloudNotebookDashboardFilterId>("all");
  const activeQuery = query ?? internalQuery;
  const setQuery = onQueryChange ?? setInternalQuery;
  const view = useMemo(
    () => projectCloudNotebookDashboardView(model, { filterId, query: activeQuery }),
    [filterId, model, activeQuery],
  );
  const continued = view.filterId === "all" && view.query.length === 0 ? model.continueRow : null;
  const totalCount = model.notebooks.length;
  const activeCount = model.filters.find((filter) => filter.id === "compute")?.count ?? 0;
  const hasNoMatches = !continued && view.sections.length === 0;

  const clearFocus = () => {
    setFilterId("all");
    setQuery("");
  };

  return (
    <div className="cloud-dashboard">
      <div className="nb-pagehead">
        <div>
          <h1>Notebooks</h1>
          <p>
            {totalCount} notebook{totalCount === 1 ? "" : "s"} · {activeCount} active now
          </p>
        </div>
        {view.showResultCount ? (
          <span className="nb-result-count" aria-live="polite">
            {view.resultCount} notebook{view.resultCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      <CloudNotebookDashboardFilterBar
        filterGroups={view.filterGroups}
        filterId={view.filterId}
        onSelectFilter={setFilterId}
      />

      {continued ? (
        <CloudNotebookDashboardHero row={continued} onOpenNotebookIntent={onOpenNotebookIntent} />
      ) : null}

      {hasNoMatches ? (
        <CloudNotebookDashboardNoMatches message={view.emptyMessage} onClear={clearFocus} />
      ) : (
        <div className="nb-sections">
          {view.sections.map((section) => (
            <CloudNotebookDashboardSectionView
              key={section.id}
              section={section}
              canRename={canRename}
              renameState={renameState}
              renameSavingId={renameSavingId}
              onOpenNotebookIntent={onOpenNotebookIntent}
              onOpenRename={onOpenRename}
              onCancelRename={onCancelRename}
              onSelectFilter={setFilterId}
              onRenameTitleChange={onRenameTitleChange}
              onSaveRename={onSaveRename}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CloudNotebookDashboardSearchInput({
  query,
  disabled,
  onQueryChange,
}: {
  query: string;
  disabled?: boolean;
  onQueryChange: (query: string) => void;
}) {
  return (
    <Input
      id="cloud-dashboard-search-input"
      name="notebook-search"
      type="search"
      value={query}
      placeholder="Search notebooks"
      aria-label="Search notebooks"
      disabled={disabled}
      onChange={(event) => onQueryChange(event.currentTarget.value)}
    />
  );
}

function CloudNotebookDashboardFilterBar({
  filterGroups,
  filterId,
  onSelectFilter,
}: {
  filterGroups: CloudNotebookDashboardModel["filterGroups"];
  filterId: CloudNotebookDashboardFilterId;
  onSelectFilter: (filterId: CloudNotebookDashboardFilterId) => void;
}) {
  return (
    <nav className="nb-filters" aria-label="Notebook filters">
      {filterGroups.flatMap((group) =>
        group.filters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className="nb-chip"
            data-chip={filter.id === "compute" ? "live" : undefined}
            data-active={filterId === filter.id ? "true" : undefined}
            aria-label={`${filter.label}: ${filter.count} notebook${filter.count === 1 ? "" : "s"}`}
            aria-pressed={filterId === filter.id}
            onClick={() => onSelectFilter(filter.id)}
          >
            {filter.id === "compute" ? <span className="nb-chip-pip" aria-hidden="true" /> : null}
            <span>{filter.label}</span>
            <span className="nb-chip-count">{filter.count}</span>
          </button>
        )),
      )}
    </nav>
  );
}

function CloudNotebookDashboardHero({
  row,
  onOpenNotebookIntent,
}: {
  row: CloudNotebookDashboardRow;
  onOpenNotebookIntent?: () => void;
}) {
  const notebook = row.notebook;
  const openUrl = cloudNotebookDashboardOpenUrl(notebook);
  const activeNow = cloudNotebookIsActiveNow(row);
  const runtimeLanguage =
    cloudNotebookLanguageDisplayLabel(notebook.language) ??
    (row.environmentLabel
      ? /python/iu.test(row.environmentLabel)
        ? "Python"
        : row.environmentLabel
      : null);
  const cellCount = row.composition ? notebookCompositionTotal(row.composition) : null;
  const heroComputeFact = row.facts.find((fact) => fact.kind === "compute") ?? null;
  const stripThumbnail = cloudNotebookCellStripThumbnail(notebook);

  return (
    <section
      className={`nb-hero${activeNow ? " is-live" : ""}`}
      aria-label="Pick up where you left off"
    >
      {row.environmentLabel && runtimeLanguage ? (
        <span className="nb-hero-runtime">
          <LanguageMark language={runtimeLanguage} size={16} />
          {row.environmentLabel}
        </span>
      ) : null}
      <div className="nb-hero-top">
        <div className="nb-hero-body">
          <div className="nb-hero-eyebrow">
            {activeNow ? "Pick up where you left off" : "Jump back in"}
          </div>
          <h2 className="nb-hero-title">{cloudNotebookDisplayTitle(notebook)}</h2>
          <div className="nb-hero-meta">
            <span title={heroComputeFact?.label ?? undefined}>
              <RuntimeStatusDot status={row.runtimeStatus} showLabel />
            </span>
            <span className="nb-meta-item">
              <Clock aria-hidden="true" />
              Updated {formatNotebookUpdatedAt(notebook.updated_at)}
            </span>
            {cellCount !== null ? (
              <span className="nb-meta-item">
                <Layers aria-hidden="true" />
                {cellCount} cells
              </span>
            ) : null}
            <CloudNotebookPresenceStack peers={notebook.peers} />
          </div>
          {row.composition ? (
            <NotebookCompositionTicks composition={row.composition} className="nb-hero-fp" />
          ) : null}
          {notebook.preview?.length || stripThumbnail ? (
            <NotebookCellStrip preview={notebook.preview ?? []} thumbnail={stripThumbnail} />
          ) : null}
        </div>
        <div className="nb-hero-side">
          <Button asChild className="nb-hero-open">
            <a href={openUrl} onFocus={onOpenNotebookIntent} onPointerEnter={onOpenNotebookIntent}>
              {activeNow ? (
                <>
                  <Play aria-hidden="true" />
                  Resume
                </>
              ) : (
                <>
                  Open
                  <ArrowRight aria-hidden="true" />
                </>
              )}
            </a>
          </Button>
        </div>
      </div>
      <CloudNotebookHeroBanner notebook={notebook} />
    </section>
  );
}

function CloudNotebookDashboardSectionView({
  section,
  canRename,
  renameState,
  renameSavingId,
  onOpenNotebookIntent,
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
  onOpenNotebookIntent?: () => void;
  onOpenRename: (notebook: CloudNotebookListItem) => void;
  onCancelRename: () => void;
  onSelectFilter: (filterId: CloudNotebookDashboardFilterId) => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const action = section.action?.kind === "rename" && !canRename ? null : section.action;
  const hiddenCount = Math.max(0, section.totalCount - section.notebooks.length);
  const overflowAction = section.overflowAction;
  const showCoverSlot = section.rows.some((row) => row.notebook.cover);
  const actionAlreadyReviewsOverflow =
    action?.kind === "filter" && action.filterId === overflowAction?.filterId;

  return (
    <section className="nb-section" data-section={section.id}>
      <div className="nb-sec-head" data-tone={section.id === "compute" ? "live" : "default"}>
        <div className="nb-sec-left">
          {section.id === "compute" ? <span className="nb-live-pip" aria-hidden="true" /> : null}
          <h2 className="nb-sec-title">{section.title}</h2>
          <span className="nb-sec-count">{section.totalCount}</span>
        </div>
        {action?.kind === "rename" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="nb-sec-action"
            onClick={() => onOpenRename(action.notebook)}
          >
            <PencilLine aria-hidden="true" />
            {action.label}
          </Button>
        ) : action?.kind === "filter" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="nb-sec-action"
            onClick={() => onSelectFilter(action.filterId)}
          >
            {action.label}
          </Button>
        ) : (
          <span className="nb-sec-hint">{section.detail}</span>
        )}
      </div>
      <div className="nb-list">
        {section.rows.map((row) => (
          <CloudNotebookDashboardRowView
            key={row.notebook.notebook_id}
            row={row}
            showCoverSlot={showCoverSlot}
            canRename={canRename}
            renameTitle={
              renameState?.notebookId === row.notebook.notebook_id ? renameState.title : null
            }
            renameSaving={renameSavingId === row.notebook.notebook_id}
            onOpenNotebookIntent={onOpenNotebookIntent}
            onOpenRename={onOpenRename}
            onCancelRename={onCancelRename}
            onRenameTitleChange={onRenameTitleChange}
            onSaveRename={onSaveRename}
          />
        ))}
      </div>
      {hiddenCount > 0 && overflowAction ? (
        <p className="nb-section-footnote">
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

function CloudNotebookDashboardRowView({
  row,
  showCoverSlot,
  canRename,
  renameTitle,
  renameSaving,
  onOpenNotebookIntent,
  onOpenRename,
  onCancelRename,
  onRenameTitleChange,
  onSaveRename,
}: {
  row: CloudNotebookDashboardRow;
  showCoverSlot: boolean;
  canRename: boolean;
  renameTitle: string | null;
  renameSaving: boolean;
  onOpenNotebookIntent?: () => void;
  onOpenRename: (notebook: CloudNotebookListItem) => void;
  onCancelRename: () => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const notebook = row.notebook;
  if (renameTitle !== null) {
    return (
      <form className="nb-row nb-row-rename" onSubmit={onSaveRename}>
        <Input
          aria-label={`Notebook title for ${cloudNotebookShortId(notebook.notebook_id)}`}
          type="text"
          value={renameTitle}
          maxLength={160}
          placeholder="Untitled notebook"
          disabled={renameSaving}
          onChange={(event) => onRenameTitleChange(event.currentTarget.value)}
        />
        <span className="nb-row-rename-actions">
          <Button type="submit" variant="ghost" size="icon" disabled={renameSaving}>
            {renameSaving ? (
              <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            <span className="sr-only">Save title</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={renameSaving}
            onClick={onCancelRename}
          >
            <X aria-hidden="true" />
            <span className="sr-only">Cancel rename</span>
          </Button>
        </span>
      </form>
    );
  }

  const openUrl = cloudNotebookDashboardOpenUrl(notebook);
  const hasTitle = Boolean(notebook.title?.trim());
  const cellCount = row.composition ? notebookCompositionTotal(row.composition) : null;
  const activeNow = cloudNotebookIsActiveNow(row);
  // The compute fact carries the rich label ("lab2 workstation running, 1 queued");
  // the column shows the calm dot + terse status, the full label rides title/aria.
  const computeFact = row.facts.find((fact) => fact.kind === "compute") ?? null;
  const languageLabel = cloudNotebookLanguageDisplayLabel(notebook.language);
  const stripThumbnail = cloudNotebookCellStripThumbnail(notebook);
  const showStrip = Boolean(notebook.preview?.length || stripThumbnail);

  return (
    <div
      className={`nb-row${activeNow ? " is-live" : ""}`}
      data-cover-slot={showStrip && showCoverSlot ? "true" : undefined}
      data-scope={notebook.scope}
    >
      <a
        className="nb-row-lead"
        href={openUrl}
        onFocus={onOpenNotebookIntent}
        onPointerEnter={onOpenNotebookIntent}
      >
        {showCoverSlot ? <CloudNotebookCoverTile notebook={notebook} /> : null}
        <span className="nb-row-titleblock">
          <span className="nb-title" data-untitled={!hasTitle}>
            {cloudNotebookDisplayTitle(notebook)}
          </span>
          {row.composition ? (
            <span className="nb-subline">
              <NotebookCompositionTicks composition={row.composition} />
              <span className="nb-cellcount">{cellCount} cells</span>
            </span>
          ) : row.contextLabel || row.identityLabel ? (
            <span className="nb-row-context">{row.contextLabel ?? row.identityLabel}</span>
          ) : null}
        </span>
      </a>
      <span className="nb-col nb-col-owner">
        {notebook.scope === "owner" ? null : (
          <>
            <span
              className="nb-avatar nb-avatar-sm"
              style={
                row.ownerAvatar
                  ? undefined
                  : ({
                      "--nb-avatar-bg": row.ownerColor,
                      "--nb-avatar-fg": row.ownerContrast,
                    } as CSSProperties)
              }
            >
              {row.ownerAvatar ? (
                <img className="nb-avatar-img" src={row.ownerAvatar} alt={row.ownerLabel} />
              ) : (
                row.ownerInitials
              )}
            </span>
            <span className="nb-col-owner-name">{row.ownerLabel}</span>
          </>
        )}
      </span>
      <span className="nb-col nb-col-lang">
        {languageLabel ? (
          <>
            <LanguageMark language={languageLabel} size={12} />
            {languageLabel}
          </>
        ) : null}
      </span>
      <span className="nb-col nb-col-status" title={computeFact?.label ?? undefined}>
        {row.runtimeStatus !== "none" ? (
          <RuntimeStatusDot status={row.runtimeStatus} showLabel />
        ) : null}
      </span>
      <CloudNotebookPresenceStack peers={notebook.peers} />
      <span className="nb-col nb-col-updated">
        <Clock aria-hidden="true" />
        {formatNotebookUpdatedAt(notebook.updated_at)}
      </span>
      <div className="nb-col nb-col-badges">
        {notebook.latest_revision_id ? (
          <span className="nb-pub">
            <Share2 aria-hidden="true" />
            Published
          </span>
        ) : null}
        <CloudNotebookScopeBadge notebook={notebook} />
      </div>
      <span className="nb-row-actions">
        {canRename && canRenameCloudNotebook(notebook) ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="nb-row-icon"
            aria-label={`Rename ${cloudNotebookDisplayTitle(notebook)}`}
            title="Rename notebook"
            onClick={() => onOpenRename(notebook)}
          >
            <PencilLine aria-hidden="true" />
          </Button>
        ) : null}
        <a
          className="nb-open-hint"
          href={openUrl}
          aria-label={`Open ${cloudNotebookDisplayTitle(notebook)}`}
          title="Open notebook"
          onFocus={onOpenNotebookIntent}
          onPointerEnter={onOpenNotebookIntent}
        >
          <ArrowRight aria-hidden="true" />
        </a>
      </span>
      {showStrip ? (
        <div className="nb-row-strip">
          <NotebookCellStrip preview={notebook.preview ?? []} thumbnail={stripThumbnail} />
        </div>
      ) : null}
    </div>
  );
}

function CloudNotebookPresenceStack({ peers }: { peers?: readonly CloudNotebookPresencePeer[] }) {
  if (!peers?.length) {
    return <span className="nb-col nb-col-peers" aria-hidden="true" />;
  }

  const visiblePeers = peers.slice(0, 3);
  const hiddenCount = Math.max(0, peers.length - visiblePeers.length);
  const label =
    peers.length === 1
      ? `${cloudNotebookPresencePeerLabel(peers[0]!)} editing now`
      : `${peers.length} people editing now`;

  return (
    <span className="nb-col nb-col-peers" aria-label={label} title={label}>
      <span className="nb-peers" aria-hidden="true">
        {visiblePeers.map((peer) => {
          const actorColorKey = peer.actor_label || peer.participant_key;
          const style = {
            "--nb-peer-bg": cloudPresenceColor(actorColorKey),
            "--nb-peer-fg": cloudPresenceContrastColor(actorColorKey),
          } as CSSProperties;
          const peerLabel = cloudNotebookPresencePeerLabel(peer);
          return (
            <span key={peer.participant_key} className="nb-peer" style={style} title={peerLabel}>
              {cloudPresenceInitials(peerLabel)}
            </span>
          );
        })}
        {hiddenCount > 0 ? <span className="nb-peer nb-peer-more">+{hiddenCount}</span> : null}
      </span>
      <span className="nb-peers-label">editing now</span>
    </span>
  );
}

function cloudNotebookPresencePeerLabel(peer: CloudNotebookPresencePeer): string {
  return cloudVisiblePeerLabel(peer.display_name, peer.actor_label);
}

function CloudNotebookCoverTile({ notebook }: { notebook: CloudNotebookListItem }) {
  const coverUrl = cloudNotebookCoverUrl(notebook);
  const fallbackType = dominantNotebookCellType(notebook.composition);
  return (
    <span className={`nb-cover${coverUrl ? " has-img" : ""}`} aria-hidden="true">
      {coverUrl ? (
        <img className="nb-output-img" src={coverUrl} alt="" loading="lazy" />
      ) : (
        <NotebookCoverFallbackIcon cellType={fallbackType} />
      )}
    </span>
  );
}

function CloudNotebookHeroBanner({ notebook }: { notebook: CloudNotebookListItem }) {
  const coverUrl = cloudNotebookCoverUrl(notebook);
  if (!coverUrl) {
    return null;
  }
  return (
    <div className="nb-hero-banner" aria-hidden="true">
      <img className="nb-output-img" src={coverUrl} alt="" />
    </div>
  );
}

function cloudNotebookCellStripThumbnail(
  notebook: CloudNotebookListItem,
): { src: string; alt: string } | null {
  const src = cloudNotebookCoverUrl(notebook);
  return src ? { src, alt: "" } : null;
}

function NotebookCoverFallbackIcon({
  cellType,
}: {
  cellType: keyof NonNullable<CloudNotebookListItem["composition"]>;
}) {
  switch (cellType) {
    case "markdown":
      return <BookOpen aria-hidden="true" />;
    case "raw":
      return <FileText aria-hidden="true" />;
    case "code":
      return <Code aria-hidden="true" />;
  }
}

function dominantNotebookCellType(
  composition: CloudNotebookListItem["composition"],
): keyof NonNullable<CloudNotebookListItem["composition"]> {
  if (!composition) {
    return "code";
  }
  if (composition.markdown > composition.code && composition.markdown >= composition.raw) {
    return "markdown";
  }
  if (composition.raw > composition.code && composition.raw > composition.markdown) {
    return "raw";
  }
  return "code";
}

function CloudNotebookScopeBadge({ notebook }: { notebook: CloudNotebookListItem }) {
  const label = cloudNotebookScopeLabel(notebook);
  if (!label) {
    return null;
  }
  return (
    <Badge variant="outline" className="nb-scope-badge">
      {label}
    </Badge>
  );
}

function CloudNotebookDashboardNoMatches({
  message,
  onClear,
}: {
  message: string;
  onClear: () => void;
}) {
  return (
    <div className="nb-empty" role="status">
      <span className="nb-empty-badge">
        <BookOpen aria-hidden="true" />
      </span>
      <h2>No matches</h2>
      <p>{message}</p>
      <Button type="button" variant="outline" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}

function canRenameCloudNotebook(notebook: CloudNotebookListItem): boolean {
  return notebook.scope === "owner" || notebook.scope === "editor";
}

function cloudNotebookScopeLabel(notebook: CloudNotebookListItem): string | null {
  switch (notebook.scope) {
    case "editor":
      return "Can edit";
    case "viewer":
      return "View only";
    case "runtime_peer":
      return "Runtime";
    case "owner":
      return null;
  }
}

function cloudNotebookIsActiveNow(row: CloudNotebookDashboardRow): boolean {
  return (
    row.runtimeStatus === "executing" ||
    row.runtimeStatus === "ready" ||
    row.runtimeStatus === "starting" ||
    Boolean(row.notebook.peers?.length)
  );
}

function notebookCompositionTotal(composition: { code: number; markdown: number; raw: number }) {
  return composition.code + composition.markdown + composition.raw;
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
