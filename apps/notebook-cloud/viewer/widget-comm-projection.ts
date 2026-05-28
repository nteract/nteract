import type { WidgetStore } from "@/components/widgets/widget-store";
import { widgetCommStoreState, type SnapshotWidgetComm } from "../src/widget-comms";
import { inlineWidgetBlobUrls } from "./widget-blob-inlining";

export interface ProjectCloudWidgetCommsOptions {
  isAllowedBlobUrl?: (url: string) => boolean;
  shouldContinue?: () => boolean;
}

export async function projectCloudWidgetComms(
  store: WidgetStore,
  comms: readonly SnapshotWidgetComm[],
  projectedCommIdsRef: { current: Set<string> },
  options: ProjectCloudWidgetCommsOptions = {},
): Promise<void> {
  if (options.shouldContinue && !options.shouldContinue()) return;

  const projected = await Promise.all(
    comms.map(async (comm) => {
      const state = widgetCommStoreState(comm);
      await inlineWidgetBlobUrls(
        state,
        { textPaths: comm.text_paths, bufferPaths: comm.buffer_paths },
        { isAllowedBlobUrl: options.isAllowedBlobUrl ?? (() => false) },
      );
      return {
        bufferPaths: comm.buffer_paths,
        commId: comm.comm_id,
        state,
      };
    }),
  );

  if (options.shouldContinue && !options.shouldContinue()) return;

  const projectedCommIds = new Set<string>();
  for (const { bufferPaths, commId, state } of projected) {
    if (store.getModel(commId)) {
      store.updateModel(commId, state, bufferPaths);
    } else {
      store.createModel(commId, state, bufferPaths);
    }
    projectedCommIds.add(commId);
  }

  reconcileProjectedWidgetComms(store, projectedCommIdsRef, projectedCommIds);
}

function reconcileProjectedWidgetComms(
  store: WidgetStore,
  projectedCommIdsRef: { current: Set<string> },
  nextCommIds: Set<string>,
): void {
  for (const commId of projectedCommIdsRef.current) {
    if (!nextCommIds.has(commId)) {
      store.deleteModel(commId);
    }
  }
  projectedCommIdsRef.current = nextCommIds;
}
