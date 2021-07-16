import { Observable } from "rxjs";
import { Store } from "redux";
import { ImmutableCell, ImmutableNotebook } from "@nteract/commutable";
import { AppState, ContentRef } from "@nteract/types";
import { MythicAction } from "@nteract/myths";
import { IActionRecorder, ICollaborationBackend, ICollaborationDriver } from "../types";

/** Collaboration driver placeholder */
export class CollaborationDriver implements ICollaborationDriver, IActionRecorder {
  constructor(
    private readonly backend: ICollaborationBackend,
    private readonly store: Store<AppState>,
    private readonly contentRef: ContentRef
  ) { }

  //#region ICollaborationDriver
  join(filePath: string, notebook: ImmutableNotebook, kernelRef: string): Observable<MythicAction> {
    throw new Error("Method not implemented.");
  }
  leave(): Observable<MythicAction> {
    throw new Error("Method not implemented.");
  }
  //#endregion

  //#region IActionRecorder
  recordInsertCell(id: string, insertAt: number, cell: ImmutableCell): Observable<MythicAction<string, string, any>> {
    throw new Error("Method not implemented.");
  }
  recordDeleteCell(id: string): Observable<MythicAction<string, string, any>> {
    throw new Error("Method not implemented.");
  }
  recordCellContent(id: string, value: string): Observable<MythicAction<string, string, any>> {
    throw new Error("Method not implemented.");
  }
//#endregion
}