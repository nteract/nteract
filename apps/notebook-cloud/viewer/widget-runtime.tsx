import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { createCanvasManagerRouter } from "@/components/widgets/canvas-manager-subscriptions";
import { getCrdtCommWriter } from "@/components/widgets/crdt-comm-writer";
import { createLinkManager } from "@/components/widgets/link-subscriptions";
import { WidgetStoreContext } from "@/components/widgets/widget-store-context";
import { createWidgetStore, type WidgetStore } from "@/components/widgets/widget-store";
import { WidgetUpdateManager } from "@/components/widgets/widget-update-manager";
import { parseWidgetViewModelId, WIDGET_VIEW_MIME } from "@/components/widgets/widget-state";
import { WidgetView } from "@/components/widgets/widget-view";
export {
  projectCloudWidgetComms,
  type ProjectCloudWidgetCommsOptions,
} from "./widget-comm-projection";
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

  useEffect(() => {
    cloudWidgetStoreRef = store;
    return () => {
      if (cloudWidgetStoreRef === store) {
        cloudWidgetStoreRef = null;
      }
      cloudWidgetUpdateManager.dispose();
    };
  }, [store]);

  useEffect(() => createLinkManager(store), [store]);
  useEffect(() => createCanvasManagerRouter(store), [store]);

  const value = useMemo(
    () => ({
      store,
      sendUpdate: async (commId: string, state: Record<string, unknown>) => {
        await cloudWidgetUpdateManager.updateAndPersist(commId, state);
      },
      sendCustom: () => {},
      closeComm: (commId: string) => {
        cloudWidgetUpdateManager.clearComm(commId);
        store.deleteModel(commId);
      },
    }),
    [store],
  );

  return <WidgetStoreContext.Provider value={value}>{children}</WidgetStoreContext.Provider>;
}

function CloudWidgetViewRenderer({ data }: { data: unknown }) {
  const modelId = parseWidgetViewModelId(data);
  return modelId ? <WidgetView modelId={modelId} /> : null;
}

let cloudWidgetStoreRef: WidgetStore | null = null;

const cloudWidgetUpdateManager = new WidgetUpdateManager({
  getStore: () => cloudWidgetStoreRef,
  getCrdtWriter: getCrdtCommWriter,
});
