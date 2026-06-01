import { cn } from "@/lib/utils";
import { NotebookIdentityBadge } from "./NotebookIdentity";
import {
  notebookActorIdentityFromAccess,
  notebookActorIdentityFromRuntime,
} from "./actor-projection";
import type { NotebookActorIdentity, NotebookShellCapabilities } from "./capabilities";

export interface NotebookToolbarIdentityProps {
  capabilities: NotebookShellCapabilities;
  maxVisible?: number;
  showDetail?: boolean;
  className?: string;
}

export function NotebookToolbarIdentity({
  capabilities,
  maxVisible = 2,
  showDetail = false,
  className,
}: NotebookToolbarIdentityProps) {
  const actors = notebookToolbarActors(capabilities).slice(0, maxVisible);

  return (
    <div
      className={cn("flex min-w-0 items-center gap-1.5", className)}
      data-slot="notebook-toolbar-identity"
      aria-label="Notebook actors"
    >
      {actors.map((actor) => (
        <NotebookIdentityBadge key={actor.id} actor={actor} size="sm" showDetail={showDetail} />
      ))}
    </div>
  );
}

export function notebookToolbarActors(
  capabilities: NotebookShellCapabilities,
): NotebookActorIdentity[] {
  const candidates = [
    notebookActorIdentityFromAccess(capabilities.access, capabilities.auth),
    notebookActorIdentityFromRuntime(capabilities.runtime, capabilities.auth),
  ].filter((actor): actor is NotebookActorIdentity => Boolean(actor));
  const actors: NotebookActorIdentity[] = [];
  const actorIds = new Set<string>();

  for (const actor of candidates) {
    if (actorIds.has(actor.id)) continue;
    actorIds.add(actor.id);
    actors.push(actor);
  }

  return actors;
}
