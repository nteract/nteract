import * as Immutable from "immutable";
import { createMythicPackage } from "@nteract/myths";
import { IActionRecorder, ICollaborationDriver, ICollaborationState } from "./types";

/** Real-time collaboration package */
export const collaboration = createMythicPackage("collaboration")<ICollaborationState>({
  initialState: {
    isLoaded: false,
    driver: (null as unknown) as ICollaborationDriver,
    recorder: (null as unknown) as IActionRecorder,
    cellIdMap: Immutable.Map(),
    reverseCellIdMap: Immutable.Map()
  }
});
