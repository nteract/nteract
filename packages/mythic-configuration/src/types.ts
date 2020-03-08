import { RootState } from "@nteract/myths";
import { Map } from "immutable";
import { Observable } from "rxjs";
import { loadConfig } from "./myths/load-config";
import { mergeConfig } from "./myths/merge-config";

export type Configuration = Map<string, any>;

export interface ConfigurationBackend {
  setup: () => Observable<typeof loadConfig.action>,
  load: () => Observable<typeof mergeConfig.action>
  save: (current: Configuration) => Observable<never>,
}

export interface ConfigurationState {
  backend: ConfigurationBackend | null;
  current: Configuration;
}

export type HasPrivateConfigurationState =
  RootState<"configuration", ConfigurationState>;