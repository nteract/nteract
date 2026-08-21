export async function load(url, context, nextLoad) {
  if (!url.endsWith(".wasm")) {
    return nextLoad(url, context);
  }

  return {
    format: "module",
    shortCircuit: true,
    source: `
      import { readFile } from "node:fs/promises";
      const bytes = await readFile(new URL(${JSON.stringify(url)}));
      export default await WebAssembly.compile(bytes);
    `,
  };
}
