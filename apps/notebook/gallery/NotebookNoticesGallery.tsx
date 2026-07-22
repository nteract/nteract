import {
  AlertCircle,
  Ban,
  Cloud,
  CloudOff,
  Cpu,
  ImageOff,
  Loader2,
  LogIn,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DaemonStatusBanner } from "@/components/notebook/DaemonStatusBanner";
import {
  ComputeDisconnectedNotice,
  KernelLaunchErrorBanner,
} from "@/components/notebook/KernelLaunchErrorBanner";
import { NotebookAccessGate } from "@/components/notebook/NotebookAccessGate";
import {
  NotebookNotice,
  NotebookNoticeAction,
  NotebookNoticeStack,
} from "@/components/notebook/NotebookNotice";
import { cn } from "@/lib/utils";

/**
 * Notice gallery — every notification/banner/gate that can prevent (or
 * explain the inability to) run notebook cells, rendered with the real
 * shipped components so this doubles as the visual-review artifact for the
 * notice-consolidation work.
 *
 * Scenarios are grouped by the underlying reason a run is blocked:
 *   - runtime/compute not attached (the silent case today)
 *   - connection/transport loss
 *   - kernel launch/crash
 *   - auth / access
 *   - renderer assets
 *
 * Each scenario is shown inside a `ShellFrame` that mimics the real
 * toolbar → notices-slot → body layout, so edge spacing and how a notice
 * reads in context are both visible. A dedicated "spacing" section
 * contrasts edge-to-edge (today's desktop) against a padded container
 * (the proposed fix).
 */

const LONG_TRACEBACK = `Traceback (most recent call last):
  File "/opt/anaconda3/lib/python3.13/runpy.py", line 189, in _run_module_as_main
    mod_name, mod_spec, code = _get_module_details(mod_name, _Error)
  File "/opt/anaconda3/lib/python3.13/runpy.py", line 148, in _get_module_details
    return _get_module_details(pkg_main_name, error)
ModuleNotFoundError: No module named 'ipykernel_launcher'`;

const DAEMON_SOCK_ERROR =
  "sync connect (create): Daemon is not running. Endpoint not found at /Users/erikayee/Library/Caches/runt-nightly/worktrees/e0dd4fbd4f3b/runtimed.sock.";

interface Scenario {
  id: string;
  label: string;
  /** Short human note describing the trigger, shown above the frame. */
  note: string;
  render: () => React.ReactNode;
}

/**
 * Proposed NEW notice for the "no compute attached" case — the state in the
 * dev:browser screenshot that currently surfaces NO UI at all. Built here as
 * a mockup on top of the real `NotebookNotice` so the visual treatment can be
 * reviewed before it lands in production (`CloudNotebookNotices`).
 */
function NoComputeNotice({ isOwner }: { isOwner: boolean }) {
  return (
    <NotebookNotice
      tone="info"
      icon={<Cpu className="h-4 w-4" />}
      title="No compute attached."
      actions={
        isOwner ? (
          <NotebookNoticeAction icon={<RotateCw className="h-3 w-3" />}>
            Start compute
          </NotebookNoticeAction>
        ) : null
      }
    >
      {isOwner
        ? "Start compute to run cells in this notebook."
        : "Only the notebook owner can attach compute to run cells."}
    </NotebookNotice>
  );
}

