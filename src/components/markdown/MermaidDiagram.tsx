import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

const diagramStyle = {
  "--pele-bg": "var(--background)",
  "--pele-fg": "var(--foreground)",
  "--pele-muted": "var(--muted-foreground)",
  "--pele-line": "var(--foreground)",
  "--pele-surface": "var(--muted)",
  "--pele-surface-alt": "var(--secondary)",
  "--pele-border": "var(--border)",
  "--pele-accent": "var(--primary)",
  "--pele-font": "var(--output-ui-font, sans-serif)",
  "--pele-font-mono": "var(--font-mono, monospace)",
  contain: "content",
} as CSSProperties;

/** Shared by projected cells and the isolated Markdown output renderer. */
export function MermaidDiagram({ source, fallback }: { source: string; fallback: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const id = useId();
  const [result, setResult] = useState<{ source: string; error?: string } | null>(null);
  const current = result?.source === source ? result : null;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let disposed = false;
    let destroy: (() => void) | undefined;
    const onError = (error: unknown) => {
      if (!disposed) {
        setResult({
          source,
          error: error instanceof Error ? error.message : "Unable to render diagram.",
        });
      }
    };

    // Keep Pele and the SVG sanitizer out of the initial notebook bundle.
    // The isolated output build inlines this import into its on-demand Markdown plugin.
    void import("./mermaid-renderer")
      .then(({ mountMermaid }) => {
        if (disposed) return;
        const diagram = mountMermaid(element, source, id, {
          onRender: () => {
            if (!disposed) setResult({ source });
          },
          onError,
        });
        destroy = () => diagram.destroy();
      })
      .catch(onError);

    return () => {
      disposed = true;
      destroy?.();
      element.replaceChildren();
    };
  }, [source, id]);

  return (
    <div data-slot="mermaid-diagram" style={diagramStyle}>
      <div
        ref={container}
        aria-label="Mermaid diagram"
        className="relative m-3 min-w-0 overflow-hidden [font-family:var(--output-ui-font)]"
        style={{ visibility: current ? "visible" : "hidden" }}
        // Keep a measurable container while loading: Pele uses its width for layout.
        hidden={Boolean(current?.error)}
      />
      {!current && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          Rendering diagram…
        </p>
      )}
      {current?.error && (
        <p
          role="status"
          className="whitespace-pre-wrap break-words px-3 py-2 text-xs text-muted-foreground"
        >
          Diagram unavailable: {current.error}
        </p>
      )}
      {(!current || current.error) && fallback}
    </div>
  );
}
