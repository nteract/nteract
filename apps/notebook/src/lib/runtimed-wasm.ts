import { setMarkdownProjectionProjector } from "@/lib/markdown-projection";
import init, {
  encode_heartbeat_presence,
  NotebookHandle,
  project_markdown_json,
} from "../wasm/runtimed-wasm/runtimed_wasm.js";

let notebookWasmReady: Promise<void> | undefined;

export function ensureNotebookWasmReady(): Promise<void> {
  notebookWasmReady ??= init().then(() => {
    setMarkdownProjectionProjector(project_markdown_json);
  });
  return notebookWasmReady;
}

export { encode_heartbeat_presence, NotebookHandle };