const scenarios: Scenario[] = [
  {
    id: "no-compute-owner",
    label: "No compute (owner)",
    note: "dev:browser / cloud, owner, no runtime peer attached. Today this is SILENT — no banner, no run button, no tooltip. This is the proposed new notice.",
    render: () => <NoComputeNotice isOwner />,
  },
  {
    id: "no-compute-viewer",
    label: "No compute (viewer)",
    note: "Non-owner with no runtime attached. Cannot attach compute themselves. Proposed new notice.",
    render: () => <NoComputeNotice isOwner={false} />,
  },
  {
    id: "reconnecting",
    label: "Reconnecting",
    note: "Transport link dropped past the 3s debounce (useSustainedReconnecting). Quiet, no CTA — the transport retries forever on its own.",
    render: () => (
      <NotebookNotice tone="info" icon={<CloudOff className="h-4 w-4" />} title="Reconnecting.">
        Your edits are kept locally and will sync when the connection returns.
      </NotebookNotice>
    ),
  },
  {
    id: "live-room-unavailable",
    label: "Live room unavailable",
    note: "failed to connect wss://… with no readable snapshot. cloudConnectionNoticeDisplay.",
    render: () => (
      <NotebookNotice
        tone="warning"
        icon={<CloudOff className="h-4 w-4" />}
        title="Live room unavailable."
        actions={
          <NotebookNoticeAction icon={<RotateCcw className="h-3 w-3" />}>
            Retry
          </NotebookNoticeAction>
        }
      >
        The notebook will load once the account or connection is refreshed.
      </NotebookNotice>
    ),
  },
  {
    id: "runtime-unavailable",
    label: "Runtime unavailable (desktop)",
    note: "DaemonStatusBanner failed state. Today renders the raw sock-path error uncollapsed.",
    render: () => (
      <DaemonStatusBanner
        status={{
          status: "failed",
          error: `Reconnection failed: ${DAEMON_SOCK_ERROR}`,
          guidance: "Automatic reconnection is paused. Retry reconnects once.",
        }}
        onRetry={() => {}}
        onDismiss={() => {}}
      />
    ),
  },
  {
    id: "daemon-starting",
    label: "Runtime starting (desktop)",
    note: "DaemonStatusBanner progress state — calm info with spinner.",
    render: () => (
      <DaemonStatusBanner status={{ status: "waiting_for_ready", attempt: 2, max_attempts: 5 }} />
    ),
  },
  {
    id: "kernel-launch",
    label: "Kernel failed to start",
    note: "RuntimeLifecycle::Error with stderr tail. Traceback is COLLAPSED into a scroll box (max-h-32) with Copy + Retry — the pattern we want everywhere.",
    render: () => (
      <KernelLaunchErrorBanner
        errorDetails={LONG_TRACEBACK}
        onRetry={() => {}}
        onDismiss={() => {}}
      />
    ),
  },
  {
    id: "compute-disconnected",
    label: "Compute disconnected",
    note: "runtime peer disconnected: … A kernel that was attached dropped. Wake-on-run.",
    render: () => (
      <ComputeDisconnectedNotice
        errorDetails="runtime peer disconnected: workstation went offline"
        onRetry={() => {}}
        onDismiss={() => {}}
      />
    ),
  },
  {
    id: "sign-in-required",
    label: "Sign in required",
    note: "CLOUD_CONNECTION_SIGN_IN_DIAGNOSTIC (HTTP 401). Blocks the notebook body entirely.",
    render: () => (
      <NotebookNotice
        tone="warning"
        icon={<LogIn className="h-4 w-4" />}
        title="Sign in required."
        actions={
          <NotebookNoticeAction icon={<LogIn className="h-3 w-3" />}>
            Sign in again
          </NotebookNoticeAction>
        }
      >
        Sign in again to open the live notebook room.
      </NotebookNotice>
    ),
  },
  {
    id: "access-needed",
    label: "Notebook access needed",
    note: "CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC (HTTP 403).",
    render: () => (
      <NotebookNotice
        tone="warning"
        icon={<Ban className="h-4 w-4" />}
        title="Notebook access needed."
        actions={
          <NotebookNoticeAction icon={<RotateCcw className="h-3 w-3" />}>
            Retry
          </NotebookNoticeAction>
        }
      >
        Ask the owner to share it, or refresh sign-in if an invite was just accepted.
      </NotebookNotice>
    ),
  },
  {
    id: "auth-attention",
    label: "Auth needs attention",
    note: "authState.mode invalid / oidc_expired. Error tone.",
    render: () => (
      <NotebookNotice
        tone="error"
        icon={<AlertCircle className="h-4 w-4" />}
        title="Auth needs attention."
        actions={
          <NotebookNoticeAction icon={<LogIn className="h-3 w-3" />}>
            Sign in again
          </NotebookNoticeAction>
        }
      >
        Your sign-in expired. Sign in again to keep editing.
      </NotebookNotice>
    ),
  },
  {
    id: "refreshing-sign-in",
    label: "Refreshing sign-in",
    note: "authRenewal.kind === refreshing. Transient, spinner, no CTA.",
    render: () => (
      <NotebookNotice
        tone="info"
        icon={<Loader2 className="h-4 w-4 animate-spin" />}
        title="Refreshing sign-in."
      >
        Reconnecting your account…
      </NotebookNotice>
    ),
  },
  {
    id: "renderer-assets",
    label: "Output renderer unavailable",
    note: "Terminal renderer-asset load failure. Code stays readable; rich outputs paused.",
    render: () => (
      <NotebookNotice
        tone="warning"
        icon={<ImageOff className="h-4 w-4" />}
        title="Output renderer unavailable."
        actions={
          <NotebookNoticeAction icon={<RotateCcw className="h-3 w-3" />}>
            Retry
          </NotebookNoticeAction>
        }
      >
        Rich outputs are paused because their renderer assets failed to load. Code and text stay
        readable; retry to restore outputs.
      </NotebookNotice>
    ),
  },
  {
    id: "offline-merge",
    label: "Synced offline edits",
    note: "Reconnect completed with locally-authored work pending. Success/info, informational.",
    render: () => (
      <NotebookNotice
        tone="info"
        icon={<Cloud className="h-4 w-4" />}
        title="Synced your offline edits — 3 updates from collaborators merged."
      >
        A cell you edited offline was removed by a collaborator.
      </NotebookNotice>
    ),
  },
];

export function NotebookNoticesGallery() {
  return (
    <div className="space-y-12">
      <SingleNoticeExplorer />
      <StackedExample />
      <SpacingContrast />
      <GateExample />
      <ToneReference />
    </div>
  );
}

