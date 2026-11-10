import { readFile } from "node:fs/promises";

/** celld 0.6.1 exposes allocUnsafeSlow as a non-constructable static method.
 * cbor-x 1.6.4 invokes it with `new`. Select cbor-x's existing browser encoder
 * path only for this dependency; do not alter the Worker-wide Buffer global.
 * Remove when the qualified runtime provides Node-compatible constructability.
 */
export function celldCborPlugin() {
  return {
    name: "celld-cbor-bytes",
    setup(build) {
      build.onLoad({ filter: /[/\\]cbor-x[/\\]encode[.]js$/ }, async ({ path }) => {
        const source = await readFile(path, "utf8");
        const expected = "const hasNodeBuffer = typeof Buffer !== 'undefined'";
        if (source.split(expected).length !== 2)
          throw new Error("cbor-x allocation check changed; requalify the celld workaround");
        return { contents: source.replace(expected, "const hasNodeBuffer = false"), loader: "js" };
      });
    },
  };
}
