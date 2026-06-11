import {
  Bot,
  Cog,
  Gauge,
  Globe2,
  Laptop,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarImage,
} from "@/components/ui/avatar";
import type { NotebookActorIdentity, NotebookActorKind } from "./capabilities";
export {
  notebookActorIdentityFromAccess,
  notebookActorIdentityFromProjection,
  notebookActorIdentityFromRuntime,
} from "./actor-projection";

export interface NotebookIdentityBadgeProps {
  actor: NotebookActorIdentity;
  size?: "sm" | "default";
  showDetail?: boolean;
  showStatus?: boolean;
  variant?: "badge" | "inline";
  className?: string;
}

export interface NotebookIdentityGroupProps {
  actors: readonly NotebookActorIdentity[];
  maxVisible?: number;
  label?: string;
  className?: string;
}

export function NotebookIdentityBadge({
  actor,
  size = "default",
  showDetail = true,
  showStatus = true,
  variant = "badge",
  className,
}: NotebookIdentityBadgeProps) {
  const Icon = actorIcon(actor.kind);
  const avatarSize = size === "sm" ? "sm" : "default";
  const inline = variant === "inline";
  const label = inline ? compactPublicIdentityLabel(actor.label) : actor.label;

  return (
    <div
      className={cn(
        "inline-flex min-w-0 items-center text-foreground",
        inline ? "gap-2" : "gap-2 rounded-md border border-border/70 bg-muted/35 px-2 py-1",
        size === "sm" && !inline && "gap-1.5 px-1.5 py-0.5",
        className,
      )}
      data-slot="notebook-identity-badge"
      data-actor-kind={actor.kind}
      data-actor-status={actor.status ?? "active"}
      data-variant={variant}
      title={actor.detail ? `${actor.label} - ${actor.detail}` : actor.label}
    >
      {inline && showStatus ? (
        <span
          className={cn("size-2 shrink-0 rounded-full", statusTone(actor.status ?? "active"))}
          aria-hidden="true"
        />
      ) : null}
      {!inline ? (
        <NotebookActorAvatar actor={actor} icon={Icon} size={avatarSize} showStatus={showStatus} />
      ) : null}
      <span className="min-w-0">
        <span
          className={cn(
            "block truncate font-medium leading-tight",
            inline ? "text-sm" : size === "sm" ? "text-xs" : "text-sm",
          )}
        >
          {label}
        </span>
        {showDetail && actor.detail ? (
          <span className="block truncate text-[11px] leading-tight text-muted-foreground">
            {actor.detail}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function compactPublicIdentityLabel(label: string): string {
  const trimmed = label.trim();
  const emailMatch = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/.exec(trimmed);
  if (emailMatch?.[1]) {
    return emailMatch[1];
  }
  return trimmed;
}

export function NotebookIdentityGroup({
  actors,
  maxVisible = 3,
  label = "Notebook actors",
  className,
}: NotebookIdentityGroupProps) {
  const visibleActors = actors.slice(0, maxVisible);
  const hiddenCount = Math.max(0, actors.length - visibleActors.length);
  const title = actors
    .map((actor) => (actor.detail ? `${actor.label} - ${actor.detail}` : actor.label))
    .join(", ");

  if (actors.length === 0) {
    return null;
  }

  return (
    <div
      className={cn("inline-flex items-center gap-2", className)}
      data-slot="notebook-identity-group"
      aria-label={label}
      title={title}
    >
      <AvatarGroup>
        {visibleActors.map((actor) => (
          <NotebookActorAvatar key={actor.id} actor={actor} icon={actorIcon(actor.kind)} />
        ))}
        {hiddenCount > 0 ? (
          <div className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-2 ring-background">
            +{hiddenCount}
          </div>
        ) : null}
      </AvatarGroup>
      <span className="sr-only">{title}</span>
    </div>
  );
}

export function NotebookActorAvatar({
  actor,
  icon,
  size = "default",
  showStatus = true,
  statusClassName,
}: {
  actor: NotebookActorIdentity;
  icon?: LucideIcon;
  size?: "sm" | "default";
  showStatus?: boolean;
  /** Override the status dot tone (e.g. connection state instead of actor status). */
  statusClassName?: string;
}) {
  const Icon = icon ?? actorIcon(actor.kind);
  return (
    <Avatar
      size={size}
      className={cn("border border-border bg-muted text-muted-foreground", actorTone(actor.kind))}
      data-slot="notebook-actor-avatar"
      data-actor-kind={actor.kind}
    >
      {actor.imageUrl ? <AvatarImage src={actor.imageUrl} alt="" /> : null}
      <AvatarFallback>
        {actor.kind === "human" || actor.kind === "local" ? (
          initials(actor.label)
        ) : (
          <Icon className="size-3.5" aria-hidden="true" />
        )}
      </AvatarFallback>
      {showStatus ? (
        <AvatarBadge className={statusClassName ?? statusTone(actor.status ?? "active")} />
      ) : null}
    </Avatar>
  );
}

function actorIcon(kind: NotebookActorKind): LucideIcon {
  switch (kind) {
    case "agent":
      return Bot;
    case "runtime":
      return Gauge;
    case "system":
      return Cog;
    case "local":
      return Laptop;
    case "public":
      return Globe2;
    case "human":
      return UserRound;
    case "unknown":
      return UsersRound;
  }
}

function actorTone(kind: NotebookActorKind): string {
  switch (kind) {
    case "agent":
      return "bg-purple-500/10 text-purple-700 dark:text-purple-300";
    case "runtime":
      return "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300";
    case "system":
      return "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300";
    case "local":
      return "bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "public":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "human":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "unknown":
      return "bg-muted text-muted-foreground";
  }
}

function statusTone(status: NonNullable<NotebookActorIdentity["status"]>): string {
  switch (status) {
    case "active":
      return "bg-emerald-500";
    case "attention":
      return "bg-amber-500";
    case "idle":
      return "bg-muted-foreground";
    case "offline":
      return "bg-muted";
  }
}

function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}
