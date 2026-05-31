import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { ReadOnlyNotebookCell } from "@/components/cell/ReadOnlyNotebookCell";
import type { RemoteCellPresence } from "@/components/editor/presence-state";
import { NotebookEditableView, type NotebookViewModel } from "@/components/notebook-shell";
import type { TracebackCellTarget } from "@/components/outputs/traceback-output";
import type { CloudTextAttributionQueue } from "./cloud-cell-editing";
import { EditableCodeCell } from "./editable-code-cell";
import { EditableMarkdownCell } from "./editable-markdown-cell";
import type { CloudLivePresenceSnapshot } from "./live-presence";
import type { CloudSyncRuntime } from "./live-sync";
import type { ResolvedCell } from "./render-resolution";
import { cloudSourceLanguage } from "./source-language";

export interface CloudLiveNotebookProps {
  viewModel: NotebookViewModel<ResolvedCell>;
  priority: readonly string[];
  hostContext: NteractEmbedHostContextPatch;
  showCode: boolean;
  getHandle: () => CloudSyncRuntime["handle"] | null;
  localActorLabel: string | null;
  textAttributionQueue: CloudTextAttributionQueue;
  livePresence: CloudLivePresenceSnapshot;
  onCellSourceChange: (cellId: string, source: string) => void;
  onCellSyncNeeded: () => void;
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
  viewModel,
  priority,
  hostContext,
  showCode,
  getHandle,
  localActorLabel,
  textAttributionQueue,
  onCellSourceChange,
  onCellSyncNeeded,
  livePresence,
  onPresenceCursor,
  onPresenceSelection,
  resolveTracebackExecutionTarget,
  onNavigateToTracebackCell,
}: CloudLiveNotebookProps) {
  return (
    <NotebookEditableView
      viewModel={viewModel}
      className="cloud-report-notebook"
      slot="cloud-live-notebook"
      renderCellError={(error, _cell, index) => (
        <div className="cloud-state" data-kind="error">
          Unable to render cell {index + 1}: {error.message}
        </div>
      )}
      renderMarkdownCell={(cell) => (
        <EditableMarkdownCell
          cell={cell}
          className="cloud-cell cloud-editable-markdown-cell"
          sourceClassName="cloud-source-block"
          priority={priority}
          hostContext={hostContext}
          onSourceChange={onCellSourceChange}
          onSyncNeeded={onCellSyncNeeded}
          getHandle={getHandle}
          localActorLabel={localActorLabel}
          textAttributionQueue={textAttributionQueue}
          remotePresence={presenceForCell(livePresence, cell.id)}
          onPresenceCursor={onPresenceCursor}
          onPresenceSelection={onPresenceSelection}
        />
      )}
      renderCodeCell={(cell) => (
        <EditableCodeCell
          cell={cell}
          className="cloud-cell cloud-editable-code-cell"
          sourceClassName="cloud-source-block"
          outputClassName="cloud-output-block"
          priority={priority}
          hostContext={hostContext}
          showSource={showCode}
          onSourceChange={onCellSourceChange}
          onSyncNeeded={onCellSyncNeeded}
          getHandle={getHandle}
          localActorLabel={localActorLabel}
          textAttributionQueue={textAttributionQueue}
          remotePresence={presenceForCell(livePresence, cell.id)}
          onPresenceCursor={onPresenceCursor}
          onPresenceSelection={onPresenceSelection}
          resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
          onNavigateToTracebackCell={onNavigateToTracebackCell}
        />
      )}
      renderFallbackCell={(cell) => (
        <ReadOnlyNotebookCell
          id={cell.id}
          cellType={cell.cellType}
          source={cell.source}
          language={cloudSourceLanguage(cell.language)}
          outputs={cell.outputs}
          executionCount={cell.executionCount}
          priority={priority}
          hostContext={hostContext}
          showSource
          className="cloud-cell"
          sourceClassName="cloud-source-block"
          outputClassName="cloud-output-block"
          deferIsolatedFrameUntilVisible
          deferredIsolatedFrameRootMargin="600px 0px"
          resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
          onNavigateToTracebackCell={onNavigateToTracebackCell}
        />
      )}
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
