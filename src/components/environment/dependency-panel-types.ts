export type DependencyPanelVariant = "header" | "rail";

export type EnvironmentSyncState =
  | { status: "not_running" }
  | { status: "not_uv_managed" }
  | { status: "not_conda_managed" }
  | { status: "synced" }
  | { status: "dirty"; added?: string[]; removed?: string[] };

export interface DenoConfigInfo {
  path: string;
  relative_path: string;
  name: string | null;
  has_imports: boolean;
  has_tasks: boolean;
}
