import { AlertCircle, Check, Copy, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { KERNEL_ERROR_REASON, type RuntimeLifecycle } from "runtimed";
import { Button } from "@/components/ui/button";
import { NotebookNotice } from "@/components/notebook/NotebookNotice";

/**
 * Decide whether the generic kernel-launch banner should render.
 *
 * Exported as a pure function so unit tests can exercise the gating
 * without mounting App.tsx (which needs a NotebookHost + WASM). The
 * call site in App.tsx composes this with `dismissedLaunchError` for
 * dismissal state.
 *
 * Rules:
 *
 * - Only show in `Error` state with non-empty `errorDetails`.
 * - Skip typed remediation cases such as missing ipykernel,
 *   dependency-cache mismatches, and missing environment.yml builds:
 *   toolbar renders targeted prompts that already consume the error message.
 * - Skip `runtime === "deno"`: toolbar renders the Deno
 *   "auto-install failed" prompt that already consumes it.
 *
 * Everything else — solver/install errors, stderr tails from generic
 * subprocess crashes, env-build rate limits — falls through to this banner.
 */
export function shouldShowKernelLaunchErrorBanner(params: {
  lifecycle: RuntimeLifecycle;
  errorDetails: string | null;
  errorReason: string | null;
  runtime: string | null;
}): boolean {
  if (params.lifecycle.lifecycle !== "Error") return false;
  if (!params.errorDetails || params.errorDetails.length === 0) return false;
  if (params.errorReason === KERNEL_ERROR_REASON.MISSING_IPYKERNEL) return false;
  if (params.errorReason === KERNEL_ERROR_REASON.DEPENDENCY_CACHE_MISSING_IPYKERNEL) return false;
  if (params.errorReason === KERNEL_ERROR_REASON.IPYKERNEL_SITE_PACKAGES_MISMATCH) return false;
  if (params.errorReason === KERNEL_ERROR_REASON.CONDA_ENV_YML_MISSING) return false;
  if (params.runtime === "deno") return false;
  return true;
}

export interface KernelLaunchErrorBannerProps {
  /**
   * Stderr tail or other free-form details from the daemon's failed
   * launch. Usually multi-line. Rendered monospace + preserving
   * newlines so stack traces / subprocess errors stay readable.
   */
  errorDetails: string;
  onRetry: () => void;
  onDismiss: () => void;
}

/**
 * Banner surfaced when the daemon reports `RuntimeLifecycle::Error`
 * with launch details that are not owned by a more targeted remediation
 * prompt. Those targeted cases are skipped by
 * `shouldShowKernelLaunchErrorBanner`; this one covers everything else —
 * env solve failures, subprocess crashes, import errors, rate-limited env
 * builds, etc.
 *
 * App.tsx gates visibility on lifecycle + non-targeted remediation
 * cases and resets the dismiss state when `errorDetails` changes, so
 * a new failure after a retry re-shows the banner.
 */
export function KernelLaunchErrorBanner({
  errorDetails,
  onRetry,
  onDismiss,
}: KernelLaunchErrorBannerProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [errorDetails]);

  const copyDetails = useCallback(async () => {
    await navigator.clipboard.writeText(errorDetails);
    setCopied(true);
  }, [errorDetails]);

  return (
    <NotebookNotice
      tone="error"
      icon={<AlertCircle className="h-4 w-4" />}
      title="Kernel failed to start"
      onDismiss={onDismiss}
      details={
        <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-red-950/5 px-2 py-1 font-mono text-[11px] leading-snug text-red-950/90 dark:bg-red-950/30 dark:text-red-100/90">
          {errorDetails}
        </pre>
      }
      actions={
        <>
          <Button
            size="sm"
            variant="secondary"
            className="h-6 px-2 text-xs"
            onClick={copyDetails}
            data-testid="copy-kernel-launch-error"
          >
            {copied ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button size="sm" variant="secondary" className="h-6 px-2 text-xs" onClick={onRetry}>
            <RotateCw className="h-3 w-3 mr-1" />
            Retry
          </Button>
        </>
      }
    />
  );
}
