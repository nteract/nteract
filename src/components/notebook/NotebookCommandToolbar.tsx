import {
  ArrowDownToLine,
  ChevronsRight,
  Code,
  Cpu,
  LetterText,
  Play,
  RotateCcw,
  Square,
} from "lucide-react";
import type { ReactNode } from "react";
import { CondaIcon, DenoIcon, PixiIcon, PythonIcon, UvIcon } from "@/components/environment";
import { cn } from "@/lib/utils";
import {
  projectNotebookCommandRuntimeActions,
  type NotebookCommandRuntimeState,
  type NotebookShellCapabilities,
} from "./capabilities";

export type { NotebookCommandRuntimeState } from "./capabilities";

export type NotebookEnvironmentManager = "uv" | "conda" | "pixi";

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
  label: string;
  title: string;
  onClick: () => void;
}

export interface NotebookCommandToolbarProps {
  capabilities: Pick<
    NotebookShellCapabilities,
    | "canEditStructure"
    | "canExecute"
    | "canViewPackages"
    | "canManageSharing"
    | "canRequestEdit"
    | "auth"
  >;
  runtime?: string | null;
  environmentManager?: NotebookEnvironmentManager | null;
  environmentPanelOpen?: boolean;
  environmentOutOfSync?: boolean;
  runtimeStatus?: NotebookCommandToolbarStatus | null;
  startDisabled?: boolean;
  addCellControlsDisabled?: boolean;
  addAfterCellId?: string | null;
  onAddCell?: (type: "code" | "markdown", afterCellId?: string | null) => unknown;
  onStartRuntime?: () => void;
  onInterruptRuntime?: () => void;
  onRestartRuntime?: () => void;
  onRunAllCells?: () => void;
  onRestartAndRunAll?: () => void;
  onTogglePackages?: () => void;
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

export function NotebookCommandToolbar({
  capabilities,
  runtime = null,
  environmentManager = null,
  environmentPanelOpen = false,
  environmentOutOfSync = false,
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
  onTogglePackages,
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
  const { auth, canEditStructure, canExecute, canManageSharing, canRequestEdit, canViewPackages } =
    capabilities;
  const showAddCellControls = Boolean(onAddCell) && (canEditStructure || addCellControlsDisabled);
  const runtimeActions = projectNotebookCommandRuntimeActions({
    capabilities: { canExecute },
    runtimeStatus,
    actions: {
      interruptRuntime: Boolean(onInterruptRuntime),
      restartAndRunAll: Boolean(onRestartAndRunAll),
      restartRuntime: Boolean(onRestartRuntime),
      runAllCells: Boolean(onRunAllCells),
      startRuntime: Boolean(onStartRuntime),
    },
  });
  const showPackageToggle = Boolean(runtime && canViewPackages && onTogglePackages);
  const showAuthControls =
    Boolean(authControls) &&
    (auth.canSignIn || auth.canUseAuthenticatedIdentity || auth.needsAttention);

  return (
    <div
      data-testid="notebook-toolbar"
      data-slot="notebook-command-toolbar"
      className={cn("@container flex h-10 min-w-0 items-center gap-2 px-3 select-none", className)}
    >
      {presenceControls ?? leadingControls}

      {showAddCellControls ? (
        <>
          <button
            type="button"
            onClick={() => onAddCell?.("code", addAfterCellId)}
            disabled={addCellControlsDisabled}
            className="flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            title={addCellControlsDisabled ? "Checking edit access" : "Add code cell"}
            aria-label="Add code cell"
            data-testid="add-code-cell-button"
          >
            <Code className="h-3 w-3" />
            <span className="hidden @[40rem]:inline">Code</span>
          </button>
          <button
            type="button"
            onClick={() => onAddCell?.("markdown", addAfterCellId)}
            disabled={addCellControlsDisabled}
            className="flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            title={addCellControlsDisabled ? "Checking edit access" : "Add markdown cell"}
            aria-label="Add markdown cell"
            data-testid="add-markdown-cell-button"
          >
            <LetterText className="h-3 w-3" />
            <span className="hidden @[40rem]:inline">Markdown</span>
          </button>
        </>
      ) : null}

      {showAddCellControls && runtimeActions.showAnyRuntimeAction ? (
        <div className="h-4 w-px bg-border" />
      ) : null}

      {runtimeActions.showRuntimeStart ? (
        <button
          type="button"
          onClick={onStartRuntime}
          disabled={startDisabled}
          className="flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          title="Start kernel"
          aria-label="Start kernel"
          data-testid="start-kernel-button"
        >
          <Play className="h-3 w-3" fill="currentColor" />
          <span className="hidden @[40rem]:inline">Start kernel</span>
        </button>
      ) : null}

      {runtimeActions.showRunAll ? (
        <button
          type="button"
          onClick={onRunAllCells}
          className="flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted"
          title="Run all cells"
          aria-label="Run all cells"
          data-testid="run-all-button"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
          <span className="hidden @[40rem]:inline">Run all</span>
        </button>
      ) : null}

      {runtimeActions.showRestart ? (
        <button
          type="button"
          onClick={onRestartRuntime}
          className="flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted"
          title="Restart kernel"
          aria-label="Restart kernel"
          data-testid="restart-kernel-button"
        >
          <RotateCcw className="h-3 w-3" />
          <span className="hidden @[40rem]:inline">Restart</span>
        </button>
      ) : null}

      {runtimeActions.showRestartAndRunAll ? (
        <button
          type="button"
          onClick={onRestartAndRunAll}
          className={cn(
            "flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors",
            environmentOutOfSync
              ? "bg-amber-500/10 text-amber-700 ring-1 ring-amber-500/30 hover:bg-amber-500/20 dark:text-amber-400"
              : "text-foreground hover:bg-muted",
          )}
          title={
            environmentOutOfSync
              ? "Dependencies changed - restart kernel and run all cells"
              : "Restart kernel and run all cells"
          }
          data-testid="restart-run-all-button"
        >
          <RotateCcw className="h-3 w-3" />
          <ChevronsRight className="h-3 w-3 -ml-1" />
        </button>
      ) : null}

      {runtimeActions.showInterrupt ? (
        <button
          type="button"
          onClick={onInterruptRuntime}
          className={cn(
            "flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs transition-colors",
            runtimeStatus?.state === "busy"
              ? "text-destructive hover:bg-destructive/10"
              : "text-foreground hover:bg-muted",
          )}
          title="Interrupt kernel"
          aria-label="Interrupt kernel"
          data-testid="interrupt-kernel-button"
        >
          <Square
            className="h-3 w-3"
            fill={runtimeStatus?.state === "busy" ? "currentColor" : "none"}
          />
          <span className="hidden @[40rem]:inline">Interrupt</span>
        </button>
      ) : null}

      {workstationAction ? (
        <button
          type="button"
          onClick={workstationAction.onClick}
          className="flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={workstationAction.title}
          aria-label={workstationAction.label}
          data-testid="workstation-setup-button"
        >
          <Cpu className="h-3 w-3" />
          <span className="hidden @[40rem]:inline">{workstationAction.label}</span>
        </button>
      ) : null}

      <div className="flex-1" />

      {utilityControls}

      {updateAction ? (
        <button
          type="button"
          onClick={updateAction.onClick}
          data-testid="update-download-button"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-violet-500/10 text-violet-600 hover:bg-violet-500/20 dark:text-violet-400 transition-colors"
          title={updateAction.title}
        >
          <ArrowDownToLine className="h-3 w-3" />
          <span>{updateAction.label}</span>
        </button>
      ) : null}

      {showPackageToggle ? (
        <button
          type="button"
          onClick={onTogglePackages}
          data-testid="deps-toggle"
          data-runtime={runtime ?? undefined}
          data-env-manager={environmentManager || undefined}
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
            runtime === "deno"
              ? "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400"
              : "bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 dark:text-blue-400",
            environmentPanelOpen && "ring-1 ring-current/25",
          )}
          title={(() => {
            const lang = runtime === "deno" ? "Deno/TypeScript" : "Python";
            const manager = environmentManager ? ` / ${environmentManager}` : "";
            const action = environmentPanelOpen
              ? "close environment panel"
              : "open environment panel";
            return `${lang}${manager} - ${action}`;
          })()}
        >
          {runtime === "deno" ? (
            <>
              <DenoIcon className="h-3 w-3" />
              <span>Deno</span>
            </>
          ) : (
            <>
              <PythonIcon className="h-3 w-3" />
              <span>Python</span>
            </>
          )}
          {environmentManager ? (
            <>
              <span className="opacity-40">/</span>
              {environmentManager === "uv" ? (
                <UvIcon className="h-2 w-2 text-fuchsia-600 dark:text-fuchsia-400" />
              ) : null}
              {environmentManager === "conda" ? (
                <CondaIcon className="h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400" />
              ) : null}
              {environmentManager === "pixi" ? (
                <PixiIcon className="h-2.5 w-2.5 text-amber-600 dark:text-amber-400" />
              ) : null}
            </>
          ) : null}
        </button>
      ) : null}

      {runtimeStatus ? (
        <div
          className="flex items-center gap-1.5 whitespace-nowrap"
          role="status"
          aria-label={runtimeStatus.ariaLabel}
          title={runtimeStatus.error ? undefined : runtimeStatus.title}
          data-testid="kernel-status"
          data-kernel-status={runtimeStatus.state}
        >
          <div
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
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
