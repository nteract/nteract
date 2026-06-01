import { Copy, Info } from "lucide-react";
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  NotebookCommandToolbar,
  NotebookToolbarFrame,
  type NotebookCommandRuntimeState,
  type NotebookEnvironmentManager,
  type NotebookShellCapabilities,
} from "@/components/notebook-shell";
import type { UpdateStatus } from "../hooks/useUpdater";
import { KERNEL_ERROR_REASON, type EnvProgressState, type ProjectContext } from "runtimed";
import {
  getStatusKeyLabel,
  KERNEL_STATUS,
  type KernelStatus,
  type RuntimeLifecycle,
  type RuntimeStatusKey,
} from "../lib/kernel-status";
import type { KernelspecInfo } from "../types";
import { extractCondaEnvCreateCommand } from "./EnvBuildDecisionDialog";

/** Badge color variant for environment sources */
type EnvBadgeVariant = NotebookEnvironmentManager;

interface NotebookToolbarProps {
  kernelStatus: KernelStatus;
  statusKey: RuntimeStatusKey;
  lifecycle: RuntimeLifecycle;
  errorReason: string | null;
  kernelErrorMessage?: string | null;
  envSource: string | null;
  condaPython?: string | null;
  condaChannels?: string[] | null;
  projectContext?: ProjectContext | null;
  /** Pre-start hint: "uv" | "conda" | "pixi" | null, derived from notebook metadata */
  envTypeHint?: EnvBadgeVariant | null;
  envProgress: EnvProgressState | null;
  runtime?: string | null;
  onStartKernel: (name: string) => void;
  onInterruptKernel: () => void;
  onRestartKernel: () => void;
  onRunAllCells: () => void;
  onRestartAndRunAll: () => void;
  focusedCellId?: string | null;
  lastCellId?: string | null;
  onAddCell: (type: "code" | "markdown", afterCellId?: string | null) => void;
  onToggleDependencies: () => void;
  isDepsOpen?: boolean;
  capabilities: Pick<
    NotebookShellCapabilities,
    | "canEditStructure"
    | "canExecute"
    | "canViewPackages"
    | "canManageSharing"
    | "canRequestEdit"
    | "auth"
  >;
  listKernelspecs?: () => Promise<KernelspecInfo[]>;
  depsOutOfSync?: boolean;
  updateStatus?: UpdateStatus;
  updateVersion?: string | null;
  onRestartToUpdate?: () => void;
  trailingControls?: ReactNode;
}

