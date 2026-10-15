import {
  ArrowDownToLine,
  ChevronsRight,
  Code,
  LetterText,
  Loader2,
  Play,
  RotateCcw,
  ServerCog,
  Square,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { CondaIcon, DenoIcon, PixiIcon, PythonIcon, UvIcon } from "@/components/environment";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  projectNotebookCommandRuntimeActions,
  type NotebookCommandRuntimeState,
  type NotebookShellCapabilities,
  type NotebookShellRuntimeTargetProjection,
} from "./capabilities";
import { flushCellUIState, setActiveInteractionTarget } from "./state/cell-ui-state";

export type { NotebookCommandRuntimeState } from "./capabilities";

export type NotebookEnvironmentManager = "uv" | "conda" | "pixi";

export interface NotebookEnvironmentSelection {
  candidates: Array<{ id: string; name: string; display_name: string; manager: string }>;
  selectedId: string | null;
  selectedName: string | null;
  runningId: string | null;
  truncated: boolean;
  error?: string | null;
  onSelect: (id: string | null) => void;
  onApply: () => void;
  onRefresh: () => void;
}

export interface NotebookCommandToolbarStatus {
  state: NotebookCommandRuntimeState;
  label: ReactNode;
  ariaLabel: string;
  title?: string;
  error?: ReactNode;
}

export interface NotebookCommandToolbarUpdateAction {
  label: string;
  title: string;
  onClick: () => void;
}

export interface NotebookCommandToolbarWorkstationAction {
  disabled?: boolean;
  label: string;
  pending?: boolean;
  title: string;
  onClick: () => void;
}

export interface NotebookCommandToolbarProps {
  capabilities: Pick<
    NotebookShellCapabilities,
    | "canEditStructure"
    | "canExecute"
    | "canRecoverRuntime"
    | "canManageSharing"
    | "canRequestEdit"
    | "auth"
  >;
  runtime?: string | null;
  runtimeTarget?: NotebookShellRuntimeTargetProjection | null;
  environmentManager?: NotebookEnvironmentManager | null;
  environmentOutOfSync?: boolean;
  environmentSelection?: NotebookEnvironmentSelection | null;
  runningEnvironmentLabel?: string | null;
  pythonVersion?: string | null;
  runtimeStatus?: NotebookCommandToolbarStatus | null;
  startDisabled?: boolean;
  addCellControlsDisabled?: boolean;
  addAfterCellId?: string | null;
  onAddCell?: (
    type: "code" | "markdown",
    afterCellId?: string | null,
  ) => { id: string } | null | void;
  onStartRuntime?: () => void;
  onInterruptRuntime?: () => void;
  onRestartRuntime?: () => void;
  onRunAllCells?: () => void;
  onRestartAndRunAll?: () => void;
  updateAction?: NotebookCommandToolbarUpdateAction | null;
  workstationAction?: NotebookCommandToolbarWorkstationAction | null;
  presenceControls?: ReactNode;
  utilityControls?: ReactNode;
  sharingControls?: ReactNode;
  editControls?: ReactNode;
  authControls?: ReactNode;
  identityControls?: ReactNode;
  leadingControls?: ReactNode;
  trailingControls?: ReactNode;
  className?: string;
}

const TOOLBAR_BUTTON_FOCUS =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Document event `@radix-ui/react-tooltip` dispatches when a tooltip opens;
 * every other open tooltip closes through its own lifecycle when it fires.
 * The "restores the provider delay" toolbar test fails if this drifts.
 */
const RADIX_TOOLTIP_OPEN_EVENT = "tooltip.open";

/**
 * Shared notebook command row. It owns one tooltip group, so hosts mount no
 * `TooltipProvider` of their own.
 */
export function NotebookCommandToolbar(props: NotebookCommandToolbarProps) {
  return (
    <TooltipProvider>
      <NotebookCommandToolbarRow {...props} />
    </TooltipProvider>
  );
}

