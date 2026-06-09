import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { createCanvasManagerRouter } from "@/components/widgets/canvas-manager-subscriptions";
import { getCrdtCommWriter } from "@/components/widgets/crdt-comm-writer";
import { createLinkManager } from "@/components/widgets/link-subscriptions";
import { WidgetStoreContext } from "@/components/widgets/widget-store-context";
import { createWidgetStore, type WidgetStore } from "@/components/widgets/widget-store";
import { WidgetUpdateManager } from "@/components/widgets/widget-update-manager";
import { parseWidgetViewModelId, WIDGET_VIEW_MIME } from "@/components/widgets/widget-state";
import { WidgetView } from "@/components/widgets/widget-view";
import type { CommChanges } from "runtimed";
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
  useEffect(() => installCloudWidgetDiagnostics(store), [store]);

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

export function applyCloudWidgetCommChanges(store: WidgetStore, changes: CommChanges): void {
  for (const comm of changes.opened) {
    store.createModel(comm.commId, cloudWidgetStateWithMetadata(comm), comm.bufferPaths);
  }
  for (const comm of changes.updated) {
    if (!store.getModel(comm.commId)) {
      store.createModel(comm.commId, cloudWidgetStateWithMetadata(comm), comm.bufferPaths);
      continue;
    }
    const filtered = cloudWidgetUpdateManager.shouldSuppressEcho(comm.commId, comm.state);
    if (filtered) {
      store.updateModel(comm.commId, filtered, comm.bufferPaths);
    }
  }
  for (const commId of changes.closed) {
    cloudWidgetUpdateManager.clearComm(commId);
    store.deleteModel(commId);
  }
}

function cloudWidgetStateWithMetadata(
  comm: CommChanges["opened"][number] | CommChanges["updated"][number],
): Record<string, unknown> {
  const state = { ...comm.state };
  state._model_module ??= comm.modelModule || undefined;
  state._model_name ??= comm.modelName || undefined;
  return state;
}

let cloudWidgetStoreRef: WidgetStore | null = null;

const cloudWidgetUpdateManager = new WidgetUpdateManager({
  getStore: () => cloudWidgetStoreRef,
  getCrdtWriter: getCrdtCommWriter,
});

function installCloudWidgetDiagnostics(store: WidgetStore): () => void {
  if (typeof window === "undefined") return () => {};
  try {
    if (window.localStorage?.getItem("nteract:notebook-cloud:widget-diagnostics") !== "1") {
      return () => {};
    }
  } catch {
    return () => {};
  }

  const target = window as unknown as {
    __nteractCloudWidgetStoreSnapshot?: () => Array<{
      id: string;
      modelModule: string;
      modelName: string;
      state: Record<string, unknown>;
    }>;
  };
  target.__nteractCloudWidgetStoreSnapshot = () =>
    Array.from(store.getSnapshot().values()).map((model) => ({
      id: model.id,
      modelModule: model.modelModule,
      modelName: model.modelName,
      state: model.state,
    }));

  return () => {
    if (target.__nteractCloudWidgetStoreSnapshot) {
      delete target.__nteractCloudWidgetStoreSnapshot;
    }
  };
}
