import * as Immutable from "immutable";
import { ImmutableNotebook } from "@nteract/commutable";
import { ContentRef } from "@nteract/types";
import { collaboration } from "../package";

/** Update entry of local id to remote id for a cell in the cell ID mapping */
export const updateCellMap = collaboration.createMyth("updateCellMap")<
  Partial<{
    localId: string;
    remoteId: string;
  }>
>({
  reduce: (state, action) => {
    const { localId, remoteId } = action.payload;
    let cellIdMap = state.cellIdMap;
    let reverseIdMap = state.reverseCellIdMap;

    if (localId && remoteId) {
      cellIdMap = cellIdMap.set(localId, remoteId);
      reverseIdMap = reverseIdMap.set(remoteId, localId);
    }

    return state.set("cellIdMap", cellIdMap).set("reverseCellIdMap", reverseIdMap);
  }
});

/** Delete entry for local cell ID from the cell ID mapping */
export const deleteCellFromMap = collaboration.createMyth("deleteCellFromMap")<{ localId: string }>({
  reduce: (state, action) => {
    const { localId } = action.payload;
    let cellIdMap = state.cellIdMap;
    let reverseCellIdMap = state.reverseCellIdMap;

    const remoteId = cellIdMap.get(localId);
    if (remoteId) {
      reverseCellIdMap = reverseCellIdMap.delete(remoteId);
    }
    cellIdMap = cellIdMap.delete(localId);

    return state.set("cellIdMap", cellIdMap).set("reverseCellIdMap", reverseCellIdMap);
  }
});

/** Initialize cell IDs mapping between local and remote notebooks. */
export const initializeCellMap = collaboration.createMyth("initializeCellMap")<{
  notebook: ImmutableNotebook;
  contentRef: ContentRef;
}>({
  reduce: (state, action) => {
    const { notebook } = action.payload;

    // zip is always the size of the smaller sequence
    const cellIdMap = new Map<string, string>();
    notebook.cellOrder.forEach((cellId) => {
      // key - redux store cell Id, val - Fluid DDS cell Id (constant for collab session)
      cellIdMap.set(cellId, cellId);
    });

    const reverseCellIdMap = new Map<string, string>();
    cellIdMap.forEach((v: string, k: string) => reverseCellIdMap.set(v, k));

    return state.set("cellIdMap", Immutable.Map(cellIdMap)).set("reverseCellIdMap", Immutable.Map(reverseCellIdMap));
  }
});