function NotebookCommandToolbarRow({
  capabilities,
  runtime = null,
  runtimeTarget = null,
  environmentManager = null,
  environmentOutOfSync = false,
  environmentSelection = null,
  runningEnvironmentLabel = null,
  pythonVersion = null,
  runtimeStatus,
  startDisabled = false,
  addCellControlsDisabled = false,
  addAfterCellId = null,
  onAddCell,
  onStartRuntime,
  onInterruptRuntime,
  onRestartRuntime,
  onRunAllCells,
  onRestartAndRunAll,
  updateAction = null,
  workstationAction = null,
  presenceControls,
  utilityControls,
  sharingControls,
  editControls,
  authControls,
  identityControls,
  leadingControls,
  trailingControls,
  className,
}: NotebookCommandToolbarProps) {
  const { auth, canEditStructure, canExecute, canManageSharing, canRequestEdit } = capabilities;
  const showAddCellControls = Boolean(onAddCell) && (canEditStructure || addCellControlsDisabled);
  const runtimeActions = projectNotebookCommandRuntimeActions({
    capabilities: { canExecute, canRecoverRuntime: capabilities.canRecoverRuntime },
    runtimeStatus,
    actions: {
      interruptRuntime: Boolean(onInterruptRuntime),
      restartAndRunAll: Boolean(onRestartAndRunAll),
      restartRuntime: Boolean(onRestartRuntime),
      runAllCells: Boolean(onRunAllCells),
      startRuntime: Boolean(onStartRuntime),
    },
  });
  const runtimePeerCount = runtimeTarget?.runtimePeerCount ?? 0;
  const showRuntimePeerIndicator = runtimePeerCount > 0;
  const showAuthControls =
    Boolean(authControls) &&
    (auth.canSignIn || auth.canUseAuthenticatedIdentity || auth.needsAttention);

  const addMarkdownCell = () => {
    const added = onAddCell?.("markdown", addAfterCellId);
    if (!added) return;
    // A local insertion can enter editing; a remotely materialized empty
    // markdown cell must never infer that intent from its source alone.
    setActiveInteractionTarget({ kind: "editor", cellId: added.id });
    flushCellUIState();
  };

  const restartAndRunAllLabel = environmentOutOfSync
    ? "Dependencies changed - restart kernel and run all cells"
    : "Restart kernel and run all cells";
  const workstationPending = Boolean(workstationAction?.pending);
  const workstationDisabled = Boolean(workstationAction?.disabled) || workstationPending;
  const startRuntimeDisabled = startDisabled || workstationPending;
  const statusTooltip = runtimeStatus && !runtimeStatus.error ? runtimeStatus.title : undefined;
  const statusReadout = runtimeStatus ? (
    <>
      <div
        className={cn(
          "size-2 shrink-0 rounded-full",
          runtimeStatus.state === "idle" && "bg-green-500",
          runtimeStatus.state === "busy" && "bg-amber-500",
          (runtimeStatus.state === "starting" || runtimeStatus.state === "not_started") &&
            "bg-blue-500 animate-pulse",
          runtimeStatus.state === "shutdown" && "bg-gray-400 dark:bg-gray-500",
          runtimeStatus.state === "error" && "bg-red-500",
          runtimeStatus.state === "unknown" && "bg-muted-foreground",
        )}
      />
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {runtimeStatus.error ?? runtimeStatus.label}
      </span>
    </>
  ) : null;

  return (
    <div
      data-testid="notebook-toolbar"
      data-slot="notebook-command-toolbar"
      className={cn("@container flex h-10 min-w-0 items-center gap-2 px-3 select-none", className)}
    >
      {presenceControls ?? leadingControls}

      {showAddCellControls ? (
        <>
          <ToolbarTooltip
            content={addCellControlsDisabled ? "Checking edit access" : "Add code cell"}
            disabled={addCellControlsDisabled}
          >
            <button
              type="button"
              onClick={() => onAddCell?.("code", addAfterCellId)}
              disabled={addCellControlsDisabled}
              className={cn(
                TOOLBAR_BUTTON_FOCUS,
                "flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
              )}
              aria-label="Add code cell"
              aria-description={addCellControlsDisabled ? "Checking edit access" : undefined}
              data-testid="add-code-cell-button"
            >
              <Code className="size-3" />
              <span className="hidden @[40rem]:inline">Code</span>
            </button>
          </ToolbarTooltip>
          <ToolbarTooltip
            content={addCellControlsDisabled ? "Checking edit access" : "Add markdown cell"}
            disabled={addCellControlsDisabled}
          >
            <button
              type="button"
              onClick={addMarkdownCell}
              disabled={addCellControlsDisabled}
              className={cn(
                TOOLBAR_BUTTON_FOCUS,
                "flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
              )}
              aria-label="Add markdown cell"
              aria-description={addCellControlsDisabled ? "Checking edit access" : undefined}
              data-testid="add-markdown-cell-button"
            >
              <LetterText className="size-3" />
              <span className="hidden @[40rem]:inline">Markdown</span>
            </button>
          </ToolbarTooltip>
        </>
      ) : null}

      {showAddCellControls && runtimeActions.showAnyRuntimeAction ? (
        <div className="h-4 w-px bg-border" />
      ) : null}

      {runtimeActions.showRuntimeStart ? (
        <ToolbarTooltip content="Start kernel" disabled={startRuntimeDisabled}>
          <button
            type="button"
            onClick={onStartRuntime}
            disabled={startRuntimeDisabled}
            className={cn(
              TOOLBAR_BUTTON_FOCUS,
              "flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
            )}
            aria-label="Start kernel"
            data-testid="start-kernel-button"
          >
            <Play className="size-3" fill="currentColor" />
            <span className="hidden @[40rem]:inline">Start kernel</span>
          </button>
        </ToolbarTooltip>
      ) : null}

      {runtimeActions.showRunAll ? (
        <ToolbarTooltip content="Run all cells" disabled={workstationPending}>
          <button
            type="button"
            onClick={onRunAllCells}
            disabled={workstationPending}
            className={cn(
              TOOLBAR_BUTTON_FOCUS,
              "flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50",
            )}
            aria-label="Run all cells"
            data-testid="run-all-button"
          >
            <ChevronsRight className="size-3.5" />
            <span className="hidden @[40rem]:inline">Run all</span>
          </button>
        </ToolbarTooltip>
      ) : null}

      {runtimeActions.showRestart ? (
        <ToolbarTooltip content="Restart kernel">
          <button
            type="button"
            onClick={onRestartRuntime}
            className={cn(
              TOOLBAR_BUTTON_FOCUS,
              "flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted",
            )}
            aria-label="Restart kernel"
            data-testid="restart-kernel-button"
          >
            <RotateCcw className="size-3" />
            <span className="hidden @[40rem]:inline">Restart</span>
          </button>
        </ToolbarTooltip>
      ) : null}

      {runtimeActions.showRestartAndRunAll ? (
        <ToolbarTooltip content={restartAndRunAllLabel}>
          <button
            type="button"
            onClick={onRestartAndRunAll}
            className={cn(
              TOOLBAR_BUTTON_FOCUS,
              "flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors",
              environmentOutOfSync
                ? "bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/30 hover:bg-amber-500/20 dark:text-amber-400"
                : "text-foreground hover:bg-muted",
            )}
            aria-label={restartAndRunAllLabel}
            data-testid="restart-run-all-button"
          >
            <RotateCcw className="size-3" />
            <ChevronsRight className="size-3 -ml-1" />
          </button>
        </ToolbarTooltip>
      ) : null}

      {runtimeActions.showInterrupt ? (
        <ToolbarTooltip content="Interrupt kernel">
          <button
            type="button"
            onClick={onInterruptRuntime}
            className={cn(
              TOOLBAR_BUTTON_FOCUS,
              "flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs transition-colors",
              runtimeStatus?.state === "busy"
                ? "text-destructive hover:bg-destructive/10"
                : "text-foreground hover:bg-muted",
            )}
            aria-label="Interrupt kernel"
            data-testid="interrupt-kernel-button"
          >
            <Square
              className="size-3"
              fill={runtimeStatus?.state === "busy" ? "currentColor" : "none"}
            />
            <span className="hidden @[40rem]:inline">Interrupt</span>
          </button>
        </ToolbarTooltip>
      ) : null}

      {workstationAction ? (
        <ToolbarTooltip content={workstationAction.title} disabled={workstationDisabled}>
          <button
            type="button"
            onClick={workstationAction.onClick}
            disabled={workstationDisabled}
            className={cn(
              TOOLBAR_BUTTON_FOCUS,
              "flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-60",
            )}
            aria-label={workstationAction.label}
            aria-description={workstationAction.title}
            data-testid="workstation-setup-button"
          >
            {workstationAction.pending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ServerCog className="size-3" />
            )}
            <span className="hidden @[40rem]:inline">{workstationAction.label}</span>
          </button>
        </ToolbarTooltip>
      ) : null}

      <div className="flex-1" />

      {utilityControls}

      {environmentSelection ? (
        <div className="flex items-center gap-1" data-testid="environment-selection">
          <label className="sr-only" htmlFor="notebook-python-environment">
            Python environment
          </label>
          <select
            id="notebook-python-environment"
            data-testid="python-environment-select"
            value={environmentSelection.selectedId ?? ""}
            onChange={(event) => environmentSelection.onSelect(event.target.value || null)}
            className="max-w-48 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
            title={environmentSelection.selectedName ?? "Select Python environment"}
          >
            <option value="">Automatic environment</option>
            {environmentSelection.candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.display_name} ({candidate.manager})
              </option>
            ))}
          </select>
          {environmentSelection.truncated ? (
            <span title="More than 250 environments found">250+</span>
          ) : null}
          <button
            type="button"
            onClick={environmentSelection.onRefresh}
            data-testid="refresh-python-environments"
            className="rounded px-2 py-1 text-xs hover:bg-muted"
          >
            Refresh
          </button>
          {environmentSelection.selectedId &&
          environmentSelection.selectedId !== environmentSelection.runningId ? (
            <button
              type="button"
              onClick={environmentSelection.onApply}
              disabled={runtimeStatus?.state === "busy" || runtimeStatus?.state === "starting"}
              data-testid="apply-python-environment"
              aria-label="Apply and restart"
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
              title="Restart kernel with selected environment"
            >
              <RotateCcw className="size-3 shrink-0" aria-hidden="true" />
              <span className="hidden @[48rem]:inline">Apply and restart</span>
            </button>
          ) : null}
          {environmentSelection.error ? (
            <span role="alert" className="text-xs text-destructive">
              {environmentSelection.error}
            </span>
          ) : null}
          {pythonVersion ? (
            <span className="text-xs text-muted-foreground">Python {pythonVersion}</span>
          ) : null}
        </div>
      ) : null}

      {updateAction ? (
        <ToolbarTooltip content={updateAction.title}>
          <button
            type="button"
            onClick={updateAction.onClick}
            data-testid="update-download-button"
            className={cn(
              TOOLBAR_BUTTON_FOCUS,
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-violet-500/10 text-violet-600 hover:bg-violet-500/20 dark:text-violet-400 transition-colors",
            )}
            aria-description={updateAction.title}
          >
            <ArrowDownToLine className="size-3" />
            <span>{updateAction.label}</span>
          </button>
        </ToolbarTooltip>
      ) : null}

      {runtime ? (
        <RuntimeEnvironmentIndicator
          environmentManager={environmentManager}
          runtime={runtime}
          runtimeTarget={runtimeTarget}
          showRuntimePeerIndicator={showRuntimePeerIndicator}
          runtimePeerCount={runtimePeerCount}
          runningEnvironmentLabel={runningEnvironmentLabel}
        />
      ) : null}

      {runtimeStatus ? (
        <div
          className="flex items-center gap-1.5 whitespace-nowrap"
          role="status"
          aria-label={runtimeStatus.ariaLabel}
          data-testid="kernel-status"
          data-kernel-status={runtimeStatus.state}
        >
          {statusTooltip ? (
            <ToolbarTooltip content={statusTooltip} className="gap-1.5">
              {statusReadout}
            </ToolbarTooltip>
          ) : (
            statusReadout
          )}
        </div>
      ) : null}

      {canManageSharing ? sharingControls : null}
      {canRequestEdit ? editControls : null}
      {showAuthControls ? authControls : null}
      {identityControls}
      {trailingControls}
    </div>
  );
}