export function NotebookToolbar({
  kernelStatus,
  statusKey,
  lifecycle,
  errorReason,
  kernelErrorMessage,
  envSource,
  condaPython = null,
  condaChannels = null,
  projectContext = null,
  envTypeHint,
  envProgress,
  runtime = null,
  onStartKernel,
  onInterruptKernel,
  onRestartKernel,
  onRunAllCells,
  onRestartAndRunAll,
  focusedCellId,
  lastCellId,
  onAddCell,
  onToggleDependencies,
  isDepsOpen = false,
  capabilities,
  depsOutOfSync = false,
  listKernelspecs,
  updateStatus,
  updateVersion,
  onRestartToUpdate,
  trailingControls,
}: NotebookToolbarProps) {
  const [kernelspecs, setKernelspecs] = useState<KernelspecInfo[]>([]);
  const [condaCommandCopied, setCondaCommandCopied] = useState(false);

  useEffect(() => {
    if (listKernelspecs) {
      listKernelspecs().then(setKernelspecs);
    }
  }, [listKernelspecs]);

  useEffect(() => {
    setCondaCommandCopied(false);
  }, [kernelErrorMessage]);

  const handleStartKernel = useCallback(() => {
    // In daemon mode (no listKernelspecs), just call with empty name - backend auto-selects
    if (!listKernelspecs) {
      onStartKernel("");
      return;
    }
    // Default to python3 or first available
    const python = kernelspecs.find((k) => k.name === "python3" || k.name === "python");
    const spec = python ?? kernelspecs[0];
    if (spec) {
      onStartKernel(spec.name);
    }
  }, [kernelspecs, onStartKernel, listKernelspecs]);

  // `statusKey` is already the throttled runtime vocabulary from
  // `useDaemonKernel` — the `RUNNING_BUSY` ↔ `RUNNING_IDLE` transition
  // has been smoothed over sub-60ms blips; every other sub-state (launching,
  // resolving, …) passes through untouched with its richer label.
  const kernelStatusText = getStatusKeyLabel(statusKey, errorReason);
  const hasToolbarHandledIpykernelError =
    errorReason === KERNEL_ERROR_REASON.MISSING_IPYKERNEL ||
    errorReason === KERNEL_ERROR_REASON.DEPENDENCY_CACHE_MISSING_IPYKERNEL ||
    errorReason === KERNEL_ERROR_REASON.IPYKERNEL_SITE_PACKAGES_MISMATCH;
  const envErrorMessage = envProgress?.error ?? null;
  const envStatusText = envProgress?.statusText ?? kernelStatusText;
  const kernelStatusDescription = envProgress?.isActive
    ? envStatusText
    : envErrorMessage
      ? envStatusText
      : kernelStatus === KERNEL_STATUS.ERROR && kernelErrorMessage
        ? `Error \u2014 ${kernelErrorMessage}`
        : kernelStatusText;
  const kernelStatusTooltip = envProgress?.isActive
    ? envStatusText
    : kernelStatus === KERNEL_STATUS.ERROR && kernelErrorMessage
      ? `Error \u2014 ${kernelErrorMessage}`
      : kernelStatusText;
  const condaEnvCreateCommand = extractCondaEnvCreateCommand(kernelErrorMessage ?? null);
  const showCondaEnvYmlMissingBanner =
    runtime === "python" &&
    lifecycle.lifecycle === "Error" &&
    errorReason === KERNEL_ERROR_REASON.CONDA_ENV_YML_MISSING &&
    !!kernelErrorMessage;
  const copyCondaEnvCommand = useCallback(async () => {
    if (!condaEnvCreateCommand) return;
    await navigator.clipboard.writeText(condaEnvCreateCommand);
    setCondaCommandCopied(true);
  }, [condaEnvCreateCommand]);

  // Derive env manager label for the runtime pill (e.g. "uv", "conda", "pixi")
  const envManager: EnvBadgeVariant | null =
    runtime === "python"
      ? envSource && (kernelStatus === KERNEL_STATUS.IDLE || kernelStatus === KERNEL_STATUS.BUSY)
        ? envSource.startsWith("pixi:")
          ? "pixi"
          : envSource.startsWith("conda")
            ? "conda"
            : "uv"
        : (envTypeHint ?? null)
      : null;
  const runtimeStatusState = notebookCommandRuntimeState(kernelStatus, Boolean(envErrorMessage));
  const runtimeStatusError = envErrorMessage ? (
    <HoverCard openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span className="cursor-help text-red-600 underline decoration-dotted underline-offset-2 dark:text-red-400">
          {envStatusText}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-3">
        <div className="space-y-1">
          <p className="text-xs font-medium text-red-600 dark:text-red-400">Environment error</p>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
            {envErrorMessage}
          </pre>
        </div>
      </HoverCardContent>
    </HoverCard>
  ) : null;

  const notices = (
    <>
      {/* Deno install prompt */}
      {runtime === "deno" && kernelStatus === KERNEL_STATUS.ERROR && kernelErrorMessage && (
        <div className="border-t px-3 py-2">
          <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              <span className="font-medium">Deno not available.</span> Auto-install failed. Install
              manually with{" "}
              <code className="rounded bg-amber-500/20 px-1">
                curl -fsSL https://deno.land/install.sh | sh
              </code>{" "}
              and restart.
            </span>
          </div>
        </div>
      )}
      {/* ipykernel install prompt — only when daemon signals missing_ipykernel.
          Pixi and uv/conda inline envs reach this state through different
          mechanisms (pixi.toml scan vs prepared-env scan), but the UX is the
          same shape: explain where ipykernel should go for the current env,
          then tell the user to restart. */}
      {runtime === "python" &&
        lifecycle.lifecycle === "Error" &&
        envSource &&
        hasToolbarHandledIpykernelError &&
        renderIpykernelErrorPrompt({
          envSource,
          errorReason,
          errorDetails: kernelErrorMessage ?? null,
          condaPython,
          condaChannels,
          projectContext,
        })}
      {showCondaEnvYmlMissingBanner && (
        <CondaEnvYmlMissingBanner
          details={kernelErrorMessage}
          command={condaEnvCreateCommand}
          copied={condaCommandCopied}
          onCopyCommand={copyCondaEnvCommand}
        />
      )}
    </>
  );

  return (
    <NotebookToolbarFrame notices={notices}>
      <NotebookCommandToolbar
        capabilities={capabilities}
        runtime={runtime}
        environmentManager={envManager}
        environmentPanelOpen={isDepsOpen}
        environmentOutOfSync={depsOutOfSync}
        runtimeStatus={{
          state: runtimeStatusState,
          label: envProgress?.isActive ? (
            envStatusText
          ) : (
            <span
              className={
                kernelStatus === KERNEL_STATUS.ERROR
                  ? "capitalize text-red-600 dark:text-red-400"
                  : "capitalize"
              }
            >
              {kernelStatusText}
            </span>
          ),
          ariaLabel: `Kernel: ${kernelStatusDescription}`,
          title: kernelStatusTooltip,
          error: runtimeStatusError,
        }}
        startDisabled={Boolean(listKernelspecs && kernelspecs.length === 0)}
        addAfterCellId={focusedCellId ?? lastCellId}
        onAddCell={onAddCell}
        onStartRuntime={handleStartKernel}
        onInterruptRuntime={onInterruptKernel}
        onRestartRuntime={onRestartKernel}
        onRunAllCells={onRunAllCells}
        onRestartAndRunAll={onRestartAndRunAll}
        onTogglePackages={onToggleDependencies}
        updateAction={
          updateStatus === "available" && onRestartToUpdate
            ? {
                label: `Update ${updateVersion}`,
                title: `Prepare to update to v${updateVersion}`,
                onClick: onRestartToUpdate,
              }
            : null
        }
        identityControls={trailingControls}
      />
    </NotebookToolbarFrame>
  );
}

