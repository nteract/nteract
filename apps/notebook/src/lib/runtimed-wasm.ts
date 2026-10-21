import { setMarkdownProjectionProjector } from "@/lib/markdown-projection";
import init, {
  bokeh_session_frame_header,
  BokehSessionDocHandle,
  encode_heartbeat_presence,
  NotebookHandle,
  project_markdown_json,
} from "../wasm/runtimed-wasm/runtimed_wasm.js";

let notebookWasmReady: Promise<void> | undefined;

export function ensureNotebookWasmReady(): Promise<void> {
  notebookWasmReady ??= init()
    .then(() => {
      setMarkdownProjectionProjector(project_markdown_json);
    })
    .catch((error: unknown) => {
      notebookWasmReady = undefined;
      throw error;
    });
  return notebookWasmReady;
}

export {
  bokeh_session_frame_header,
  BokehSessionDocHandle,
  encode_heartbeat_presence,
  NotebookHandle,
};