/**
 * Frame that mimics the real shell: a toolbar row, the notices region, and a
 * body. `padded` toggles the proposed container padding so notices never
 * touch the edges.
 */
function ShellFrame({ children, padded = true }: { children: React.ReactNode; padded?: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-background shadow-sm">
      <div className="flex items-center gap-4 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Notebook</span>
        <span>Code</span>
        <span>Markdown</span>
        <span className="opacity-50">Start compute</span>
        <span className="ml-auto">Python</span>
      </div>
      <div className={cn("border-b bg-background", padded ? "px-3 py-2" : "")}>{children}</div>
      <div className="min-h-[120px] bg-background px-6 py-8 text-sm text-muted-foreground">
        <code className="text-foreground/70">print(&apos;hello&apos;)</code>
      </div>
    </div>
  );
}

function SingleNoticeExplorer() {
  const [selectedId, setSelectedId] = useState(scenarios[0].id);
  const selected = scenarios.find((s) => s.id === selectedId) ?? scenarios[0];

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Blocked-run states
        </h2>
        <p className="text-sm text-foreground/80">
          Every notice that can prevent (or explain the inability to) run cells, in the shell
          toolbar → notices → body layout. Pick a scenario.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1 rounded-md border bg-muted/50 p-1">
        {scenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSelectedId(s.id)}
            className={cn(
              "rounded-sm px-2 py-1 text-xs transition-colors",
              s.id === selectedId
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <p className="text-xs leading-5 text-muted-foreground">{selected.note}</p>

      <ShellFrame>{selected.render()}</ShellFrame>
    </section>
  );
}

function StackedExample() {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Stacked (multiple at once)
        </h2>
        <p className="text-sm text-foreground/80">
          When several are active, they pile in one `NotebookNoticeStack`. This is what the
          consolidated single-location model should look like — one region, consistent spacing.
        </p>
      </div>
      <ShellFrame>
        <NotebookNoticeStack>
          <NoComputeNotice isOwner />
          <NotebookNotice tone="info" icon={<CloudOff className="h-4 w-4" />} title="Reconnecting.">
            Your edits are kept locally and will sync when the connection returns.
          </NotebookNotice>
          <NotebookNotice
            tone="warning"
            icon={<ImageOff className="h-4 w-4" />}
            title="Output renderer unavailable."
            actions={
              <NotebookNoticeAction icon={<RotateCcw className="h-3 w-3" />}>
                Retry
              </NotebookNoticeAction>
            }
          >
            Rich outputs are paused because their renderer assets failed to load.
          </NotebookNotice>
        </NotebookNoticeStack>
      </ShellFrame>
    </section>
  );
}

function SpacingContrast() {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Spacing: edge-to-edge vs padded
        </h2>
        <p className="text-sm text-foreground/80">
          Today (desktop) notices sit edge-to-edge with only the atom&apos;s own `px-3`. The
          proposed container adds breathing room so notices never touch the frame.
        </p>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
            edge-to-edge (today)
          </span>
          <ShellFrame padded={false}>
            <NoComputeNotice isOwner />
          </ShellFrame>
        </div>
        <div className="space-y-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
            padded (proposed)
          </span>
          <ShellFrame padded>
            <NoComputeNotice isOwner />
          </ShellFrame>
        </div>
      </div>
    </section>
  );
}

function GateExample() {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Full-stage gate
        </h2>
        <p className="text-sm text-foreground/80">
          Hard blockers (signed-out private notebook, not found) replace the body with a centered
          `NotebookAccessGate` rather than a banner.
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border bg-background shadow-sm">
        <div className="flex items-center gap-4 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Notebook</span>
          <span className="ml-auto">Python</span>
        </div>
        <div className="min-h-[260px]">
          <NotebookAccessGate
            tone="info"
            icon={<LogIn aria-hidden="true" />}
            title="Sign in to open this notebook"
            detail="This notebook is private. Sign in with your account and we'll bring you straight back here."
            primaryAction={<Button size="sm">Sign in with Anaconda</Button>}
          />
        </div>
      </div>
    </section>
  );
}

function ToneReference() {
  const tones = ["info", "warning", "error", "success", "debug"] as const;
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Tone reference
        </h2>
        <p className="text-sm text-foreground/80">
          The five `NotebookNotice` tones, for quick contrast in light and dark.
        </p>
      </div>
      <ShellFrame>
        <NotebookNoticeStack>
          {tones.map((tone) => (
            <NotebookNotice
              key={tone}
              tone={tone}
              icon={<AlertCircle className="h-4 w-4" />}
              title={`${tone[0].toUpperCase()}${tone.slice(1)} tone.`}
            >
              The quick brown fox jumps over the lazy dog.
            </NotebookNotice>
          ))}
        </NotebookNoticeStack>
      </ShellFrame>
    </section>
  );
}
