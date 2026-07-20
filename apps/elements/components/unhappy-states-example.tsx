"use client";

import {
  BookOpen,
  Check,
  CloudOff,
  CircleAlert,
  FileQuestion,
  KeyRound,
  ListTree,
  Loader2,
  Lock,
  MessageSquare,
  Package,
  ServerCog,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { NotebookAccessGate, type NotebookAccessGateTone } from "@/components/notebook";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type EmptyStateTone = "neutral" | "attention" | "destructive";
type NoticeTone = "info" | "warning" | "error" | "success";
type RailTone = "attention" | "destructive";

interface EmptyStateFixture {
  icon: LucideIcon;
  title: string;
  detail?: string;
  action?: string;
  secondary?: string;
  secondaryHref?: string;
  tone?: EmptyStateTone;
  note?: string;
  noteInitials?: string;
  iconBadgeClassName?: string;
  iconBadgeStyle?: CSSProperties;
  iconStyle?: CSSProperties;
}

const emptyStateToneClasses = {
  neutral: "bg-muted text-muted-foreground",
  attention: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  destructive: "bg-destructive/10 text-destructive",
} satisfies Record<EmptyStateTone, string>;

const emptyStates = [
  {
    icon: BookOpen,
    title: "No notebooks yet",
    detail:
      "Create a notebook to start working with a live document and attach compute when needed.",
    action: "New notebook",
  },
  {
    icon: MessageSquare,
    title: "No comments yet",
    detail: "Comment threads for this notebook appear here.",
  },
  {
    icon: Package,
    title: "No declared packages",
    detail: "Packages declared for this notebook's environment appear here.",
  },
  {
    icon: ListTree,
    title: "No outline yet",
    detail: "Add Markdown headings to structure your notebook.",
  },
  {
    icon: BookOpen,
    title: "Empty notebook",
    detail: "The owner hasn't added cells yet.",
  },
  {
    icon: ServerCog,
    title: "No workstations paired yet",
    detail: "Add one to run notebook compute on a machine you own.",
    action: "Add workstation",
  },
] satisfies readonly EmptyStateFixture[];

const accessGateStates = [
  {
    icon: FileQuestion,
    title: "Notebook not found",
    detail:
      "There is nothing at this address. It may have been deleted, or the link came through slightly wrong.",
    secondary: "Back to your notebooks",
    secondaryHref: "/docs/cloud-dashboard",
    tone: "neutral",
  },
  {
    icon: Lock,
    title: "This notebook is private",
    detail: "Your account doesn't have access yet. Ask, and the owner gets a note right away.",
    action: "Request access",
    tone: "attention",
    iconBadgeClassName: "rounded-full",
    iconBadgeStyle: {
      background: "color-mix(in oklab, var(--k-exec) 10%, transparent)",
    },
    iconStyle: {
      color: "var(--k-exec)",
    },
    note: "Signed in as alice@localhost",
    noteInitials: "AE",
  },
  {
    icon: KeyRound,
    title: "Sign in to open this notebook",
    detail: "It may be private. Sign in and we'll bring you straight back here.",
    action: "Sign in",
    tone: "neutral",
  },
] satisfies readonly EmptyStateFixture[];

const noticeToneStyles = {
  info: {
    shell: {
      border: "1px solid color-mix(in oklab, var(--k-start) 22%, var(--border))",
      background: "color-mix(in oklab, var(--k-start) 6%, var(--background))",
    },
    icon: {
      color: "var(--k-start)",
    },
  },
  warning: {
    shell: {
      border: "1px solid color-mix(in oklab, var(--k-exec) 25%, var(--border))",
      background: "color-mix(in oklab, var(--k-exec) 6%, var(--background))",
    },
    icon: {
      color: "var(--k-exec)",
    },
  },
  error: {
    shell: {
      border: "1px solid color-mix(in oklab, var(--destructive) 22%, var(--border))",
      background: "color-mix(in oklab, var(--destructive) 5%, var(--background))",
    },
    icon: {
      color: "var(--destructive)",
    },
  },
  success: {
    shell: {
      border: "1px solid color-mix(in oklab, var(--live-ink) 22%, var(--border))",
      background: "color-mix(in oklab, var(--live-ink) 6%, var(--background))",
    },
    icon: {
      color: "var(--live-ink)",
    },
  },
} satisfies Record<NoticeTone, { shell: CSSProperties; icon: CSSProperties }>;

const noticeBanners = [
  {
    icon: Loader2,
    message: "Refreshing sign-in...",
    tone: "info",
    spin: true,
  },
  {
    icon: CloudOff,
    message: "Reconnecting. Your edits are kept locally and will sync the moment we're back.",
    tone: "warning",
  },
  {
    icon: CircleAlert,
    message: "Couldn't refresh the notebook list. Showing your last synced copy.",
    tone: "error",
    action: "Retry",
  },
  {
    icon: Check,
    message: "Edit access approved. This notebook is yours to edit now.",
    tone: "success",
  },
] satisfies readonly {
  icon: LucideIcon;
  message: string;
  tone: NoticeTone;
  action?: string;
  spin?: boolean;
}[];

const railToneStyles = {
  attention: {
    shell: {
      border: "1px solid color-mix(in oklab, var(--k-exec) 25%, var(--border))",
      background: "color-mix(in oklab, var(--k-exec) 5%, var(--background))",
    },
    icon: {
      color: "var(--k-exec)",
    },
  },
  destructive: {
    shell: {
      border: "1px solid color-mix(in oklab, var(--destructive) 22%, var(--border))",
      background: "color-mix(in oklab, var(--destructive) 5%, var(--background))",
    },
    icon: {
      color: "var(--destructive)",
    },
  },
} satisfies Record<RailTone, { shell: CSSProperties; icon: CSSProperties }>;

const railRows = [
  {
    icon: TriangleAlert,
    text: "Working directory not set for oslo-gpu-01",
    tone: "attention",
  },
  {
    icon: CircleAlert,
    text: "Workstations couldn't load",
    tone: "destructive",
    action: "Retry",
  },
] satisfies readonly {
  icon: LucideIcon;
  text: string;
  tone: RailTone;
  action?: string;
}[];

const cachedNotebookRows = [
  {
    title: "Oslo GPU forecast",
    meta: "Edited yesterday",
  },
  {
    title: "Access request triage",
    meta: "Edited Monday",
  },
  {
    title: "Runtime startup notes",
    meta: "Edited last week",
  },
] satisfies readonly { title: string; meta: string }[];

export function ElementsEmptyStateExample() {
  return (
    <div className="not-prose grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {emptyStates.map((state) => (
        <div key={state.title} className="rounded-lg border border-border bg-background">
          <EmptyState {...state} className="min-h-56" />
        </div>
      ))}
    </div>
  );
}

