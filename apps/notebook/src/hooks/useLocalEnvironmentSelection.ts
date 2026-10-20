import { useEffect, useState } from "react";
import { Observable } from "rxjs";
import { EnvironmentSelectionStore, type ConnectionStatus, type NotebookClient } from "runtimed";
import { useObservableProjection } from "@/components/notebook/state/observable-binding";
import { subscribeBroadcast } from "../lib/notebook-frame-bus";

const environmentSelectionBroadcasts$ = new Observable<unknown>((subscriber) =>
  subscribeBroadcast((payload) => subscriber.next(payload)),
);

export function useLocalEnvironmentSelection({
  client,
  enabled,
  connectionGeneration,
  connectionStatus$,
}: {
  client: NotebookClient;
  enabled: boolean;
  connectionGeneration: number;
  connectionStatus$: Observable<ConnectionStatus>;
}) {
  const [store] = useState(() => new EnvironmentSelectionStore());
  const state = useObservableProjection(store.state$);

  useEffect(() => {
    // A transport redial must wait for a fresh capability-bearing ready event.
    let attachmentValid = true;
    const subscription = connectionStatus$.subscribe((status) => {
      if (status !== "online") attachmentValid = false;
      if (enabled && attachmentValid && status === "online")
        store.activate({ client, broadcasts$: environmentSelectionBroadcasts$ });
      else store.dispose();
    });
    return () => {
      subscription.unsubscribe();
      store.dispose();
    };
  }, [client, connectionGeneration, connectionStatus$, enabled, store]);

  return { state, store };
}
