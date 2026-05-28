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

export interface ProjectCloudWidgetCommsOptions {
  isAllowedTextBlobUrl?: (url: string) => boolean;
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
  const nextCommIds = new Set<string>();

  for (const comm of comms) {
    const commId = comm.comm_id;
    nextCommIds.add(commId);
    const state = widgetCommStoreState(comm);
    await inlineTextBlobUrls(state, comm.text_paths, options.isAllowedTextBlobUrl);
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

async function inlineTextBlobUrls(
  state: Record<string, unknown>,
  textPaths: string[][] | undefined,
  isAllowedTextBlobUrl: ((url: string) => boolean) | undefined,
): Promise<void> {
  if (!textPaths || textPaths.length === 0) return;
  await Promise.all(
    textPaths.map(async (path) => {
      const url = readPath(state, path);
      if (typeof url !== "string") return;
      if (!isAllowedTextBlobUrl?.(url)) return;
      try {
        const response = await fetch(url);
        if (!response.ok) return;
        writePath(state, path, await response.text());
      } catch {
        // Keep the URL string; the widget will fail locally without blocking
        // unrelated comms from rendering.
      }
    }),
  );
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writePath(value: Record<string, unknown>, path: string[], next: unknown): void {
  if (path.length === 0) return;
  let current: Record<string, unknown> = value;
  for (const segment of path.slice(0, -1)) {
    const child = current[segment];
    if (typeof child !== "object" || child === null) return;
    current = child as Record<string, unknown>;
  }
  current[path[path.length - 1]] = next;
}

function CloudWidgetViewRenderer({ data }: { data: unknown }) {
  const modelId = parseWidgetViewModelId(data);
  return modelId ? <WidgetView modelId={modelId} /> : null;
}
