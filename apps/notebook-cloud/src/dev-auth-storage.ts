import type { ConnectionScope } from "./auth-shared.ts";

export const NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY = "nteract:notebook-cloud:dev-token";
export const NOTEBOOK_CLOUD_USER_STORAGE_KEY = "nteract:notebook-cloud:user";
export const NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY = "nteract:notebook-cloud:scope";
export const NOTEBOOK_CLOUD_DEFAULT_SCOPE: ConnectionScope = "viewer";
