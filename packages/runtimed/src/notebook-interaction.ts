import { BehaviorSubject, distinctUntilChanged, map, type Observable } from "rxjs";

export type NotebookInteractionTarget =
  | { kind: "cell"; cellId: string }
  | { kind: "editor"; cellId: string }
  | { kind: "markdownAnchor"; cellId: string; anchorId: string }
  | { kind: "output"; cellId: string; outputId?: string };

export type PresenceInteractionTarget =
  | { kind: "cell"; cell_id: string }
  | { kind: "editor"; cell_id: string }
  | { kind: "markdown_anchor"; cell_id: string; anchor_id: string }
  | { kind: "output"; cell_id: string; output_id?: string };

export interface NotebookInteractionSnapshot {
  activeTarget: NotebookInteractionTarget | null;
  activeCellId: string | null;
  version: number;
}

export interface NotebookInteractionStore {
  readonly snapshot$: Observable<NotebookInteractionSnapshot>;
  readonly activeTarget$: Observable<NotebookInteractionTarget | null>;
  readonly activeCellId$: Observable<string | null>;
  getSnapshot: () => NotebookInteractionSnapshot;
  setActiveTarget: (target: NotebookInteractionTarget | null) => void;
  clearActiveTarget: () => void;
  subscribe: (listener: () => void) => () => void;
}

export function notebookInteractionTargetCellId(
  target: NotebookInteractionTarget | PresenceInteractionTarget | null | undefined,
): string | null {
  if (!target) return null;
  return "cellId" in target ? target.cellId : target.cell_id;
}

export function notebookInteractionTargetsEqual(
  a: NotebookInteractionTarget | null | undefined,
  b: NotebookInteractionTarget | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.cellId !== b.cellId) return false;
  if (a.kind === "markdownAnchor" && b.kind === "markdownAnchor") {
    return a.anchorId === b.anchorId;
  }
  if (a.kind === "output" && b.kind === "output") {
    return a.outputId === b.outputId;
  }
  return a.kind === "cell" || a.kind === "editor";
}

export function notebookPresenceInteractionTargetsEqual(
  a: PresenceInteractionTarget | null | undefined,
  b: PresenceInteractionTarget | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.cell_id !== b.cell_id) return false;
  if (a.kind === "markdown_anchor" && b.kind === "markdown_anchor") {
    return a.anchor_id === b.anchor_id;
  }
  if (a.kind === "output" && b.kind === "output") {
    return a.output_id === b.output_id;
  }
  return a.kind === "cell" || a.kind === "editor";
}

export function notebookInteractionTargetToPresenceTarget(
  target: NotebookInteractionTarget,
): PresenceInteractionTarget {
  switch (target.kind) {
    case "cell":
      return { kind: "cell", cell_id: target.cellId };
    case "editor":
      return { kind: "editor", cell_id: target.cellId };
    case "markdownAnchor":
      return { kind: "markdown_anchor", cell_id: target.cellId, anchor_id: target.anchorId };
    case "output":
      return target.outputId
        ? { kind: "output", cell_id: target.cellId, output_id: target.outputId }
        : { kind: "output", cell_id: target.cellId };
  }
}

export function notebookPresenceTargetToInteractionTarget(
  target: PresenceInteractionTarget,
): NotebookInteractionTarget {
  switch (target.kind) {
    case "cell":
      return { kind: "cell", cellId: target.cell_id };
    case "editor":
      return { kind: "editor", cellId: target.cell_id };
    case "markdown_anchor":
      return { kind: "markdownAnchor", cellId: target.cell_id, anchorId: target.anchor_id };
    case "output":
      return target.output_id
        ? { kind: "output", cellId: target.cell_id, outputId: target.output_id }
        : { kind: "output", cellId: target.cell_id };
  }
}

export function createNotebookInteractionStore(
  initialTarget: NotebookInteractionTarget | null = null,
): NotebookInteractionStore {
  let version = 0;
  const initialSnapshot = snapshotFor(initialTarget, version);
  const subject = new BehaviorSubject<NotebookInteractionSnapshot>(initialSnapshot);
  const snapshot$ = subject.asObservable();

  const store: NotebookInteractionStore = {
    snapshot$,
    activeTarget$: snapshot$.pipe(
      map((snapshot): NotebookInteractionTarget | null => snapshot.activeTarget),
      distinctUntilChanged((a, b) => notebookInteractionTargetsEqual(a, b)),
    ),
    activeCellId$: snapshot$.pipe(
      map((snapshot) => snapshot.activeCellId),
      distinctUntilChanged(),
    ),
    getSnapshot: () => subject.getValue(),
    setActiveTarget: (target) => {
      const current = subject.getValue();
      if (notebookInteractionTargetsEqual(current.activeTarget, target)) return;
      version += 1;
      subject.next(snapshotFor(target, version));
    },
    clearActiveTarget: () => {
      store.setActiveTarget(null);
    },
    subscribe: (listener) => {
      const subscription = snapshot$.subscribe(() => listener());
      return () => subscription.unsubscribe();
    },
  };

  return store;
}

function snapshotFor(
  activeTarget: NotebookInteractionTarget | null,
  version: number,
): NotebookInteractionSnapshot {
  return {
    activeTarget,
    activeCellId: notebookInteractionTargetCellId(activeTarget),
    version,
  };
}
