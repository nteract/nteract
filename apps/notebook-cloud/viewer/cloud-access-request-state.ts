import type { ConnectionScope } from "../src/auth-shared";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type { CloudNotebookUrlMode } from "./cloud-notebook-mode";
import type { CloudNotebookAccessRequest } from "./sharing-client";

export interface CloudAccessRequestTransition {
  requestedScope: ConnectionScope | null;
  selectedMode: CloudNotebookUrlMode | null;
  refreshPrototypeAuth: boolean;
  retryLiveConnection: boolean;
}

export interface ProjectCloudAccessRequestTransitionOptions {
  accessScope?: string | null;
  authState: Pick<CloudPrototypeAuthState, "mode" | "requestedScope">;
  connectionScope: string | null;
  hasAppSession: boolean;
  request: Pick<CloudNotebookAccessRequest, "status"> | null;
  selectedMode: CloudNotebookUrlMode;
}

const NO_CLOUD_ACCESS_REQUEST_TRANSITION: CloudAccessRequestTransition = Object.freeze({
  requestedScope: null,
  selectedMode: null,
  refreshPrototypeAuth: false,
  retryLiveConnection: false,
});

export function projectCloudAccessRequestTransition({
  accessScope = null,
  authState,
  connectionScope,
  hasAppSession,
  request,
  selectedMode,
}: ProjectCloudAccessRequestTransitionOptions): CloudAccessRequestTransition {
  if (accessScope === "editor" || accessScope === "owner") {
    return NO_CLOUD_ACCESS_REQUEST_TRANSITION;
  }

  if (request?.status === "pending" || request?.status === "approved") {
    if (selectedMode !== "edit") {
      return NO_CLOUD_ACCESS_REQUEST_TRANSITION;
    }
    return {
      requestedScope: "editor",
      selectedMode: "edit",
      refreshPrototypeAuth:
        cloudPrototypeAuthCarriesRequestedScope(authState.mode, hasAppSession) &&
        authState.requestedScope !== "editor",
      retryLiveConnection: request.status === "approved",
    };
  }

  if (
    authState.requestedScope === "editor" &&
    connectionScope === "viewer" &&
    cloudPrototypeAuthCarriesRequestedScope(authState.mode, hasAppSession)
  ) {
    return {
      requestedScope: "viewer",
      selectedMode: "view",
      refreshPrototypeAuth: true,
      retryLiveConnection: false,
    };
  }

  return NO_CLOUD_ACCESS_REQUEST_TRANSITION;
}

export function cloudPrototypeAuthCarriesRequestedScope(
  mode: CloudPrototypeAuthState["mode"],
  hasAppSession: boolean,
): boolean {
  if (mode === "dev") {
    return true;
  }
  if (hasAppSession) {
    return false;
  }
  return mode === "oidc" || mode === "invalid";
}