function notebookCommandRuntimeState(
  kernelStatus: KernelStatus,
  hasEnvironmentError: boolean,
): NotebookCommandRuntimeState {
  if (hasEnvironmentError) {
    return "error";
  }
  switch (kernelStatus) {
    case KERNEL_STATUS.NOT_STARTED:
    case KERNEL_STATUS.AWAITING_TRUST:
    case KERNEL_STATUS.AWAITING_ENV_BUILD:
      return "not_started";
    case KERNEL_STATUS.STARTING:
      return "starting";
    case KERNEL_STATUS.IDLE:
      return "idle";
    case KERNEL_STATUS.BUSY:
      return "busy";
    case KERNEL_STATUS.ERROR:
      return "error";
    case KERNEL_STATUS.SHUTDOWN:
      return "shutdown";
  }
}

/** Remediation copy for `KernelErrorReason::MissingIpykernel`, branched by
 * env source. Returns `null` for env sources the daemon does not gate on
 * (prewarmed pools, uv:pyproject, conda:env_yml, deno) — those either
 * self-heal at launch or should never reach this state.
 *
 * For inline/PEP 723 envs the daemon previously deleted the corrupt
 * cache dir so a plain restart would rebuild. That delete was reverted
 * (shared content-addressed cache + concurrent-install race), so a
 * restart alone now re-hits the same broken cache. Until we add an
 * in-place repair, the way out is to bump the dep hash — add, pin, or
 * remove anything in the notebook's deps — or clear the daemon cache. */
