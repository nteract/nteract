import { ImmutableCell } from "@nteract/commutable";
import { collaboration } from "../package";

export const recordInsertCell = collaboration.createMyth("recordInsertCell")<{
  id: string;
  insertAt: number;
  cell: ImmutableCell;
}>({
  thenDispatch: [
    (action, state) => {
      const { id, insertAt, cell } = action.payload;
      return state.recorder.recordInsertCell(id, insertAt, cell);
    }
  ]
});

export const recordDeleteCell = collaboration.createMyth("recordDeleteCell")<{
  id: string;
  origin?: string;
}>({
  thenDispatch: [
    (action, state) => {
      const { id } = action.payload;
      return state.recorder.recordDeleteCell(id);
    }
  ]
});

export const recordCellContent = collaboration.createMyth("recordCellContent")<{
  id: string;
  value: string;
}>({
  thenDispatch: [
    (action, state) => {
      const { id, value } = action.payload;
      return state.recorder.recordCellContent(id, value);
    }
  ]
});