export function ElementsAccessGateExample() {
  return (
    <div className="not-prose grid gap-3 lg:grid-cols-3">
      {accessGateStates.map((state) => (
        <div
          key={state.title}
          className="min-h-[360px] rounded-lg border border-border bg-background"
        >
          <EmptyState {...state} className="min-h-[360px] px-6" />
        </div>
      ))}
    </div>
  );
}

const fullStageGates = [
  {
    icon: KeyRound,
    tone: "info" as const,
    title: "Sign in to open this notebook",
    detail:
      "This notebook is private. Sign in with your account and we'll bring you straight back here.",
    primaryLabel: "Sign in with Anaconda",
  },
  {
    icon: Lock,
    tone: "attention" as const,
    title: "This notebook is private",
    detail: "Your account doesn't have access yet. Ask, and the owner gets a note right away.",
    primaryLabel: "Request access",
    note: "Signed in as alice@localhost",
  },
  {
    icon: FileQuestion,
    tone: "neutral" as const,
    title: "Notebook not found",
    detail:
      "There is nothing at this address. It may have been deleted, or the link came through slightly wrong.",
    secondaryLabel: "Back to your notebooks",
  },
] satisfies readonly {
  icon: LucideIcon;
  tone: NotebookAccessGateTone;
  title: string;
  detail: string;
  primaryLabel?: string;
  secondaryLabel?: string;
  note?: string;
}[];

export function ElementsFullStageGateExample() {
  return (
    <div className="not-prose grid gap-3 lg:grid-cols-3">
      {fullStageGates.map((gate) => {
        const Icon = gate.icon;
        return (
          <div
            key={gate.title}
            className="flex min-h-[320px] overflow-hidden rounded-lg border border-border bg-background"
          >
            <NotebookAccessGate
              tone={gate.tone}
              icon={<Icon aria-hidden="true" />}
              title={gate.title}
              detail={gate.detail}
              primaryAction={
                gate.primaryLabel ? <Button size="sm">{gate.primaryLabel}</Button> : undefined
              }
              secondaryAction={
                gate.secondaryLabel ? (
                  <a
                    href="/docs/cloud-dashboard"
                    className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    {gate.secondaryLabel}
                  </a>
                ) : undefined
              }
              note={gate.note}
            />
          </div>
        );
      })}
    </div>
  );
}

export function ElementsNoticeBannerExample() {
  return (
    <div className="not-prose grid gap-2">
      {noticeBanners.map((banner) => (
        <NoticeBanner key={banner.message} {...banner} />
      ))}
    </div>
  );
}

export function ElementsRailStatusExample() {
  return (
    <div className="not-prose rounded-lg border border-border bg-background p-2 sm:w-[300px]">
      <style>{`
        @keyframes unhappy-state-shimmer {
          0% {
            background-position: 200% 0;
          }
          100% {
            background-position: -200% 0;
          }
        }

        .unhappy-state-shimmer {
          background: linear-gradient(90deg, var(--muted) 25%, color-mix(in oklab, var(--muted-foreground) 14%, var(--muted)) 37%, var(--muted) 63%);
          background-size: 200% 100%;
          animation: unhappy-state-shimmer 1.6s infinite;
        }
      `}</style>
      <div className="grid gap-1">
        <RailStatusSkeletonRow />
        {railRows.map((row) => (
          <RailStatusRow key={row.text} {...row} />
        ))}
      </div>
    </div>
  );
}