/**
 * Hover and keyboard-focus hint for one toolbar control. Hints render in the
 * DOM instead of through native `title`, which Electron hosts on macOS stop
 * showing after the first hover (electron/electron#49843).
 *
 * The trigger is a wrapper span, not the control. Disabled buttons emit no
 * pointer events, so the span takes the hover; buttons inside must carry
 * `disabled:pointer-events-none`. Keeping the span mounted in every state
 * means toggling `disabled` never remounts the button. Focus on the inner
 * button bubbles to the span and opens the hint. The control's own
 * `aria-label` names it; add `aria-description` when the hint says more.
 *
 * A hint never claims a key aimed at focus elsewhere. Radix dismisses an
 * open tooltip on Escape from a document capture listener and prevents the
 * event, and CodeMirror and command mode ignore prevented keys, so a hover
 * hint would swallow the Escape that leaves a cell editor. A window capture
 * listener runs first and closes the hint synchronously; `TooltipContent`
 * has no exit animation, so Radix's listener is gone before the key reaches
 * the document. Keys pressed while focus is inside the trigger still go to
 * Radix, which dismisses the hint on Escape.
 *
 * The close runs through Radix's own path, which keeps provider bookkeeping
 * that a controlled `open={false}` skips. Without it, the next hint in the
 * group would open without its delay.
 */
