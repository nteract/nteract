import path from "node:path";

export const mermaidSource = (app) =>
  path.resolve(app, "../../../../../src/components/markdown/mermaid-renderer.ts");

// Keep the source import intact for sourceFingerprint, but serve the existing
// notebook renderer as a separate local module loaded only by Mermaid blocks.
export function browserMermaidPlugin(app) {
  const source = mermaidSource(app);
  return {
    name: "lazy-local-mermaid",
    setup(b) {
      b.onResolve({ filter: /mermaid-renderer\.ts$/ }, (args) => {
        if (path.resolve(args.resolveDir, args.path) !== source) return;
        if (args.kind !== "dynamic-import")
          throw new Error("The Mermaid renderer must remain a dynamic import");
        return { path: "/mermaid.js", external: true };
      });
    },
  };
}
