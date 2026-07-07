import {
  AlertCircle,
  BookOpen,
  Check,
  CloudOff,
  FileQuestion,
  Info,
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
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type EmptyStateTone = "neutral" | "attention" | "destructive";
type NoticeTone = "info" | "warning" | "error" | "success";
type RailTone = "neutral" | "attention" | "destructive";

interface EmptyStateFixture {
  icon: LucideIcon;
  title: string;
  detail?: string;
  action?: string;
  secondary?: string;
  secondaryHref?: string;
  tone?: EmptyStateTone;
  note?: string;
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
    detail: "This notebook doesn't exist, or the link may be wrong.",
    secondary: "View your notebooks",
    secondaryHref: "/docs/cloud-dashboard",
    tone: "neutral",
  },
  {
    icon: Lock,
    title: "Notebook access needed",
    detail:
      "This account does not have access to this notebook. Ask the owner to share it, or request access below.",
    action: "Request access",
    tone: "attention",
    note: "Signed in as alice@localhost",
  },
  {
    icon: KeyRound,
    title: "Sign in to view this notebook",
    detail: "This notebook may be private. Sign in to check your access.",
    action: "Sign in",
    tone: "neutral",
  },
] satisfies readonly EmptyStateFixture[];

const noticeToneClasses = {
  info: {
    shell: "bg-background",
    icon: "text-muted-foreground",
  },
  warning: {
    shell: "bg-amber-500/5",
    icon: "text-amber-600 dark:text-amber-400",
  },
  error: {
    shell: "bg-destructive/5",
    icon: "text-destructive",
  },
  success: {
    shell: "bg-emerald-500/5",
    icon: "text-emerald-600 dark:text-emerald-400",
  },
} satisfies Record<NoticeTone, { shell: string; icon: string }>;

const noticeBanners = [
  {
    icon: Loader2,
    message: "Refreshing sign-in...",
    tone: "info",
    spin: true,
  },
  {
    icon: Info,
    message: "Reconnecting. Your edits are kept locally...",
    tone: "info",
  },
  {
    icon: CloudOff,
    message: "Couldn't refresh the notebook list. Showing your last synced copy.",
    tone: "warning",
    action: "Retry",
  },
  {
    icon: Check,
    message: "Edit access approved. Reconnecting with editor access.",
    tone: "success",
  },
] satisfies readonly {
  icon: LucideIcon;
  message: string;
  tone: NoticeTone;
  action?: string;
  spin?: boolean;
}[];

const railToneClasses = {
  neutral: "text-muted-foreground",
  attention: "text-amber-600 dark:text-amber-400",
  destructive: "text-destructive",
} satisfies Record<RailTone, string>;

const railRows = [
  {
    icon: Loader2,
    text: "Preparing workstation access...",
    tone: "neutral",
    spin: true,
  },
  {
    icon: TriangleAlert,
    text: "This workstation does not have a working directory configured.",
    tone: "attention",
  },
  {
    icon: AlertCircle,
    text: "Unable to load workstations.",
    tone: "destructive",
    action: "Retry",
  },
] satisfies readonly {
  icon: LucideIcon;
  text: string;
  tone: RailTone;
  action?: string;
  spin?: boolean;
}[];

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
      <div className="grid gap-1">
        {railRows.map((row) => (
          <RailStatusRow key={row.text} {...row} />
        ))}
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
  className,
}: EmptyStateFixture & { className?: string }) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center px-5 py-8 text-center", className)}
    >
      <span
        className={cn("grid size-10 place-items-center rounded-xl", emptyStateToneClasses[tone])}
        aria-hidden="true"
      >
        <Icon className="size-5" />
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
          {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
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
  const toneClasses = noticeToneClasses[tone];

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md border border-border px-3 py-2.5 text-sm text-foreground sm:min-h-11",
        toneClasses.shell,
      )}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon
        className={cn("size-4 shrink-0", toneClasses.icon, spin ? "animate-spin" : null)}
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
  spin = false,
}: {
  icon: LucideIcon;
  text: string;
  tone: RailTone;
  action?: string;
  spin?: boolean;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5 text-xs">
      <Icon
        className={cn("size-3.5 shrink-0", railToneClasses[tone], spin ? "animate-spin" : null)}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 leading-5 text-muted-foreground">{text}</span>
      {action ? (
        <button
          type="button"
          className="shrink-0 text-xs font-medium text-foreground underline-offset-4 hover:underline"
        >
          {action}
        </button>
      ) : null}
    </div>
  );
}
