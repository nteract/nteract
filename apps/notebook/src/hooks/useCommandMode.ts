import { useEffect, useRef } from "react";
import { getActiveInteractionTarget } from "@/components/notebook/state/cell-ui-state";

/** Max gap between the two D presses that delete a cell. */
const DOUBLE_KEY_WINDOW_MS = 500;

export type CommandModeCommand =
  | "insert-above"
  | "insert-below"
  | "change-to-markdown"
  | "change-to-code"
  | "delete"
  | "toggle-output";

type RunCommand = (command: CommandModeCommand, cellId: string) => boolean;

interface UseCommandModeOptions {
  /** Enter command mode: blur the active element, select the focused cell (no editor). */
  showCommandMode: () => void;
  /** Leave command mode: focus the source editor of the selected cell. */
  enterEditMode: () => boolean;
  /** Apply a command through the shared notebook surface. */
  runCommand: RunCommand;
  /** Skip attaching the listener entirely (e.g. no notebook loaded). */
  disabled?: boolean;
}

function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

function isInteractiveTarget(el: Element | null): boolean {
  if (isEditableTarget(el)) return true;
  return Boolean(
    el?.closest(
      'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="tab"]',
    ),
  );
}

/**
 * Jupyter-style command-mode keyboard shortcuts.
 *
 * Command mode is the existing `{kind:"cell"}` notebook interaction target —
 * a cell is selected but its editor does not have DOM focus. This hook adds
 * the two-step Jupyter pattern on top of that state:
 *
 *   Escape → blur the editor/output, enter command mode (`{kind:"cell"}`)
 *   Enter  → leave command mode, focus the cell's source editor
 *
 * While in command mode, single letters mirror the most common Jupyter
 * shortcuts: A/B insert a cell above/below, M/Y change cell type, O toggles
 * output visibility, and D D (within 500ms) deletes the
 * cell. Modifier keys and focus inside a native input/textarea/select or
 * contenteditable element are ignored so this never fights browser, dialog,
 * or comment-composer shortcuts.
 */
export function useCommandMode({
  showCommandMode,
  enterEditMode,
  runCommand,
  disabled = false,
}: UseCommandModeOptions): void {
  const showCommandModeRef = useRef(showCommandMode);
  const enterEditModeRef = useRef(enterEditMode);
  const runCommandRef = useRef(runCommand);
  showCommandModeRef.current = showCommandMode;
  enterEditModeRef.current = enterEditMode;
  runCommandRef.current = runCommand;

  // Timestamp + cell id of the last bare "d" press, for the D,D delete
  // shortcut. Tracking the cell id prevents a "d" on one cell from
  // combining with a "d" on a different cell reached via a mouse click
  // (e.g. a hidden-group reveal) within the double-key window.
  const pendingDeleteRef = useRef<{ at: number; cellId: string } | null>(null);

  useEffect(() => {
    if (disabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const target = getActiveInteractionTarget();
      if (isInteractiveTarget(document.activeElement)) return;

      if (event.key === "Escape") {
        // Only act when something other than the cell itself currently owns
        // the interaction (editor, output, or a markdown heading anchor).
        // Already-in-command-mode is a no-op.
        if (target && target.kind !== "cell") {
          showCommandModeRef.current();
        }
        return;
      }

      // Everything below is a command-mode-only shortcut: require no
      // modifiers and that DOM focus isn't inside a native editable control
      // (search box, comment composer, dialog input, etc).
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Enter") {
        if (target?.kind === "cell") {
          if (enterEditModeRef.current()) event.preventDefault();
        }
        return;
      }

      if (target?.kind !== "cell") {
        pendingDeleteRef.current = null;
        return;
      }

      const key = event.key.toLowerCase();

      if (key === "d") {
        // OS/browser keyboard auto-repeat fires additional keydown events
        // (repeat:true) for a single held key, well within the double-key
        // window below. D,D is a deliberate-double-press safety convention
        // against accidental cell deletion, so repeat events must not count
        // as the second press.
        if (event.repeat) return;
        const now = performance.now();
        const pending = pendingDeleteRef.current;
        if (
          pending !== null &&
          pending.cellId === target.cellId &&
          now - pending.at <= DOUBLE_KEY_WINDOW_MS
        ) {
          pendingDeleteRef.current = null;
          if (runCommandRef.current("delete", target.cellId)) {
            event.preventDefault();
          }
        } else {
          pendingDeleteRef.current = { at: now, cellId: target.cellId };
        }
        return;
      }
      pendingDeleteRef.current = null;

      switch (key) {
        case "a":
          if (runCommandRef.current("insert-above", target.cellId)) event.preventDefault();
          break;
        case "b":
          if (runCommandRef.current("insert-below", target.cellId)) event.preventDefault();
          break;
        case "m":
          if (runCommandRef.current("change-to-markdown", target.cellId)) event.preventDefault();
          break;
        case "y":
          if (runCommandRef.current("change-to-code", target.cellId)) event.preventDefault();
          break;
        case "o":
          if (runCommandRef.current("toggle-output", target.cellId)) event.preventDefault();
          break;
        default:
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [disabled]);
}
