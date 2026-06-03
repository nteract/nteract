export type { PyProjectDeps, PyProjectInfo } from "runtimed";
export type { EnvironmentSyncState as EnvSyncState } from "@/components/environment";

export interface TrustInfo {
  status: "trusted" | "untrusted" | "no_dependencies";
  uv_dependencies: string[];
  approved_uv_dependencies: string[];
  conda_dependencies: string[];
  approved_conda_dependencies: string[];
  conda_channels: string[];
  approved_conda_channels: string[];
  pixi_dependencies: string[];
  approved_pixi_dependencies: string[];
  pixi_pypi_dependencies: string[];
  approved_pixi_pypi_dependencies: string[];
  pixi_channels: string[];
  approved_pixi_channels: string[];
}

export interface TyposquatWarning {
  package: string;
  similar_to: string;
  distance: number;
}
