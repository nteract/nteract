import type { NotebookRequest } from "runtimed";

/** Keep in sync with notebook-sync's `relay_task::request_timeout`. */
export function requestTimeoutMs(request: NotebookRequest): number {
  switch (request.type) {
    case "launch_kernel":
    case "sync_environment":
    case "apply_environment_selection":
      return 300_000;
    case "complete":
      return 7_000;
    default:
      return 30_000;
  }
}
