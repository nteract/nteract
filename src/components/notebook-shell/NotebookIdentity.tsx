import {
  Bot,
  Cog,
  Cpu,
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
import type {
  NotebookShellAccessCapabilities,
  NotebookShellAuthCapabilities,
} from "./capabilities";
import {
  friendlyNotebookActorLabel,
  parseNotebookActorLabel,
  type ParsedNotebookActorKind,
} from "./actor-labels";

export type NotebookActorKind =
  | "agent"
  | "human"
  | "local"
  | "public"
  | "runtime"
  | "system"
  | "unknown";

export interface NotebookActorIdentity {
  id: string;
  label: string;
  detail: string | null;
  kind: NotebookActorKind;
  imageUrl?: string | null;
  status?: "active" | "attention" | "idle" | "offline";
}

export interface NotebookIdentityBadgeProps {
  actor: NotebookActorIdentity;
  size?: "sm" | "default";
  showDetail?: boolean;
  className?: string;
}

export interface NotebookIdentityGroupProps {
  actors: readonly NotebookActorIdentity[];
  maxVisible?: number;
  label?: string;
  className?: string;
}

export function notebookActorFromAccess(
  access: NotebookShellAccessCapabilities,
  auth?: NotebookShellAuthCapabilities,
): NotebookActorIdentity {
  const parsedLabel = parseNotebookActorLabel(access.actorLabel);
  const kind = actorKindFromAccess(access, parsedLabel?.kind ?? null);
  const accessLabel = accessLevelLabel(access.level);
  const sourceLabel = accessSourceLabel(access.source);

  if (parsedLabel?.kind === "agent") {
    const behalfLabel = access.identityLabel ?? parsedLabel.onBehalfOf;
    return {
      id: access.actorLabel ?? parsedLabel.label,
      label: parsedLabel.label,
      detail: behalfLabel ? `on behalf of ${behalfLabel}` : accessLabel,
      kind: "agent",
      status: auth?.needsAttention ? "attention" : "active",
    };
  }

  if (parsedLabel?.kind === "runtime") {
    return {
      id: access.actorLabel ?? parsedLabel.label,
      label: parsedLabel.label,
      detail: access.identityLabel ? `for ${access.identityLabel}` : accessLabel,
      kind: "runtime",
      status: auth?.needsAttention ? "attention" : "active",
    };
  }

  if (parsedLabel?.kind === "system") {
    return {
      id: access.actorLabel ?? parsedLabel.label,
      label: parsedLabel.label,
      detail: access.identityLabel ? `for ${access.identityLabel}` : accessLabel,
      kind: "system",
      status: auth?.needsAttention ? "attention" : "active",
    };
  }

  if (access.isPublic) {
    return {
      id: access.actorLabel ?? "public-viewer",
      label: access.identityLabel ?? "Public viewer",
      detail: accessLabel,
      kind: "public",
      status: auth?.needsAttention ? "attention" : "active",
    };
  }

  const label =
    access.identityLabel ?? friendlyNotebookActorLabel(access.actorLabel) ?? "Unknown viewer";
  const detail =
    sourceLabel === null ? accessLabel : `${accessLabel.toLowerCase()} through ${sourceLabel}`;

  return {
    id: access.actorLabel ?? label,
    label,
    detail,
    kind,
    status: auth?.needsAttention ? "attention" : "active",
  };
}

export function NotebookIdentityBadge({
  actor,
  size = "default",
  showDetail = true,
  className,
}: NotebookIdentityBadgeProps) {
  const Icon = actorIcon(actor.kind);
  const avatarSize = size === "sm" ? "sm" : "default";

  return (
    <div
      className={cn(
        "inline-flex min-w-0 items-center gap-2 rounded-full border border-border bg-background px-2 py-1 text-foreground shadow-sm",
        size === "sm" && "gap-1.5 px-1.5 py-0.5",
        className,
      )}
      data-slot="notebook-identity-badge"
      data-actor-kind={actor.kind}
      data-actor-status={actor.status ?? "active"}
      title={actor.detail ? `${actor.label} - ${actor.detail}` : actor.label}
    >
      <NotebookActorAvatar actor={actor} icon={Icon} size={avatarSize} />
      <span className="min-w-0">
        <span
          className={cn(
            "block truncate font-medium leading-tight",
            size === "sm" ? "text-xs" : "text-sm",
          )}
        >
          {actor.label}
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

function NotebookActorAvatar({
  actor,
  icon: Icon,
  size = "default",
}: {
  actor: NotebookActorIdentity;
  icon: LucideIcon;
  size?: "sm" | "default";
}) {
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
      <AvatarBadge className={statusTone(actor.status ?? "active")} />
    </Avatar>
  );
}

function actorKindFromAccess(
  access: NotebookShellAccessCapabilities,
  parsedKind: ParsedNotebookActorKind | null,
): NotebookActorKind {
  if (parsedKind) return parsedKind;
  if (access.isPublic) return "public";
  if (access.source === "local") return "local";
  if (access.identityLabel || access.actorLabel) return "human";
  return "unknown";
}

function actorIcon(kind: NotebookActorKind): LucideIcon {
  switch (kind) {
    case "agent":
      return Bot;
    case "runtime":
      return Cpu;
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

function accessLevelLabel(level: NotebookShellAccessCapabilities["level"]): string {
  switch (level) {
    case "none":
      return "No access";
    case "viewer":
      return "Viewer";
    case "editor":
      return "Editor";
    case "owner":
      return "Owner";
  }
}

function accessSourceLabel(source: NotebookShellAccessCapabilities["source"]): string | null {
  switch (source) {
    case "cloud":
      return "cloud";
    case "local":
      return "local";
    case "fixture":
      return "fixture";
    case "unknown":
      return null;
  }
}

function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}
