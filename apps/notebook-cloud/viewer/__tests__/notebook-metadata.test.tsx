import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vite-plus/test";
import { NotebookMetadataStore } from "runtimed";
import { useNotebookMetadataStore } from "@/components/notebook/state/notebook-metadata";

it("updates saved requirements from a metadata-only document change without remounting", () => {
  const store = new NotebookMetadataStore();
  let requirements: string[] = [];
  const handle = {
    get_metadata_fingerprint: () => requirements.join(","),
    get_metadata_snapshot: () => ({ runt: { pyodide: { requirements } } }),
  };
  store.refresh(handle);
  const { result } = renderHook(() => useNotebookMetadataStore(store));
  expect(result.current).toEqual({ runt: { pyodide: { requirements: [] } } });
  act(() => {
    requirements = ["snowballstemmer>=2,<4"];
    store.refresh(handle);
  });
  expect(result.current).toEqual({ runt: { pyodide: { requirements } } });
});
