import Immutable from "immutable";
import { CellId } from "@nteract/commutable";
import { actions as coreActions, selectors as coreSelectors, AppState } from "@nteract/core";
import { AnyAction, Dispatch, Store } from "redux";
import {
  deleteCellFromMap,
  recordCellContent,
  recordDeleteCell,
  recordInsertCell,
  updateCellMap
} from "../myths";

/**
 * The recording middleware intercepts notebook edits and forwards them as mythic actions
 * for further processing.
 * The main purpose of the middleware is to gather all necessary information from the store
 * to successfully record an action by the myth.
 */
export const collaborationMiddleware = (store: Store<AppState>) => (next: Dispatch<AnyAction>) => (action: AnyAction): AnyAction => {
  const result = next(action);

  // process notebook actions after they're successfully aplied
  switch (action.type) {
    case coreActions.CREATE_CELL_ABOVE:
    case coreActions.CREATE_CELL_BELOW:
      {
        const insertAction = handleInsertCell(action as coreActions.CreateCellAbove | coreActions.CreateCellBelow, store.getState());
        if (insertAction) {
          store.dispatch(insertAction);
        }
      }
      break;
    case coreActions.MOVE_CELL:
      break;
    case coreActions.DELETE_CELL:
      const deleteAction = handleDeleteCell(action as coreActions.DeleteCell);
      if (deleteAction) {
        store.dispatch(deleteAction);
      }
      break;
    case coreActions.SET_IN_CELL:
      const contentAction = handleCellContent(action as coreActions.SetInCell<string>);
      if (contentAction) {
        store.dispatch(contentAction);
      }
      break;
  }

  return result;
};

const handleInsertCell = (action: coreActions.CreateCellAbove | coreActions.CreateCellBelow, state: AppState) => {
  // This seems to return the current focused cell, may be because the new cell
  const { contentRef, origin, remoteCellId } = action.payload as any;
  const model = coreSelectors.notebookModel(state, { contentRef });
  const insertId = action.payload.id ?? coreSelectors.notebook.cellFocused(model);
  if (!insertId) {
    return null;
  }

  const cellOrder = model.notebook.get<Immutable.List<CellId> | null>("cellOrder", null);
  const relativeIndex = cellOrder?.indexOf(insertId) ?? -1;
  let insertAt = 0;

  switch (action.type) {
    case coreActions.CREATE_CELL_ABOVE:
      insertAt = relativeIndex - 1;
      break;
    case coreActions.CREATE_CELL_BELOW:
      insertAt = relativeIndex + 1;
      break;
  }

  const newCellId = cellOrder!.get(insertAt)!;

  if (origin === "remote" && remoteCellId) {
    // Epic is fired due to a remote insertCell action
    return updateCellMap.create({ localId: newCellId, remoteId: remoteCellId! });
  } else {
    // Epic is fired due to a user action local to this client
    const cell = coreSelectors.cell.cellFromState(state, {
      id: newCellId,
      contentRef
    });
    return recordInsertCell.create({ id: newCellId, insertAt, cell });
  }
};

const handleDeleteCell = (action: coreActions.DeleteCell) => {
  // This seems to return the current focused cell, may be because the new cell
  const { id, origin } = action.payload as any;
  if (id) {
    if (origin === "remote") {
      // Epic is fired due to a remote deleteCell action
      return deleteCellFromMap.create({ localId: id });
    } else {
      // Epic is fired due to a user action local to this client
      return recordDeleteCell.create({ id });
    }
  }
  return null;
};

const handleCellContent = (action: coreActions.SetInCell<string>) => {
  const { id, path, value, origin } = action.payload as any;
  if (origin !== "remote" && id && path && path[0] === "source") {
    return recordCellContent.create({ id, value });
  }
  return null;
};
