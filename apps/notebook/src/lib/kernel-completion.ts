import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { useMemo } from "react";
import { useNotebookHost } from "@nteract/notebook-host";
import { NotebookClient } from "runtimed";

/**
 * CodeMirror completion source that queries the Jupyter kernel for code
 * completions via the `complete` request.
 *
 * Only activates on explicit request (Ctrl+Space / Tab) to avoid per-
 * keystroke kernel round-trips that thrash busy→idle status and
 * generate excessive Automerge sync traffic.
 */
function createKernelCompletionSource(client: NotebookClient | null) {
  return async function kernelCompletionSource(
    context: CompletionContext,
  ): Promise<CompletionResult | null> {
    if (!context.explicit) return null;
    if (!client) return null;

    const code = context.state.doc.toString();
    const cursorPos = context.pos;

    try {
      const result = await client.complete(code, cursorPos);

      if (context.aborted) return null;
      if (!result.items || result.items.length === 0) return null;

      return {
        from: result.cursorStart,
        to: result.cursorEnd,
        options: result.items.map((item) => ({ label: item.label })),
      };
    } catch {
      // Kernel not running or request failed — silently return no completions
      return null;
    }
  };
}

/**
 * CodeMirror extension that provides Jupyter kernel-based tab completion.
 * Add this to the editor's extensions to enable it.
 */
export function createKernelCompletionExtension(client: NotebookClient | null): Extension {
  return autocompletion({
    override: [createKernelCompletionSource(client)],
    activateOnTyping: false,
  });
}

export function useKernelCompletionExtension(): Extension {
  const host = useNotebookHost();
  const client = useMemo(() => new NotebookClient({ transport: host.transport }), [host]);
  return useMemo(() => createKernelCompletionExtension(client), [client]);
}

export const kernelCompletionExtension: Extension = createKernelCompletionExtension(null);