function renderIpykernelErrorPrompt({
  envSource,
  errorReason,
  errorDetails,
  condaPython,
  condaChannels,
  projectContext,
}: {
  envSource: string;
  errorReason: string | null;
  errorDetails: string | null;
  condaPython: string | null;
  condaChannels: string[] | null;
  projectContext: ProjectContext | null;
}): ReactElement | null {
  // Pixi project: the .toml is the source of truth; user must add
  // ipykernel explicitly.
  if (errorReason === KERNEL_ERROR_REASON.MISSING_IPYKERNEL && envSource.startsWith("pixi:")) {
    return (
      <RuntimeErrorBanner
        headline="ipykernel not found in pixi.toml."
        instruction={
          <>
            Run <code className="rounded bg-amber-500/20 px-1">pixi add ipykernel</code> in your
            project directory and restart.
          </>
        }
      />
    );
  }

  const contextItems = buildCondaContextItems(
    envSource,
    condaPython,
    condaChannels,
    projectContext,
  );

  // Inline / PEP 723 / inline conda: env is a shared content-addressed
  // cache — we can't safely delete it from the launch path. Bump the
  // hash instead.
  if (
    errorReason === KERNEL_ERROR_REASON.DEPENDENCY_CACHE_MISSING_IPYKERNEL &&
    (envSource === "uv:inline" || envSource === "uv:pep723" || envSource === "conda:inline")
  ) {
    return (
      <RuntimeErrorBanner
        headline="Dependency cache is missing ipykernel."
        instruction={
          <>
            Edit any notebook dependency (add, remove, or pin a version) to rebuild the environment,
            or clear the daemon cache.
          </>
        }
        contextItems={contextItems}
        details={errorDetails}
      />
    );
  }

  if (errorReason === KERNEL_ERROR_REASON.IPYKERNEL_SITE_PACKAGES_MISMATCH) {
    return (
      <RuntimeErrorBanner
        headline="Conda installed ipykernel outside this Python's import path."
        instruction={
          <>
            Conda/Python ABI mismatch: pin Python in the dependency panel and rebuild the
            environment, or clear the daemon cache.
          </>
        }
        contextItems={contextItems}
        details={errorDetails}
      />
    );
  }
  return null;
}

function buildCondaContextItems(
  envSource: string,
  condaPython: string | null,
  condaChannels: string[] | null,
  projectContext: ProjectContext | null,
): string[] {
  const items = [`Environment: ${envSource}`];
  if (envSource.startsWith("conda:")) {
    items.push(`Manager: conda`);
    if (condaPython) items.push(`Python: ${condaPython}`);
    if (condaChannels?.length) items.push(`Channels: ${condaChannels.join(", ")}`);
  }
  if (projectContext?.state === "Detected") {
    items.push(`Project: ${projectContext.project_file.relative_to_notebook}`);
  }
  return items;
}

function CondaEnvYmlMissingBanner({
  details,
  command,
  copied,
  onCopyCommand,
}: {
  details: string;
  command: string | null;
  copied: boolean;
  onCopyCommand: () => void;
}): ReactElement {
  return (
    <div className="border-t px-3 py-2" data-testid="conda-env-yml-missing-banner">
      <div className="flex items-start justify-between gap-3 text-xs text-amber-800 dark:text-amber-300">
        <div className="flex min-w-0 items-start gap-2">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-medium">Conda environment not built.</span> <span>{details}</span>
          </span>
        </div>
        {command && (
          <button
            type="button"
            onClick={onCopyCommand}
            className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-500/20 dark:text-amber-200"
            data-testid="copy-conda-env-command"
          >
            <Copy className="h-3 w-3" />
            {copied ? "Copied" : "Copy command"}
          </button>
        )}
      </div>
    </div>
  );
}

function RuntimeErrorBanner({
  headline,
  instruction,
  contextItems = [],
  details = null,
}: {
  headline: string;
  instruction: ReactNode;
  contextItems?: string[];
  details?: string | null;
}): ReactElement {
  return (
    <div className="border-t px-3 py-2">
      <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <div className="min-w-0 space-y-1">
          <div>
            <span className="font-medium">{headline}</span> {instruction}
          </div>
          {contextItems.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-amber-800/80 dark:text-amber-300/80">
              {contextItems.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          )}
          {details && (
            <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-amber-500/10 px-2 py-1 font-mono text-[11px] leading-relaxed text-amber-900 dark:text-amber-100">
              {details}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
