import {
  ArrowDownToLine,
  ChevronsRight,
  Code,
  LetterText,
  Play,
  RotateCcw,
  Square,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { NotebookShellCapabilities } from "./capabilities";

export type NotebookCommandRuntimeState =
  | "not_started"
  | "starting"
  | "idle"
  | "busy"
  | "error"
  | "shutdown"
  | "unknown";

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
  addAfterCellId?: string | null;
  onAddCell?: (type: "code" | "markdown", afterCellId?: string | null) => unknown;
  onStartRuntime?: () => void;
  onInterruptRuntime?: () => void;
  onRestartRuntime?: () => void;
  onRunAllCells?: () => void;
  onRestartAndRunAll?: () => void;
  onTogglePackages?: () => void;
  updateAction?: NotebookCommandToolbarUpdateAction | null;
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
  addAfterCellId = null,
  onAddCell,
  onStartRuntime,
  onInterruptRuntime,
  onRestartRuntime,
  onRunAllCells,
  onRestartAndRunAll,
  onTogglePackages,
  updateAction = null,
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
  const hasRuntimeStatus = Boolean(runtimeStatus);
  const isRuntimeRunning =
    runtimeStatus?.state === "idle" ||
    runtimeStatus?.state === "busy" ||
    runtimeStatus?.state === "starting";
  const showAddCellControls = canEditStructure && Boolean(onAddCell);
  const showRuntimeStart =
    hasRuntimeStatus && canExecute && !isRuntimeRunning && Boolean(onStartRuntime);
  const showRuntimeActions =
    hasRuntimeStatus &&
    canExecute &&
    Boolean(onRunAllCells && onRestartRuntime && onRestartAndRunAll);
  const showInterrupt =
    hasRuntimeStatus && canExecute && isRuntimeRunning && Boolean(onInterruptRuntime);
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
            className="flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Add code cell"
            aria-label="Add code cell"
            data-testid="add-code-cell-button"
          >
            <Code className="h-3 w-3" />
            <span className="hidden @[40rem]:inline">Code</span>
          </button>
          <button
            type="button"
            onClick={() => onAddCell?.("markdown", addAfterCellId)}
            className="flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Add markdown cell"
            aria-label="Add markdown cell"
            data-testid="add-markdown-cell-button"
          >
            <LetterText className="h-3 w-3" />
            <span className="hidden @[40rem]:inline">Markdown</span>
          </button>
        </>
      ) : null}

      {showAddCellControls && (showRuntimeStart || showRuntimeActions || showInterrupt) ? (
        <div className="h-4 w-px bg-border" />
      ) : null}

      {showRuntimeStart ? (
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

      {showRuntimeActions ? (
        <>
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
        </>
      ) : null}

      {showInterrupt ? (
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

function DenoIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
      <path d="M13.47 20.882l-1.47 -5.882c-2.649 -.088 -5 -1.624 -5 -3.5c0 -1.933 2.239 -3.5 5 -3.5s4 1 5 3c.024 .048 .69 2.215 2 6.5" />
      <path d="M12 11h.01" />
    </svg>
  );
}

function PythonIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 9h-7a2 2 0 0 0 -2 2v4a2 2 0 0 0 2 2h3" />
      <path d="M12 15h7a2 2 0 0 0 2 -2v-4a2 2 0 0 0 -2 -2h-3" />
      <path d="M8 9v-4a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v5a2 2 0 0 1 -2 2h-4a2 2 0 0 0 -2 2v5a2 2 0 0 0 2 2h4a2 2 0 0 0 2 -2v-4" />
      <path d="M11 6l0 .01" />
      <path d="M13 18l0 .01" />
    </svg>
  );
}

function UvIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 41 41"
      fill="currentColor"
      className={className}
    >
      <path d="M-5.28619e-06 0.168629L0.0843098 20.1685L0.151762 36.1683C0.161075 38.3774 1.95947 40.1607 4.16859 40.1514L20.1684 40.084L30.1684 40.0418L31.1852 40.0375C33.3877 40.0282 35.1683 38.2026 35.1683 36V36L37.0003 36L37.0003 39.9992L40.1683 39.9996L39.9996 -9.94653e-07L21.5998 0.0775689L21.6774 16.0185L21.6774 25.9998L20.0774 25.9998L18.3998 25.9998L18.4774 16.032L18.3998 0.0910593L-5.28619e-06 0.168629Z" />
    </svg>
  );
}

function CondaIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 23.565 27.149"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="0.25px"
      className={className}
    >
      <path
        d="M47.3 23.46c-.69-1.27-2.08-3.82-4.51-6.25-.81 3.47-.81 6.48-.69 7.99-.12 0 2.2-1.16 5.2-1.74zM36.54 28.32c-1.27-1.04-3.7-2.89-7.28-4.4.92 3.82 2.43 6.6 3.24 7.99 0 .23 1.62-1.74 4.05-3.59zM50.67 20.08c.81-2.08 2.31-5.09 4.74-8.22-1.5-2.66-3.58-5.32-6.36-7.64-2.2 2.78-3.7 5.56-4.74 8.33 3.12 2.66 5.09 5.44 6.36 7.52zM29.15 36.66c-1.22-.22-2.56-.41-4-.52a40.19 40.19 0 0 0-5.77-.06c1.01 1.29 2.24 2.71 3.73 4.14A39.43 39.43 0 0 0 26.35 43c.35-1.03.77-2.12 1.28-3.28a43.76 43.76 0 0 1 1.51-3.06zM11.92 49.15c4.16-2.66 8.09-3.82 10.75-4.17-2.08-1.74-5.09-4.51-7.52-8.33-3.47.69-7.01 2.02-10.36 4.33 1.97 3.47 4.47 6.2 7.12 8.17zM25.21 48.11c-1.62.12-5.56.34-10.19 3.12 4.28 2.66 8.22 4.06 10.19 4.52-.35-2.55-.35-5.21 0-7.64zM39.21 14.02c-2.54-1.74-5.78-3.24-9.83-4.17-.81 3.47-.92 6.71-.69 9.49 3.93 1.27 6.94 3.12 9.02 4.63 0-2.31.35-5.9 1.5-9.95z"
        fillRule="evenodd"
        transform="matrix(.26458 0 0 .26458 -.189 -.253)"
      />
    </svg>
  );
}

function PixiIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 27.4 40.2"
      fill="currentColor"
      className={className}
    >
      <path d="M27.116 3.67449C27.0374 1.63273 25.7268 0.270764 23.633 0.19141C16.9597-0.0609578 10.2854-0.0667476 3.61182 0.19175C1.56495 0.270764 0.211498 1.63273 0.128738 3.67449C0.0507459 5.60828 0.00647096 8.27738 0 9.98946C0 10.843 0.666168 11.488 1.56086 11.488C2.04414 11.488 2.46169 11.2956 2.74845 10.988C2.7539 10.985 2.76174 10.9846 2.76548 10.9802C3.03897 10.6791 3.2348 10.3079 3.50385 10.001C3.83217 9.62675 4.21021 9.28515 4.63219 9.0195C5.45945 8.49842 6.37151 8.20655 7.44535 8.20655C10.2694 8.20655 12.5673 10.2745 12.5673 13.3496C12.5673 16.4638 10.3297 18.5679 7.27779 18.5679C5.44514 18.5679 3.82195 17.7733 2.92351 16.2333C2.91193 16.2132 2.89695 16.1978 2.88469 16.1791C2.8789 16.1709 2.87311 16.1631 2.86732 16.1549C2.83019 16.1028 2.78932 16.0558 2.74505 16.0139C2.45862 15.7088 2.0421 15.518 1.5612 15.518C0.777537 15.518 0.169607 16.0132 0.0306519 16.7094C0.00919558 16.7714 0 16.8555 0.000340577 17.0162C0.00613038 18.7246 0.0527894 21.6614 0.129079 23.6953C0.166542 24.6952 0.572169 25.6696 1.34017 26.3269C2.21647 27.0772 3.21028 27.0776 4.28207 27.272C4.6516 27.3391 5.02215 27.4587 5.30585 27.7148C5.7159 28.0853 5.86712 28.6974 5.73531 29.2338C5.59125 29.8185 5.17268 30.2007 4.69996 30.5327C4.26232 30.8403 3.85874 31.1689 3.5168 31.5837C2.78694 32.4686 2.4089 33.5853 2.4089 34.7293C2.4089 37.8435 4.56986 40.0764 7.72326 40.0764C10.8375 40.0764 13.0836 37.9808 13.0836 35.0426C13.0836 33.8976 12.7699 32.7509 12.0912 31.8191C11.7683 31.376 11.3708 30.9935 10.9213 30.6809C10.47 30.3672 10.0136 30.1349 9.78409 29.5989C9.65433 29.2954 9.6104 28.9531 9.68362 28.6296C10.0068 27.1981 11.6052 27.3551 12.7233 27.3592C14.2909 27.365 15.8586 27.3579 17.426 27.3364C19.4956 27.3081 21.565 27.2557 23.6333 27.178C25.5899 27.1045 27.0377 25.6999 27.1164 23.695C27.3783 17.0217 27.3735 10.3474 27.1164 3.67381Z" />
    </svg>
  );
}
