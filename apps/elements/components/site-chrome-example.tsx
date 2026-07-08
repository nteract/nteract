import {
  BookOpen,
  Check,
  CircleAlert,
  CloudOff,
  FileQuestion,
  KeyRound,
  Loader2,
  Lock,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type IconTone = "neutral" | "info" | "attention" | "destructive";
type NoticeTone = "info" | "warning" | "error" | "success";

interface SiteChromeStateFixture {
  icon: LucideIcon;
  eyebrow: string;
  meta: string;
  title: string;
  detail: string;
  action?: string;
  secondary?: string;
  secondaryHref?: string;
  tone: IconTone;
  note?: string;
  noteInitials?: string;
}

const signInRequiredState = {
  icon: KeyRound,
  eyebrow: "Access",
  meta: "signed out",
  title: "Sign in to open this notebook",
  detail: "It may be private. Sign in and we'll bring you straight back here.",
  action: "Sign in",
  tone: "neutral",
} satisfies SiteChromeStateFixture;

const notFoundState = {
  icon: FileQuestion,
  eyebrow: "Missing",
  meta: "404",
  title: "Notebook not found",
  detail:
    "There is nothing at this address. It may have been deleted, or the link came through slightly wrong.",
  secondary: "Back to your notebooks",
  secondaryHref: "/docs/cloud-dashboard",
  tone: "neutral",
} satisfies SiteChromeStateFixture;

const noAccessState = {
  icon: Lock,
  eyebrow: "Access",
  meta: "403",
  title: "This notebook is private",
  detail: "Your account doesn't have access yet. Ask, and the owner gets a note right away.",
  action: "Request access",
  tone: "attention",
  note: "Signed in as alice@localhost",
  noteInitials: "AE",
} satisfies SiteChromeStateFixture;

const noNotebooksState = {
  icon: BookOpen,
  eyebrow: "Home",
  meta: "empty",
  title: "No notebooks yet",
  detail: "Create a notebook to start working with a live document and attach compute when needed.",
  action: "New notebook",
  tone: "neutral",
} satisfies SiteChromeStateFixture;

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

const iconToneStyles = {
  neutral: {
    shell: {
      background: "var(--muted)",
    },
    icon: {
      color: "var(--foreground)",
    },
  },
  info: {
    shell: {
      background: "color-mix(in oklab, var(--k-start) 10%, var(--background))",
    },
    icon: {
      color: "var(--k-start)",
    },
  },
  attention: {
    shell: {
      background: "color-mix(in oklab, var(--k-exec) 10%, var(--background))",
    },
    icon: {
      color: "var(--k-exec)",
    },
  },
  destructive: {
    shell: {
      background: "color-mix(in oklab, var(--destructive) 10%, var(--background))",
    },
    icon: {
      color: "var(--destructive)",
    },
  },
} satisfies Record<IconTone, { shell: CSSProperties; icon: CSSProperties }>;

export function SiteChromeExample() {
  return (
    <div className="not-prose space-y-7" data-testid="site-chrome-example">
      <LabeledInkFrame caption="Signed-out home" navLabel="Sign in">
        <section className="p-7 sm:p-10">
          <EyebrowRow label="nteract · cloud" meta="host chrome" />
          <div className="mt-10 max-w-3xl pb-2">
            <h1 className="max-w-3xl break-words text-[56px] font-extrabold leading-[0.98] tracking-[-0.04em] text-foreground [overflow-wrap:anywhere]">
              Notebooks that mingle with agents
            </h1>
            <p className="mt-5 max-w-2xl text-[18px] leading-[1.55] text-muted-foreground">
              Local-first notebook documents, explicit runtime state, and programmatic control in
              the same live room.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button type="button">Sign in</Button>
            </div>
          </div>
          <SquareDetailList
            items={["Automerge-backed notebook state", "Daemon-owned kernels and execution"]}
          />
        </section>
      </LabeledInkFrame>

      <LabeledInkFrame caption="Sign-in required" navLabel="Sign in" navActive>
        <StateSurface state={signInRequiredState} />
      </LabeledInkFrame>

      <LabeledInkFrame caption="Not found (404)" navLabel="GitHub">
        <StateSurface state={notFoundState} />
      </LabeledInkFrame>

      <LabeledInkFrame caption="Private / no access (403)" navLabel="GitHub">
        <StateSurface state={noAccessState} />
      </LabeledInkFrame>

      <LabeledInkFrame caption="No notebooks yet" navLabel="GitHub">
        <StateSurface state={noNotebooksState} hero />
      </LabeledInkFrame>

      <LabeledInkFrame caption="Session-expired return" navLabel="Sign in" navActive>
        <section className="space-y-5 p-7 sm:p-9">
          <EyebrowRow label="Session" meta="last synced 2 minutes ago" />
          <NoticeBanner
            icon={Loader2}
            message="Restoring your sign-in. Your notebooks are safe, this usually takes a moment."
            tone="info"
            spin
          />
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <h2 className="text-[24px] font-bold tracking-[-0.02em] text-foreground">
              Your notebooks
            </h2>
            <TagChip>cached</TagChip>
          </div>
          <div className="border-y border-border" data-testid="site-chrome-cached-notebooks">
            {cachedNotebookRows.map((row, index) => (
              <div
                key={row.title}
                className={cn("px-1 py-3", index > 0 ? "border-t border-border" : null)}
                style={{ opacity: 0.55 }}
                data-testid="site-chrome-notebook-row"
              >
                <div className="text-[15.5px] font-medium leading-6 text-foreground">
                  {row.title}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{row.meta}</div>
              </div>
            ))}
          </div>
        </section>
      </LabeledInkFrame>

      <LabeledInkFrame caption="Notice banners" navLabel="GitHub">
        <section className="p-7 sm:p-9">
          <EyebrowRow label="Notice" meta="runtime tokens" />
          <div className="mt-6 grid gap-2">
            {noticeBanners.map((banner) => (
              <NoticeBanner key={banner.message} {...banner} />
            ))}
          </div>
        </section>
      </LabeledInkFrame>
    </div>
  );
}

function LabeledInkFrame({
  caption,
  navLabel,
  navActive = false,
  children,
}: {
  caption: string;
  navLabel: string;
  navActive?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-fd-muted-foreground">
        {caption}
      </p>
      <div className="dark overflow-hidden rounded-[14px] border border-border bg-background text-foreground">
        <MonoLedgerHeader navLabel={navLabel} navActive={navActive} />
        {children}
      </div>
    </section>
  );
}

function MonoLedgerHeader({
  navLabel,
  navActive = false,
}: {
  navLabel: string;
  navActive?: boolean;
}) {
  return (
    <header className="flex h-[52px] items-center gap-6 border-b border-border px-7">
      <span className="font-mono text-[13px] font-semibold tracking-[0.04em] text-foreground">
        nteract
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <nav
        className="flex items-center gap-[22px] font-mono text-[11px] uppercase tracking-[0.14em]"
        aria-label="Site chrome"
      >
        <a
          href="#site-chrome"
          className={cn(
            "text-muted-foreground underline-offset-[6px] transition-colors hover:text-foreground",
            navActive ? "text-foreground underline decoration-2 decoration-foreground" : null,
          )}
        >
          {navLabel}
        </a>
      </nav>
    </header>
  );
}

function StateSurface({ state, hero = false }: { state: SiteChromeStateFixture; hero?: boolean }) {
  const Icon = state.icon;
  const toneStyles = iconToneStyles[state.tone];

  return (
    <section className="p-7 sm:p-9">
      <EyebrowRow label={state.eyebrow} meta={state.meta} />
      <div className="mt-8 max-w-3xl">
        <span
          className="grid size-10 place-items-center rounded-[10px]"
          style={toneStyles.shell}
          aria-hidden="true"
        >
          <Icon className="size-5" style={toneStyles.icon} />
        </span>
        <h1
          className={cn(
            "mt-5 break-words font-bold text-foreground [overflow-wrap:anywhere]",
            hero
              ? "text-[56px] leading-[0.98] tracking-[-0.04em]"
              : "text-[44px] leading-[1.02] tracking-[-0.03em]",
          )}
        >
          {state.title}
        </h1>
        <p className="mt-4 max-w-2xl text-[18px] leading-[1.55] text-muted-foreground">
          {state.detail}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {state.action ? <Button type="button">{state.action}</Button> : null}
          {state.secondary ? (
            <a
              href={state.secondaryHref}
              className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground underline-offset-[6px] transition-colors hover:text-foreground hover:underline"
            >
              {state.secondary}
            </a>
          ) : null}
        </div>
        {state.note ? (
          <div className="mt-5 inline-flex items-center gap-2 text-xs text-muted-foreground">
            {state.noteInitials ? (
              <span className="grid size-[18px] place-items-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
                {state.noteInitials}
              </span>
            ) : null}
            <span>{state.note}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function EyebrowRow({ label, meta }: { label: string; meta: string }) {
  return (
    <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
      <span>{label}</span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span>{meta}</span>
    </div>
  );
}

function TagChip({ children }: { children: ReactNode }) {
  return (
    <span className="bg-muted px-3 py-1 font-mono text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
      {children}
    </span>
  );
}

function SquareDetailList({ items }: { items: readonly string[] }) {
  return (
    <div className="mt-8 grid gap-3 border-t border-border pt-5 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item} className="flex gap-3 text-[15.5px] leading-6 text-muted-foreground">
          <span
            className="mt-2 size-[5px] shrink-0 rounded-[1px] bg-foreground"
            aria-hidden="true"
          />
          <span>{item}</span>
        </div>
      ))}
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