export function ElementsSessionExpiredReturnExample() {
  return (
    <div
      className="not-prose"
      data-elements-slot="unhappy-session-expired-return"
      data-screen-label="Session-expired return"
      data-testid="unhappy-session-expired-return"
    >
      <div className="mx-auto w-full max-w-[860px] overflow-hidden rounded-lg border border-border bg-background shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="text-sm font-semibold text-foreground">nteract</div>
          <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 px-3">
            Sign in
          </Button>
        </div>
        <div className="space-y-4 p-4 sm:p-5">
          <NoticeBanner
            icon={Loader2}
            message="Restoring your sign-in. Your notebooks are safe, this usually takes a moment."
            tone="info"
            spin
          />
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <h3 className="text-sm font-medium text-foreground">Your notebooks</h3>
            <p className="text-xs text-muted-foreground">Last synced 2 minutes ago</p>
          </div>
          <div data-testid="session-expired-cached-notebooks">
            {cachedNotebookRows.map((row) => (
              <div
                key={row.title}
                className="border-t border-border px-1 py-3 last:border-b"
                style={{ opacity: 0.55 }}
                data-testid="session-expired-notebook-row"
              >
                <div className="text-sm font-medium text-foreground">{row.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">{row.meta}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  detail,
  action,
  secondary,
  secondaryHref = "#",
  tone = "neutral",
  note,
  noteInitials,
  iconBadgeClassName,
  iconBadgeStyle,
  iconStyle,
  className,
}: EmptyStateFixture & { className?: string }) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center px-5 py-8 text-center", className)}
    >
      <span
        className={cn(
          "grid size-10 place-items-center",
          iconBadgeClassName ?? "rounded-xl",
          emptyStateToneClasses[tone],
        )}
        style={iconBadgeStyle}
        aria-hidden="true"
      >
        <Icon className="size-5" style={iconStyle} />
      </span>
      <h3 className="mt-3 text-sm font-medium text-foreground">{title}</h3>
      {detail ? (
        <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">{detail}</p>
      ) : null}
      {action || secondary || note ? (
        <div className="mt-4 flex flex-col items-center gap-2">
          {action ? (
            <Button type="button" variant="outline" size="sm">
              {action}
            </Button>
          ) : null}
          {secondary ? (
            <a
              href={secondaryHref}
              className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {secondary}
            </a>
          ) : null}
          {note ? (
            noteInitials ? (
              <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <span className="grid size-[18px] place-items-center rounded-full bg-background text-[10px] font-semibold text-foreground">
                  {noteInitials}
                </span>
                <span>{note}</span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{note}</p>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function NoticeBanner({
  icon: Icon,
  message,
  tone,
  action,
  spin = false,
}: {
  icon: LucideIcon;
  message: string;
  tone: NoticeTone;
  action?: string;
  spin?: boolean;
}) {
  const toneStyles = noticeToneStyles[tone];

  return (
    <div
      className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm text-foreground sm:min-h-11"
      style={toneStyles.shell}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon
        className={cn("size-4 shrink-0", spin ? "animate-spin" : null)}
        style={toneStyles.icon}
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 leading-5">{message}</p>
      {action ? (
        <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2.5">
          {action}
        </Button>
      ) : null}
    </div>
  );
}

function RailStatusRow({
  icon: Icon,
  text,
  tone,
  action,
}: {
  icon: LucideIcon;
  text: string;
  tone: RailTone;
  action?: string;
}) {
  const toneStyles = railToneStyles[tone];

  return (
    <div
      className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5 text-xs"
      style={toneStyles.shell}
    >
      <Icon className="size-3.5 shrink-0" style={toneStyles.icon} aria-hidden="true" />
      <span className="min-w-0 flex-1 leading-5 text-muted-foreground">{text}</span>
      {action ? (
        <a
          href="#retry-workstations"
          className="shrink-0 text-xs font-medium text-foreground underline-offset-4 hover:underline"
        >
          {action}
        </a>
      ) : null}
    </div>
  );
}

function RailStatusSkeletonRow() {
  return (
    <div
      className="flex min-h-8 flex-col justify-center gap-1.5 rounded-md px-2 py-1.5"
      role="status"
      aria-label="Loading workstation status"
      data-testid="unhappy-rail-loading-skeleton"
    >
      <span className="unhappy-state-shimmer h-2.5 w-[62%] rounded-full" aria-hidden="true" />
      <span className="unhappy-state-shimmer h-2.5 w-[40%] rounded-full" aria-hidden="true" />
    </div>
  );
}
