import { useEffect, useMemo, useState } from "react";
import type { NotebookHost } from "@nteract/notebook-host";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";

export function createOutputHostContext(
  outputDocumentUrl: string | null,
): NteractEmbedHostContextPatch | undefined {
  const documentUrl = outputDocumentUrl?.trim();
  if (!documentUrl) return undefined;
  return { nteract: { outputDocumentUrl: documentUrl } };
}

/** Keep the renderer context aligned with relay-ready blob-port changes. */
export function useOutputHostContext(
  host: NotebookHost,
): NteractEmbedHostContextPatch | undefined {
  const [outputDocumentUrl, setOutputDocumentUrl] = useState(host.outputDocumentUrl ?? null);

  useEffect(() => {
    setOutputDocumentUrl(host.outputDocumentUrl ?? null);
    return host.daemonEvents.onReady(() => {
      setOutputDocumentUrl(host.outputDocumentUrl ?? null);
    });
  }, [host]);

  return useMemo(() => createOutputHostContext(outputDocumentUrl), [outputDocumentUrl]);
}
