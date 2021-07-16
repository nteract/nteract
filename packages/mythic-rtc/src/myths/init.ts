import { Store } from "redux";
import { AppState, ContentRef } from "@nteract/types";
import { CollaborationDriver } from "../driver";
import { collaboration } from "../package";
import { ICollaborationBackend } from "../types";

/**
 * Initializes the collaboration package by creating the driver and recorder.
 * Should be dispatched prior to joining a session.
*/
export const initCollaboration = collaboration.createMyth("init")<{
  store: Store<AppState>;
  backend: ICollaborationBackend;
  contentRef: ContentRef;
}>({
  reduce: (state, action) => {
    const { store: theAppStore, contentRef } = action.payload;
    const backend = action.payload.backend;
    const driver = new CollaborationDriver(backend, theAppStore, contentRef);
    return state.set("driver", driver).set("recorder", driver);
  }
});