function ToolbarTooltip({
  content,
  disabled = false,
  className,
  children,
}: {
  content: ReactNode;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const releaseKeyAimedElsewhere = (event: KeyboardEvent) => {
      const focus = event.target instanceof Node ? event.target : null;
      if (focus && triggerRef.current?.contains(focus)) return;
      flushSync(() => {
        // Open tooltip content closes when another tooltip announces it is
        // opening. That close resets the provider's skip delay and clears a
        // pending open timer. `setOpen` still closes this hint if the event
        // name ever changes.
        document.dispatchEvent(new CustomEvent(RADIX_TOOLTIP_OPEN_EVENT));
        setOpen(false);
      });
    };
    window.addEventListener("keydown", releaseKeyAimedElsewhere, true);
    return () => window.removeEventListener("keydown", releaseKeyAimedElsewhere, true);
  }, [open]);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span
          ref={triggerRef}
          className={cn("inline-flex items-center", disabled && "cursor-not-allowed", className)}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" collisionPadding={8}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Passive runtime + environment chip. It never takes focus; the tooltip is a
 * hover hint, and screen readers get the same sentence from hidden text.
 */
function RuntimeEnvironmentIndicator({
  environmentManager,
  runtime,
  runtimeTarget,
  showRuntimePeerIndicator,
  runtimePeerCount,
  runningEnvironmentLabel,
}: {
  environmentManager: NotebookEnvironmentManager | null;
  runtime: string;
  runtimeTarget: NotebookShellRuntimeTargetProjection | null;
  showRuntimePeerIndicator: boolean;
  runtimePeerCount: number;
  runningEnvironmentLabel: string | null;
}) {
  const description = runtimeChipDescription({ environmentManager, runtime, runtimeTarget });

  return (
    <ToolbarTooltip content={description}>
      <span
        data-testid="runtime-environment-indicator"
        data-runtime={runtime}
        data-env-manager={environmentManager || undefined}
        data-runtime-target={runtimeTarget?.kind}
        data-runtime-peer-count={showRuntimePeerIndicator ? runtimePeerCount : undefined}
        className={cn(
          "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
          runtime === "deno"
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "bg-blue-500/10 text-blue-600 dark:text-blue-400",
        )}
      >
        <span className="sr-only">{description}</span>
        {runtime === "deno" ? (
          <>
            <DenoIcon className="size-3" aria-hidden="true" />
            <span aria-hidden="true">Deno</span>
          </>
        ) : (
          <>
            <PythonIcon className="size-3" aria-hidden="true" />
            <span aria-hidden="true">Python</span>
          </>
        )}
        {environmentManager ? (
          <>
            <span className="opacity-40" aria-hidden="true">
              /
            </span>
            {environmentManager === "uv" ? (
              <UvIcon
                className="size-2 text-fuchsia-600 dark:text-fuchsia-400"
                aria-hidden="true"
              />
            ) : null}
            {environmentManager === "conda" ? (
              <CondaIcon
                className="size-2.5 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
            ) : null}
            {environmentManager === "pixi" ? (
              <PixiIcon
                className="size-2.5 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
            ) : null}
          </>
        ) : null}
        {runningEnvironmentLabel ? (
          <span
            data-testid="running-environment-name"
            className="ml-1 max-w-32 truncate opacity-75"
          >
            {runningEnvironmentLabel}
          </span>
        ) : null}
        {showRuntimePeerIndicator ? (
          <>
            <span className="opacity-40" aria-hidden="true">
              /
            </span>
            <ServerCog className="size-2.5" aria-hidden="true" />
          </>
        ) : null}
      </span>
    </ToolbarTooltip>
  );
}

