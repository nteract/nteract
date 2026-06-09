/**
 * SandboxStatusBadge — notebook-header badge reflecting the active kernel's
 * sandbox state (Disabled / Active / StartupFailed / Degraded).
 *
 * The badge is self-contained: it reads `useRuntimeState()` directly so no
 * prop-drilling is required. Clicking the badge opens the SandboxPanel when
 * a click handler is provided by the parent.
 *
 * Placement: near the kernel status indicator in the notebook toolbar.
 */

import { AlertOctagon, CheckCircle2, Shield, ShieldOff } from "lucide-react";
import { type SandboxStateInfo } from "runtimed";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { useRuntimeState } from "../lib/runtime-state";

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
        label: "Sandbox: Active",
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
      // Disabled — hidden by default per the spec ("gray (or hidden if you prefer)")
      return {
        label: "Sandbox: Off",
        tooltip: "This notebook has no sandbox profile.",
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

  // Hide the badge entirely when the sandbox is disabled to keep the toolbar
  // clean for notebooks that never opted in.
  if (sandboxState.state === "Disabled") {
    return null;
  }

  const { label, tooltip, colorClass, Icon } = metaForState(sandboxState);

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
