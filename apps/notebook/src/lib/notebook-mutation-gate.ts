import type { NotebookShellCapabilities } from "@/components/notebook";

/**
 * Resolves whether cell-structure mutations (add/delete/move, source/output
 * hiding) are allowed in the notebook view.
 *
 * `canAcceptCellMutations` is a hard gate: a live host that cannot accept
 * structure changes (e.g. a cloud notebook with no editing host attached)
 * forces this to `false` regardless of the resolved capability. Only once the
 * host accepts mutations does the shell capability `canEditStructure` — or the
 * `readOnly` fallback when no capability projection is supplied — decide.
 *
 * Kept in its own module (no React, no WASM imports) so the gate's truth table
 * can be unit-tested without pulling in the full NotebookView module graph.
 */
export function computeCanMutateCells({
  canAcceptCellMutations,
  capabilities,
  readOnly,
}: {
  canAcceptCellMutations: boolean;
  capabilities?: Pick<NotebookShellCapabilities, "canEditStructure"> | null;
  readOnly: boolean;
}): boolean {
  return canAcceptCellMutations && (capabilities?.canEditStructure ?? !readOnly);
}
