import { useObservableProjection } from "@/components/notebook/state/observable-binding";
import { useCloudStores } from "./cloud-stores-context";

export function useCloudNotebookHomeState() {
  return useObservableProjection(useCloudStores().notebookHome.state$);
}
