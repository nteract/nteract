import { AlertTriangle, Clock, Settings } from "lucide-react";
import {
  NotebookNotice,
  NotebookNoticeAction,
  NotebookNoticeStack,
} from "@/components/notebook/NotebookNotice";

export interface PoolErrorDetails {
  message: string;
  failed_package?: string;
  error_kind?: string;
  consecutive_failures: number;
  retry_in_secs: number;
  receivedAt: number;
}

interface PoolErrorItemProps {
  envType: "UV" | "Conda" | "Pixi";
  error: PoolErrorDetails;
  onDismiss: () => void;
  onOpenSettings?: () => void;
}

function errorSubtitle(error: PoolErrorDetails, envType: "UV" | "Conda" | "Pixi"): string {
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

function showSettingsButton(error: PoolErrorDetails): boolean {
  return (
    error.error_kind === "invalid_package" ||
    error.error_kind === "import_error" ||
    error.error_kind === undefined
  );
}

function PoolErrorItem({ envType, error, onDismiss, onOpenSettings }: PoolErrorItemProps) {
  const isTimeout = error.error_kind === "timeout";

  return (
    <NotebookNotice
      tone="warning"
      icon={isTimeout ? <Clock className="size-3" /> : <AlertTriangle className="size-3" />}
      title={error.message}
      onDismiss={onDismiss}
      actions={
        showSettingsButton(error) && onOpenSettings ? (
          <NotebookNoticeAction onClick={onOpenSettings} icon={<Settings className="size-3" />}>
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

export interface PoolErrorBannerProps {
  uvError: PoolErrorDetails | null;
  condaError: PoolErrorDetails | null;
  pixiError: PoolErrorDetails | null;
  onDismissUv: () => void;
  onDismissConda: () => void;
  onDismissPixi: () => void;
  onOpenSettings?: () => void;
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
  onOpenSettings,
}: PoolErrorBannerProps) {
  if (!uvError && !condaError && !pixiError) {
    return null;
  }

  return (
    <NotebookNoticeStack>
      {uvError && (
        <PoolErrorItem
          envType="UV"
          error={uvError}
          onDismiss={onDismissUv}
          onOpenSettings={onOpenSettings}
        />
      )}
      {condaError && (
        <PoolErrorItem
          envType="Conda"
          error={condaError}
          onDismiss={onDismissConda}
          onOpenSettings={onOpenSettings}
        />
      )}
      {pixiError && (
        <PoolErrorItem
          envType="Pixi"
          error={pixiError}
          onDismiss={onDismissPixi}
          onOpenSettings={onOpenSettings}
        />
      )}
    </NotebookNoticeStack>
  );
}
