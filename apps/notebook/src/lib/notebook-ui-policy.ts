import type { NotebookHost } from "@nteract/notebook-host";

export function notebookUiPolicy(hostName: NotebookHost["name"]) {
  return {
    commentsEnabled: hostName !== "electron",
    packageToggleEnabled: hostName !== "electron",
  };
}