function runtimeChipDescription({
  environmentManager,
  runtime,
  runtimeTarget,
}: {
  environmentManager: NotebookEnvironmentManager | null;
  runtime: string;
  runtimeTarget: NotebookShellRuntimeTargetProjection | null;
}): string {
  const parts = [runtime === "deno" ? "Deno/TypeScript runtime" : "Python runtime"];
  if (environmentManager) {
    parts.push(`${environmentManager} environment`);
  }
  parts.push(...runtimeTargetTitleParts(runtimeTarget));
  return parts.join(" · ");
}

function runtimeTargetTitleParts(
  runtimeTarget: NotebookShellRuntimeTargetProjection | null,
): string[] {
  if (!runtimeTarget) return [];

  const parts: string[] = [];
  if (runtimeTarget.label) {
    parts.push(runtimeTarget.label);
  }
  if (runtimeTarget.statusLabel) {
    parts.push(runtimeTarget.statusLabel);
  }
  if (runtimeTarget.kernelStatusLabel) {
    parts.push(`Kernel ${runtimeTarget.kernelStatusLabel}`);
  }
  if (typeof runtimeTarget.runtimePeerCount === "number" && runtimeTarget.runtimePeerCount > 0) {
    parts.push(
      runtimeTarget.runtimePeerCount === 1
        ? "1 compute session"
        : `${runtimeTarget.runtimePeerCount} compute sessions`,
    );
  }
  return parts;
}
