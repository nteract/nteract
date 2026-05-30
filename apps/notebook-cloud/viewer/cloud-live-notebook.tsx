import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { ReadOnlyNotebookCell } from "@/components/cell/ReadOnlyNotebookCell";
import type { RemoteCellPresence } from "@/components/editor/presence-state";
import { NotebookCellList } from "@/components/notebook-shell";
import type { TracebackCellTarget } from "@/components/outputs/traceback-output";
import { EditableMarkdownCell, type CloudTextAttributionQueue } from "./editable-markdown-cell";
import type { CloudLivePresenceSnapshot } from "./live-presence";
import type { CloudSyncRuntime } from "./live-sync";
import type { ResolvedCell } from "./render-resolution";
import { cloudSourceLanguage } from "./source-language";

export interface CloudLiveNotebookProps {
  cells: ResolvedCell[];
  priority: readonly string[];
  hostContext: NteractEmbedHostContextPatch;
  showCode: boolean;
  getHandle: () => CloudSyncRuntime["handle"] | null;
  localActorLabel: string | null;
  textAttributionQueue: CloudTextAttributionQueue;
  livePresence: CloudLivePresenceSnapshot;
  onMarkdownSourceChange: (cellId: string, source: string) => void;
  onMarkdownSyncNeeded: () => void;
  onPresenceCursor: (cellId: string, line: number, column: number) => void;
  onPresenceSelection: (
    cellId: string,
    anchorLine: number,
    anchorCol: number,
    headLine: number,
    headCol: number,
  ) => void;
  resolveTracebackExecutionTarget: (executionId: string) => TracebackCellTarget | null;
  onNavigateToTracebackCell: (target: TracebackCellTarget) => void;
}

export function CloudLiveNotebook({
  cells,
  priority,
  hostContext,
  showCode,
  getHandle,
  localActorLabel,
  textAttributionQueue,
  onMarkdownSourceChange,
  onMarkdownSyncNeeded,
  livePresence,
  onPresenceCursor,
  onPresenceSelection,
  resolveTracebackExecutionTarget,
  onNavigateToTracebackCell,
}: CloudLiveNotebookProps) {
  return (
    <NotebookCellList
      cells={cells}
      className="cloud-report-notebook"
      slot="cloud-live-notebook"
      renderCellError={(error, _cell, index) => (
        <div className="cloud-state" data-kind="error">
          Unable to render cell {index + 1}: {error.message}
        </div>
      )}
      renderCell={(cell) =>
        cell.cellType === "markdown" ? (
          <EditableMarkdownCell
            cell={cell}
            className="cloud-cell cloud-editable-markdown-cell"
            sourceClassName="cloud-source-block"
            priority={priority}
            hostContext={hostContext}
            onSourceChange={onMarkdownSourceChange}
            onSyncNeeded={onMarkdownSyncNeeded}
            getHandle={getHandle}
            localActorLabel={localActorLabel}
            textAttributionQueue={textAttributionQueue}
            remotePresence={presenceForCell(livePresence, cell.id)}
            onPresenceCursor={onPresenceCursor}
            onPresenceSelection={onPresenceSelection}
          />
        ) : (
          <ReadOnlyNotebookCell
            id={cell.id}
            cellType={cell.cellType}
            source={cell.source}
            language={cloudSourceLanguage(cell.language)}
            outputs={cell.outputs}
            executionCount={cell.executionCount}
            priority={priority}
            hostContext={hostContext}
            displayMode="report"
            showSource={cell.cellType !== "code" || showCode}
            className="cloud-cell"
            sourceClassName="cloud-source-block"
            outputClassName="cloud-output-block"
            deferIsolatedFrameUntilVisible
            deferredIsolatedFrameRootMargin="600px 0px"
            resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
            onNavigateToTracebackCell={onNavigateToTracebackCell}
          />
        )
      }
    />
  );
}

function presenceForCell(
  livePresence: CloudLivePresenceSnapshot,
  cellId: string,
): RemoteCellPresence {
  return livePresence.cells.get(cellId) ?? EMPTY_REMOTE_CELL_PRESENCE;
}

const EMPTY_REMOTE_CELL_PRESENCE: RemoteCellPresence = {
  cursors: [],
  selections: [],
};
