export type { PyProjectDeps, PyProjectInfo } from "runtimed";
export type { TrustInfo, TyposquatWarning } from "@nteract/notebook-host";

export type EnvSyncState =
  | { status: "not_running" }
  | { status: "not_uv_managed" }
  | { status: "synced" }
  | { status: "dirty"; added: string[]; removed: string[] };
