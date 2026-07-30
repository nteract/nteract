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
  NotebookNoticeDetails,
  NotebookNoticeStack,
} from "@/components/notebook/NotebookNotice";

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

const LONG_ROOM_ERROR = `cloud room rejected frame: room session escalation refused the requested editor scope
  requested: editor (write cells, write structure, execute)
  granted:   viewer (read cells, read outputs)
  reason:    the notebook ACL lists this account as a viewer, and no pending edit-access request was found
  room:      wss://notebooks.example/rooms/9f3c1e7a-4b2d-4c88-a1f0-5e6d7c8b9a01
  attempt:   3 of 3 (escalation ladder exhausted; the transport will not retry on its own)`;

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
      icon={<Cpu />}
      title="No compute attached."
      actions={
        isOwner ? (
          <NotebookNoticeAction icon={<RotateCw />}>Start compute</NotebookNoticeAction>
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
      <NotebookNotice tone="info" icon={<CloudOff />} title="Reconnecting.">
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
    id: "long-cloud-message",
    note: "Cloud connection/load error whose raw text runs long. A lead line stays on the bar and the rest collapses — the region grows with content, so nothing is clipped and nothing scrolls except the open block.",
    label: "Long cloud error",
    render: () => (
      <NotebookNotice
        tone="warning"
        icon={<CloudOff />}
        title="Live room needs attention."
        details={
          <NotebookNoticeDetails label="Show error details">
            {LONG_ROOM_ERROR}
          </NotebookNoticeDetails>
        }
      >
        cloud room rejected frame: room session escalation refused the requested editor scope
      </NotebookNotice>
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
        actions={<NotebookNoticeAction icon={<LogIn />}>Sign in again</NotebookNoticeAction>}
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
        icon={<Loader2 className="animate-spin" />}
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
        icon={<ImageOff />}
        title="Output renderer unavailable."
        actions={<NotebookNoticeAction icon={<RotateCcw />}>Retry</NotebookNoticeAction>}
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
        icon={<Cloud />}
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
      <ToneReference />
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
      <div className="overflow-hidden rounded-lg border">{scenario.render()}</div>
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
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
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
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {gateScenarios.map((g) => (
          <div key={g.id} className="space-y-2">
            <span className="text-xs font-medium text-foreground">{g.label}</span>
            <p className="text-[11px] leading-4 text-muted-foreground">{g.note}</p>
            <div className="flex min-h-[220px] flex-col overflow-hidden rounded-lg border bg-background">
              <NotebookAccessGate
                tone={g.tone}
                icon={g.icon}
                title={g.title}
                detail={g.detail}
                primaryAction={g.primaryAction}
              />
            </div>
          </div>
        ))}
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
      <div className="overflow-hidden rounded-lg border">
        <NotebookNoticeStack className="gap-0">
          {tones.map((tone, i) => (
            <NotebookNotice
              key={tone}
              tone={tone}
              title={`${tone[0].toUpperCase()}${tone.slice(1)} tone.`}
              actions={
                i < 3 ? (
                  <NotebookNoticeAction icon={<AlertCircle />}>Action</NotebookNoticeAction>
                ) : null
              }
            >
              The quick brown fox jumps over the lazy dog.
            </NotebookNotice>
          ))}
        </NotebookNoticeStack>
      </div>
    </section>
  );
}
