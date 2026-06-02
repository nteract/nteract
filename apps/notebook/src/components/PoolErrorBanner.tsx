import { useNotebookHost } from "@nteract/notebook-host";
import { AlertTriangle, Clock, Settings } from "lucide-react";
import {
  NotebookNotice,
  NotebookNoticeAction,
  NotebookNoticeStack,
} from "@/components/notebook/NotebookNotice";
import type { PoolErrorWithTimestamp } from "../hooks/usePoolState";

interface PoolErrorItemProps {
  envType: "UV" | "Conda" | "Pixi";
  error: PoolErrorWithTimestamp;
  onDismiss: () => void;
}

function errorSubtitle(error: PoolErrorWithTimestamp, envType: "UV" | "Conda" | "Pixi"): string {
  switch (error.error_kind) {
    case "timeout":
      return "Retrying automatically";
    case "import_error":
      return `Check package compatibility in ${envType.toLowerCase()} settings`;
    case "setup_failed":
      return "Retrying automatically";
    default:
      return `Check package name in ${envType.toLowerCase()} settings`;
  }
}

function showSettingsButton(error: PoolErrorWithTimestamp): boolean {
  return (
    error.error_kind === "invalid_package" ||
    error.error_kind === "import_error" ||
    error.error_kind === undefined
  );
}

function PoolErrorItem({ envType, error, onDismiss }: PoolErrorItemProps) {
  const host = useNotebookHost();
  const openSettings = () => {
    host.settings.openWindow().catch((e) => {
      console.error("Failed to open settings:", e);
    });
  };

  const isTimeout = error.error_kind === "timeout";

  return (
    <NotebookNotice
      tone="warning"
      icon={isTimeout ? <Clock className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
      title={error.message}
      onDismiss={onDismiss}
      actions={
        showSettingsButton(error) ? (
          <NotebookNoticeAction onClick={openSettings} icon={<Settings className="h-3 w-3" />}>
            Settings
          </NotebookNoticeAction>
        ) : null
      }
    >
      {error.failed_package ? (
        <>
          <code className="rounded bg-amber-500/20 px-1">{error.failed_package}</code>
          <span> </span>
        </>
      ) : null}
      {errorSubtitle(error, envType)}
    </NotebookNotice>
  );
}

interface PoolErrorBannerProps {
  uvError: PoolErrorWithTimestamp | null;
  condaError: PoolErrorWithTimestamp | null;
  pixiError: PoolErrorWithTimestamp | null;
  onDismissUv: () => void;
  onDismissConda: () => void;
  onDismissPixi: () => void;
}

/**
 * Banner component showing pool warming errors.
 *
 * Displays amber warning banners for UV, Conda, and Pixi pool errors,
 * with contextual messages based on error type.
 */
export function PoolErrorBanner({
  uvError,
  condaError,
  pixiError,
  onDismissUv,
  onDismissConda,
  onDismissPixi,
}: PoolErrorBannerProps) {
  if (!uvError && !condaError && !pixiError) {
    return null;
  }

  return (
    <NotebookNoticeStack>
      {uvError && <PoolErrorItem envType="UV" error={uvError} onDismiss={onDismissUv} />}
      {condaError && (
        <PoolErrorItem envType="Conda" error={condaError} onDismiss={onDismissConda} />
      )}
      {pixiError && <PoolErrorItem envType="Pixi" error={pixiError} onDismiss={onDismissPixi} />}
    </NotebookNoticeStack>
  );
}
