import {
  AlertCircle,
  Ban,
  Cloud,
  CloudOff,
  Cpu,
  FileQuestion,
  ImageOff,
  Loader2,
  LogIn,
  RotateCcw,
  RotateCw,
} from "lucide-react";
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
 * The organizing rule (matching PR #4081): treatment depends on whether the
 * notebook is still VIEWABLE.
 *   - Viewable  → inline banner in the notices region; the notebook stays
 *     readable/editable underneath.
 *   - Not viewable (signed out, connection/access error) → full-stage
 *     centered `NotebookAccessGate` that owns the whole canvas.
 *
 * Every scenario is rendered at once (no click-to-reveal) so the whole
 * family can be scanned side by side. Icons differ per tone so color is not
 * the only severity signal.
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
  /** Short human note describing the trigger. */
  note: string;
  render: () => React.ReactNode;
}

/**
 * Proposed NEW notice for the "no compute attached" case — the state in the
 * dev:browser screenshot that currently surfaces NO UI at all. The notebook
 * is fully viewable, so this is an inline banner, not a gate.
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

/**
 * VIEWABLE states — the notebook renders underneath, so these are inline
 * banners in the notices region.
 */
const viewableScenarios: Scenario[] = [
  {
    id: "no-compute-owner",
    label: "No compute (owner)",
    note: "dev:browser / cloud, owner, no runtime peer attached. Today this is SILENT — no banner, no run button, no tooltip. Proposed new notice.",
    render: () => <NoComputeNotice isOwner />,
  },
  {
    id: "no-compute-viewer",
    label: "No compute (viewer)",
    note: "Non-owner, no runtime attached. Cannot attach compute themselves. Proposed new notice.",
    render: () => <NoComputeNotice isOwner={false} />,
  },
  {
    id: "reconnecting",
    label: "Reconnecting",
    note: "Transport dropped past the 3s debounce. Quiet, no CTA — the transport retries forever on its own.",
    render: () => (
      <NotebookNotice tone="info" icon={<CloudOff className="h-4 w-4" />} title="Reconnecting.">
        Your edits are kept locally and will sync when the connection returns.
      </NotebookNotice>
    ),
  },
  {
    id: "kernel-launch",
    label: "Kernel failed to start",
    note: "RuntimeLifecycle::Error with stderr tail. Traceback COLLAPSED into a scroll box with Copy + Retry — the pattern to standardize on.",
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
    id: "runtime-unavailable",
    label: "Runtime unavailable (desktop)",
    note: "DaemonStatusBanner failed state. Today renders the raw sock-path error uncollapsed (a target for the sanitize/collapse fix).",
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
    id: "auth-attention",
    label: "Auth needs attention",
    note: "authState.mode invalid / oidc_expired while a readable snapshot exists. Error tone; notebook still visible.",
    render: () => (
      <NotebookNotice
        tone="error"
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
    note: "authRenewal.kind === refreshing. Transient, spinner, no CTA. (Explicit spinner icon overrides the tone default.)",
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
    note: "Reconnect completed with locally-authored work pending. Informational.",
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

interface GateScenario {
  id: string;
  label: string;
  note: string;
  tone: "neutral" | "info" | "attention";
  icon: React.ReactNode;
  title: string;
  detail: string;
  primaryAction?: React.ReactNode;
}

/**
 * NOT-VIEWABLE states — the notebook cannot be shown at all, so these take
 * over the whole stage as a centered `NotebookAccessGate` (the PR #4081
 * pattern) rather than floating a banner over an empty void.
 */
const gateScenarios: GateScenario[] = [
  {
    id: "signed-out",
    label: "Signed out (private)",
    note: "signedOutNotebookSignInRequired. Private notebook, no session, no readable snapshot.",
    tone: "info",
    icon: <LogIn aria-hidden="true" />,
    title: "Sign in to open this notebook",
    detail:
      "This notebook is private. Sign in with your account and we'll bring you straight back here.",
    primaryAction: <Button size="sm">Sign in with Anaconda</Button>,
  },
  {
    id: "no-access",
    label: "No access",
    note: "CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC (HTTP 403). Signed in, but not shared with this account.",
    tone: "attention",
    icon: <Ban aria-hidden="true" />,
    title: "You don't have access",
    detail: "Ask the owner to share this notebook with your account, then reload.",
    primaryAction: (
      <Button size="sm" variant="secondary">
        Reload
      </Button>
    ),
  },
  {
    id: "not-found",
    label: "Not found",
    note: "CLOUD_CONNECTION_NOT_FOUND_DIAGNOSTIC (HTTP 404). No such notebook — no action.",
    tone: "neutral",
    icon: <FileQuestion aria-hidden="true" />,
    title: "Notebook not found",
    detail: "This notebook may have been moved or deleted.",
  },
  {
    id: "load-failed",
    label: "Load failed (desktop)",
    note: "Daemon-not-running load failure with nothing to show. Replaces the Tauri triple-treatment with one gate.",
    tone: "attention",
    icon: <CloudOff aria-hidden="true" />,
    title: "Couldn't load this notebook",
    detail: "The runtime isn't available right now. Reconnect to try again.",
    primaryAction: (
      <Button size="sm" variant="secondary">
        <RotateCcw className="mr-1 size-3" />
        Reconnect
      </Button>
    ),
  },
];

export function NotebookNoticesGallery() {
  return (
    <div className="space-y-12">
      <ViewableSection />
      <NotViewableSection />
      <SpacingContrast />
      <ToneReference />
    </div>
  );
}

/**
 * Frame that mimics the real shell: a toolbar row, the notices region, and a
 * body. `padded` toggles the proposed container padding so notices never
 * touch the edges.
 */
function ShellFrame({
  children,
  padded = true,
  showBody = true,
}: {
  children: React.ReactNode;
  padded?: boolean;
  showBody?: boolean;
}) {
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
      {showBody ? (
        <div className="min-h-[96px] bg-background px-6 py-8 text-sm text-muted-foreground">
          <code className="text-foreground/70">print(&apos;hello&apos;)</code>
        </div>
      ) : null}
    </div>
  );
}

function ScenarioCard({ scenario }: { scenario: Scenario }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-foreground">{scenario.label}</span>
      </div>
      <p className="text-[11px] leading-4 text-muted-foreground">{scenario.note}</p>
      <ShellFrame showBody={false}>{scenario.render()}</ShellFrame>
    </div>
  );
}

function ViewableSection() {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Notebook viewable → inline banner
        </h2>
        <p className="text-sm text-foreground/80">
          The notebook still renders underneath, so the message is a banner in the notices region.
          Every state shown at once. Adding a single action never resizes the bar.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {viewableScenarios.map((s) => (
          <ScenarioCard key={s.id} scenario={s} />
        ))}
      </div>
    </section>
  );
}

