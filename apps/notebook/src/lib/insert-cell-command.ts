import type { CommandRegistry } from "@nteract/notebook-host";
import {
  flushCellUIState,
  getFocusedCellId,
  setActiveInteractionTarget,
} from "@/components/notebook/state/cell-ui-state";

type AddCell = (
  type: "code" | "markdown" | "raw",
  afterCellId?: string | null,
) => { id: string } | null;

/** Keep the native command registered while reading the latest app handler. */
export function registerInsertCellCommand(
  commands: CommandRegistry,
  getAddCell: () => AddCell,
): () => void {
  return commands.register("notebook.insertCell", ({ type }) => {
    const added = getAddCell()(type, getFocusedCellId());
    if (added && type === "markdown") {
      setActiveInteractionTarget({ kind: "editor", cellId: added.id });
      flushCellUIState();
    }
  });
}
