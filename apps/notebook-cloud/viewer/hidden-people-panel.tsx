import { Button } from "@/components/ui/button";
import type { CloudHiddenPeopleState } from "./people-search-types";

export interface HiddenPeoplePanelProps {
  open: boolean;
  state: CloudHiddenPeopleState;
  onOpenChange: (open: boolean) => void;
  onUndo: (id: string) => void;
  onLoadPage: (cursor: string | null) => void;
}

export function HiddenPeoplePanel({
  open,
  state,
  onOpenChange,
  onUndo,
  onLoadPage,
}: HiddenPeoplePanelProps) {
  return (
    <div className="col-span-full grid gap-2 text-xs text-muted-foreground">
      {state.lastHidden && !open ? (
        <div role="status" className="flex items-start justify-between gap-2">
          <p>
            Collaboration suggestions between you and {state.lastHidden.displayName} are hidden.
            Notebook access and the company directory are unchanged.
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={state.busyId !== null}
            onClick={() => onUndo(state.lastHidden!.id)}
          >
            Undo
          </Button>
        </div>
      ) : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      <button
        type="button"
        className="w-fit text-left underline underline-offset-2"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        Hidden suggestions
      </button>
      {open ? (
        <section aria-label="Hidden suggestions">
          <p className="mb-2">
            Hiding stops prior collaborator suggestions in both directions. Notebook access and the
            company directory are unchanged. Undo removes only the suggestion you hid.
          </p>
          {state.status === "loading" ? <p role="status">Loading hidden suggestions…</p> : null}
          {state.status === "ready" && state.hidden.length === 0 ? (
            <p>No hidden suggestions.</p>
          ) : null}
          <ul className="divide-y divide-border/70">
            {state.hidden.map((person) => (
              <li key={person.id} className="flex items-center justify-between gap-2 py-1">
                <span className="min-w-0 truncate">{person.displayName}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Undo hiding ${person.displayName}`}
                  disabled={state.busyId !== null}
                  onClick={() => onUndo(person.id)}
                >
                  Undo
                </Button>
              </li>
            ))}
          </ul>
          {state.nextCursor ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={state.busyId !== null || state.status === "loading"}
              onClick={() => onLoadPage(state.nextCursor)}
            >
              Next hidden suggestions
            </Button>
          ) : null}
          {state.status === "error" ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onLoadPage(null)}>
              Try again
            </Button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