function NotViewableSection() {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Notebook not viewable → full-stage gate
        </h2>
        <p className="text-sm text-foreground/80">
          Nothing to show underneath (signed out, no access, not found, load failed), so the state
          owns the whole canvas — the PR #4081 pattern — instead of floating a banner over an empty
          void.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {gateScenarios.map((g) => (
          <div key={g.id} className="space-y-2">
            <span className="text-xs font-medium text-foreground">{g.label}</span>
            <p className="text-[11px] leading-4 text-muted-foreground">{g.note}</p>
            <div className="overflow-hidden rounded-lg border bg-background shadow-sm">
              <div className="flex items-center gap-4 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Notebook</span>
                <span className="ml-auto">Python</span>
              </div>
              <div className="flex min-h-[220px] flex-col">
                <NotebookAccessGate
                  tone={g.tone}
                  icon={g.icon}
                  title={g.title}
                  detail={g.detail}
                  primaryAction={g.primaryAction}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
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
          <ShellFrame padded={false} showBody={false}>
            <NoComputeNotice isOwner />
          </ShellFrame>
        </div>
        <div className="space-y-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
            padded (proposed)
          </span>
          <ShellFrame padded showBody={false}>
            <NoComputeNotice isOwner />
          </ShellFrame>
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
          The five tones with their default per-tone icons — shape distinguishes severity, not just
          color. The first three carry a single action to show the button treatment and stable bar
          height.
        </p>
      </div>
      <ShellFrame showBody={false}>
        <NotebookNoticeStack>
          {tones.map((tone, i) => (
            <NotebookNotice
              key={tone}
              tone={tone}
              title={`${tone[0].toUpperCase()}${tone.slice(1)} tone.`}
              actions={
                i < 3 ? (
                  <NotebookNoticeAction icon={<AlertCircle className="h-3 w-3" />}>
                    Action
                  </NotebookNoticeAction>
                ) : null
              }
            >
              The quick brown fox jumps over the lazy dog.
            </NotebookNotice>
          ))}
        </NotebookNoticeStack>
      </ShellFrame>
    </section>
  );
}
