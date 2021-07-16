import * as Immutable from "immutable";
import { Observable } from "rxjs";
import { ImmutableCell, ImmutableNotebook } from "@nteract/commutable";
import { KernelRef } from "@nteract/types";
import { MythicAction, RootState } from "@nteract/myths";

/** Orchestrates the collaboration session behavior. The driver API is used solely by myths. */
export interface ICollaborationDriver {
  /** Join a collaboration session by sharing the current notebook. */
  join(filePath: string, notebook: ImmutableNotebook, kernelRef: KernelRef): Observable<MythicAction>;
  /** Leave the collaboration session */
  leave(): Observable<MythicAction>;
}

/** Coordinates notebook actions recording. Used to decouple the backend from the store. */
export interface IActionRecorder {
  recordInsertCell(id: string, insertAt: number, cell: ImmutableCell): Observable<MythicAction>;
  recordDeleteCell(id: string): Observable<MythicAction>;
  recordCellContent(id: string, value: string): Observable<MythicAction>;
}

/** Abstraction over a vendor provided RTC functionality. TBD */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ICollaborationBackend {
}

/** RTC package state */
export interface ICollaborationState {
  /** Active state */
  isLoaded: boolean;
  /** Current driver instance. Needed to access from myths. */
  driver: ICollaborationDriver;
  /** Needed by action recording myths. */
  recorder: IActionRecorder;
  /** Needed to keep cell IDs mapping b/w remote and local cells. */
  cellIdMap: Immutable.Map<string, string>;
  /** Reverse cell ID mapping. */
  reverseCellIdMap: Immutable.Map<string, string>;
}

/** Combined app store state with included RTC package */
export type CollabRootState = RootState<"collaboration", ICollaborationState>;
