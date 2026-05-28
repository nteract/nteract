import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { createCanvasManagerRouter } from "@/components/widgets/canvas-manager-subscriptions";
import { createLinkManager } from "@/components/widgets/link-subscriptions";
import { WidgetStoreContext } from "@/components/widgets/widget-store-context";
import { createWidgetStore, type WidgetStore } from "@/components/widgets/widget-store";
import { parseWidgetViewModelId, WIDGET_VIEW_MIME } from "@/components/widgets/widget-state";
import { WidgetView } from "@/components/widgets/widget-view";
import { widgetCommStoreState, type SnapshotWidgetComm } from "../src/widget-comms";
import { inlineWidgetBlobUrls } from "./widget-blob-inlining";
import "@/components/widgets/controls";

export const CLOUD_WIDGET_RENDERERS = {
  [WIDGET_VIEW_MIME]: CloudWidgetViewRenderer,
};

export interface ProjectCloudWidgetCommsOptions {
  isAllowedBlobUrl?: (url: string) => boolean;
  shouldContinue?: () => boolean;
}

export function CloudWidgetStoreProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<WidgetStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createWidgetStore();
  }
  const store = storeRef.current;

  useEffect(() => createLinkManager(store), [store]);
  useEffect(() => createCanvasManagerRouter(store), [store]);

  const value = useMemo(
    () => ({
      store,
      sendUpdate: async (commId: string, state: Record<string, unknown>) => {
        store.updateModel(commId, state);
      },
      sendCustom: () => {},
      closeComm: (commId: string) => {
        store.deleteModel(commId);
      },
    }),
    [store],
  );

  return <WidgetStoreContext.Provider value={value}>{children}</WidgetStoreContext.Provider>;
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

function CloudWidgetViewRenderer({ data }: { data: unknown }) {
  const modelId = parseWidgetViewModelId(data);
  return modelId ? <WidgetView modelId={modelId} /> : null;
}
