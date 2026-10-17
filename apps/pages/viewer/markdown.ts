import { setMarkdownProjectionProjector } from "../../../src/lib/markdown-projection";
interface MarkdownExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  nteract_markdown_alloc(length: number): number;
  nteract_markdown_free(pointer: number, length: number): void;
  nteract_markdown_project(pointer: number, length: number): number;
  nteract_markdown_result_ptr(): number;
}
export async function initializeMarkdown(): Promise<void> {
  const response = await fetch("/markdown.wasm");
  if (!response.ok) throw new Error("Markdown renderer could not be loaded");
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
  const api = instance.exports as MarkdownExports;
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  setMarkdownProjectionProjector((source) => {
    const bytes = encoder.encode(source),
      pointer = api.nteract_markdown_alloc(bytes.length);
    try {
      new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
      const length = api.nteract_markdown_project(pointer, bytes.length);
      return decoder.decode(
        new Uint8Array(api.memory.buffer, api.nteract_markdown_result_ptr(), length),
      );
    } finally {
      api.nteract_markdown_free(pointer, bytes.length);
    }
  });
}
