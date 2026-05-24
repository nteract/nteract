import { isLoopbackBaseUrl } from "./wasm-roundtrip-env.mjs";
import {
  NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY,
  NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY,
  NOTEBOOK_CLOUD_USER_STORAGE_KEY,
} from "../viewer/collaborator-auth.ts";

export function assertHostedCollabSmokeEnv({ baseUrl, devAuthToken }) {
  if (devAuthToken || isLoopbackBaseUrl(baseUrl)) {
    return;
  }

  throw new Error(
    "NOTEBOOK_CLOUD_DEV_TOKEN is required when hosted collaboration smoke targets a deployed notebook-cloud host. The browser smoke stores it in localStorage and sends it through the WebSocket subprotocol; it must not be placed in URLs.",
  );
}

export function browserDevTokenForSmoke({ baseUrl, devAuthToken }) {
  if (devAuthToken) {
    return devAuthToken;
  }
  if (isLoopbackBaseUrl(baseUrl)) {
    return "local-dev-token";
  }
  throw new Error("NOTEBOOK_CLOUD_DEV_TOKEN is required for deployed browser collaboration smoke");
}

export function viewerUrlForRoom(baseUrl, roomId) {
  return new URL(`/n/${encodeURIComponent(roomId)}`, baseUrl).href;
}

export function storageStateForDevIdentity({ origin, token, user, scope }) {
  return {
    origins: [
      {
        origin,
        localStorage: [
          {
            name: NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY,
            value: token,
          },
          {
            name: NOTEBOOK_CLOUD_USER_STORAGE_KEY,
            value: user,
          },
          {
            name: NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY,
            value: scope,
          },
        ],
      },
    ],
  };
}
