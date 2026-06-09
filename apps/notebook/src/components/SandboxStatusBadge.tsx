/**
 * SandboxStatusBadge — notebook-header badge reflecting the active kernel's
 * sandbox state (Disabled / Active / StartupFailed / Degraded), cross-checked
 * against the configured intent in notebook metadata.
 *
 * The badge is self-contained: it reads `useRuntimeState()` and
 * `useSandboxProfile()` directly so no prop-drilling is required. Clicking
 * the badge opens the SandboxPanel when a click handler is provided by the
 * parent.
 *
 * Placement: near the kernel status indicator in the notebook toolbar.
 */

import { AlertOctagon, CheckCircle2, Shield, ShieldOff } from "lucide-react";
import { type SandboxStateInfo } from "runtimed";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { useRuntimeState } from "../lib/runtime-state";
import { useSandboxProfile } from "../lib/notebook-metadata";

// ── State metadata ────────────────────────────────────────────────────────────

interface BadgeMeta {
  label: string;
  tooltip: string;
  /** Tailwind colour classes for text + background */
  colorClass: string;
  Icon: React.ComponentType<{ className?: string }>;
}

function metaForState(s: SandboxStateInfo): BadgeMeta {
  switch (s.state) {
    case "Active":
      return {
        label: "Sandbox: On",
        tooltip: "Network calls are routed through nono. Click for details.",
        colorClass:
          "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-700",
        Icon: CheckCircle2,
      };
    case "StartupFailed":
      return {
        label: "Sandbox: Failed",
        tooltip: "Sandbox failed to start. Check the credentials referenced by this notebook.",
        colorClass:
          "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-700",
        Icon: AlertOctagon,
      };
    case "Degraded":
      return {
        label: "Sandbox: Degraded",
        tooltip: "The sandbox proxy stopped. Restart the kernel to recover.",
        colorClass:
          "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 border-yellow-200 dark:border-yellow-700",
        Icon: Shield,
      };
    default:
      return {
        label: "Sandbox: Off",
        tooltip: "Sandbox is disabled for this notebook.",
        colorClass:
          "bg-muted text-muted-foreground border-border",
        Icon: ShieldOff,
      };
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface SandboxStatusBadgeProps {
  /** Called when the badge is clicked. Intended to open the sandbox panel. */
  onClick?: () => void;
  /** Extra class names for the outer element. */
  className?: string;
}

export function SandboxStatusBadge({ onClick, className }: SandboxStatusBadgeProps) {
  const runtimeState = useRuntimeState();
  const sandboxState = runtimeState.sandbox_state;
  const sandboxProfile = useSandboxProfile();

  const profileEnabled = sandboxProfile?.enabled === true;
  const kernelActive = sandboxState.state === "Active";

  // When sandbox has never been configured, render a minimal icon-only button
  // so the user always has an entry point to open the sandbox panel.
  if (!profileEnabled && sandboxState.state === "Disabled") {
    return (
      <HoverCard openDelay={300}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            className={cn(
              "inline-flex items-center rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground",
              className,
            )}
            aria-label="Network sandbox — click to configure"
          >
            <ShieldOff className="h-3.5 w-3.5" />
          </button>
        </HoverCardTrigger>
        <HoverCardContent className="w-64 text-sm" side="bottom" align="end">
          Network sandbox is off. Click to configure credential injection and domain filtering.
        </HoverCardContent>
      </HoverCard>
    );
  }

  // When the configured intent and the running kernel diverge, show a
  // "pending restart" badge so the user knows why things don't match.
  const pendingRestart = profileEnabled !== kernelActive;

  const { label, tooltip, colorClass, Icon } = pendingRestart
    ? {
        label: profileEnabled ? "Sandbox: On (restart needed)" : "Sandbox: Off (restart needed)",
        tooltip: profileEnabled
          ? "Sandbox is enabled but the current kernel was started without it. Restart to apply."
          : "Sandbox is disabled but the current kernel is running with it. Restart to apply.",
        colorClass:
          "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-700",
        Icon: Shield,
      }
    : metaForState(sandboxState);

  return (
    <HoverCard openDelay={300}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={cn(
            "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium transition-opacity hover:opacity-80",
            colorClass,
            className,
          )}
          aria-label={`${label} — ${tooltip}`}
        >
          <Icon className="h-3 w-3 shrink-0" />
          <span>{label}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-64 text-sm" side="bottom" align="end">
        {tooltip}
      </HoverCardContent>
    </HoverCard>
  );
}
