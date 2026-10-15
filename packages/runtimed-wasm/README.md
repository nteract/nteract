# @runtimed/wasm

The generated ESM WebAssembly bindings for runtimed notebook documents and room
state. This package carries the matching JavaScript, binary, and TypeScript
declarations from one retained release build. It has no npm dependencies.

Initialize once before constructing handles. Free handles when their owner is
finished with them. The generated declarations describe the complete API.

The declarations include `Symbol.dispose`. If your TypeScript library types do
not include it, add `ESNext.Disposable` (TypeScript 5.2 or newer) to
`compilerOptions.lib` alongside your usual libraries (for example,
`["ES2022", "DOM", "ESNext.Disposable"]`). This also applies when `lib` is unset
and your `target` selects older library types.

```js
import init, { NotebookHandle } from "@runtimed/wasm";

// A browser server must serve the matching .wasm beside the generated module,
// or pass an explicit URL emitted by your bundler.
await init({ module_or_path: new URL("/assets/runtimed_wasm_bg.wasm", location.href) });
const notebook = NotebookHandle.create_bootstrap("example-client");
try {
  console.log(JSON.parse(notebook.get_cells_json()));
} finally {
  notebook.free();
}
```

With a bundler that supports asset URL imports, use
`@runtimed/wasm/runtimed_wasm_bg.wasm?url` and pass that URL to `init`.
Plain browser ESM may call `await init()` when the generated module and its
binary are served together. Serve the binary as `application/wasm`.

Node's fetch does not load `file:` URLs. Read the exported binary and pass its
bytes explicitly (Node 22 or newer):

```js
import { readFile } from "node:fs/promises";
import { initSync, NotebookHandle } from "@runtimed/wasm";

const bytes = await readFile(new URL(import.meta.resolve("@runtimed/wasm/runtimed_wasm_bg.wasm")));
initSync({ module: bytes });
const notebook = NotebookHandle.create_bootstrap("node-client");
notebook.free();
```

The async initializer also accepts bytes or a compiled `WebAssembly.Module` as
`module_or_path`. This package does not connect to a daemon, start a kernel, or
provide the private `runtimed` TypeScript stores. Existing desktop and cloud
imports remain unchanged.

Pin an exact version and keep your lockfile. Stable releases use the checked-in
package version; nightly releases use `<version>-nightly.<release run ID>`.
`@runtimed/wasm/build-info.json` records source SHA, release identity, WASM
checksums, protocol source constants, and Automerge genesis hashes. Those facts
describe the build; matching package versions alone do not establish daemon or
host compatibility. Qualify the document, protocol, and host contracts you use.

`LICENSE` covers first-party code. `lib/THIRD_PARTY_NOTICES.md` contains the
licenses and notices of the Rust dependencies compiled into the module.
See the repository's [npm publishing runbook](../../docs/runbooks/npm-publishing.md)
for the retained-artifact workflow and the disabled-by-default bootstrap gate.
