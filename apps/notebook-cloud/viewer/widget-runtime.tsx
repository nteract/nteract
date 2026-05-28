import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { createCanvasManagerRouter } from "@/components/widgets/canvas-manager-subscriptions";
import { createLinkManager } from "@/components/widgets/link-subscriptions";
import { WidgetStoreContext } from "@/components/widgets/widget-store-context";
import { createWidgetStore, type WidgetStore } from "@/components/widgets/widget-store";
import { parseWidgetViewModelId, WIDGET_VIEW_MIME } from "@/components/widgets/widget-state";
import { WidgetView } from "@/components/widgets/widget-view";
import { widgetCommStoreState, type SnapshotWidgetComm } from "../src/widget-comms";
import "@/components/widgets/controls";

export const CLOUD_WIDGET_RENDERERS = {
  [WIDGET_VIEW_MIME]: CloudWidgetViewRenderer,
};

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

export function projectCloudWidgetComms(
  store: WidgetStore,
  comms: readonly SnapshotWidgetComm[],
  projectedCommIdsRef: { current: Set<string> },
): void {
  const nextCommIds = new Set<string>();

  for (const comm of comms) {
    const commId = comm.comm_id;
    nextCommIds.add(commId);
    const state = widgetCommStoreState(comm);
    if (store.getModel(commId)) {
      store.updateModel(commId, state, comm.buffer_paths);
    } else {
      store.createModel(commId, state, comm.buffer_paths);
    }
  }

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
