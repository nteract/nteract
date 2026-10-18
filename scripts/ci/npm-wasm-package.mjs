import {execFileSync} from "node:child_process";
import {cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {digest, packageManifest, runtimeFiles, runtimeRoot} from "./npm-wasm-release.mjs";
import {validateWasm} from "./editor-assets-release.mjs";

export function assemble(plan, sourceRoot, artifactRoot, noticesPath, destination) {
  const read = path => readFileSync(join(sourceRoot, path));
  const receipt = JSON.parse(readFileSync(join(artifactRoot, "release-wasm.json")));
  validateWasm(receipt, plan);
  if (JSON.stringify(receipt) !== JSON.stringify(plan.wasm)) throw new Error("Retained WASM receipt differs from plan");
  const runtime = join(artifactRoot, runtimeRoot);
  const expected = [...runtimeFiles, "LICENSE", "package.json"].sort();
  if (JSON.stringify(readdirSync(runtime).sort()) !== JSON.stringify(expected)) throw new Error("Runtime output inventory changed; review package inclusion before shipping");
  for (const name of expected) {
    if (digest(readFileSync(join(runtime, name))) !== receipt.files[`${runtimeRoot}/${name}`]) throw new Error(`Retained runtime checksum mismatch: ${name}`);
  }
  const generated = JSON.parse(readFileSync(join(runtime, "package.json")));
  const source = JSON.parse(read("packages/runtimed-wasm/package.json"));
  if (generated.name !== "runtimed-wasm" || generated.version !== plan.baseVersion || generated.type !== "module" || generated.license !== source.license) throw new Error("Generated runtime/package source mismatch");
  const manifest = packageManifest(source, plan);
  const lock = read("Cargo.lock");
  const handshake = read("crates/notebook-protocol/src/connection/handshake.rs");
  const wire = read("crates/notebook-wire/src/lib.rs");
  const constant = (bytes, name) => {
    const match = new RegExp(`pub const ${name}: u8 = (\\d+);`).exec(bytes.toString());
    if (!match) throw new Error(`Protocol constant changed: ${name}`);
    return Number(match[1]);
  };
  const genesis = {};
  for (const path of ["crates/notebook-doc/src/lib.rs", "crates/runtime-doc/src/doc.rs", "crates/runtime-doc/src/comms.rs", "crates/comments-doc/src/doc.rs"]) {
    const matches = [...read(path).toString().matchAll(/include_bytes!\("\.\.\/assets\/([^"/]+\.am)"\)/g)];
    if (!matches.length) throw new Error(`Genesis declarations changed: ${path}`);
    for (const [, name] of matches) {
      const asset = `${path.split("/src/")[0]}/assets/${name}`;
      const bytes = read(asset);
      if (!readFileSync(join(runtime, "runtimed_wasm_bg.wasm")).includes(bytes)) throw new Error(`WASM lacks source genesis: ${asset}`);
      genesis[asset] = digest(bytes);
    }
  }
  const notices = readFileSync(noticesPath, "utf8");
  if (!notices.includes("runtimed-wasm") || !notices.includes("## License texts") || !notices.includes("automerge")) throw new Error("Missing runtimed WASM third-party notices");
  mkdirSync(join(destination, "lib"), {recursive: true});
  for (const file of runtimeFiles) cpSync(join(runtime, file), join(destination, "lib", file));
  cpSync(join(runtime, "LICENSE"), join(destination, "LICENSE"));
  cpSync(join(sourceRoot, "packages/runtimed-wasm/README.md"), join(destination, "README.md"));
  writeFileSync(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(destination, "lib/THIRD_PARTY_NOTICES.md"), notices.replace("The JavaScript in `lib/` is first-party; its npm\ndependencies are installed separately and carry their own licenses.", "The generated JavaScript glue accompanies these WebAssembly bindings."));
  const info = {
    schema: 1,
    release: {sourceSha: plan.sourceSha, channel: plan.channel, runId: plan.runId},
    cargoLockSha256: digest(lock),
    protocol: {wireVersion: constant(handshake, "PROTOCOL_VERSION"), minimumWireVersion: constant(wire, "MIN_PROTOCOL_VERSION"), handshakeSourceSha256: digest(handshake)},
    genesis,
    wasm: Object.fromEntries(runtimeFiles.map(file => [file, receipt.files[`${runtimeRoot}/${file}`]])),
  };
  writeFileSync(join(destination, "lib/build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [plan, source, artifact, notices, destination, packed] = process.argv.slice(2);
  assemble(JSON.parse(readFileSync(plan)), source, artifact, notices, destination);
  mkdirSync(packed, {recursive: true});
  // Pack exactly once. The sealed bytes are tested, uploaded, and reused by all
  // publisher retries. No lifecycle script, project install, or WASM compiler.
  const result = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", resolve(packed)], {cwd: destination, encoding: "utf8"}));
  if (result.length !== 1) throw new Error("Expected one npm tarball");
  cpSync(join(packed, result[0].filename), join(packed, "runtimed-wasm.tgz"));
  if (result[0].filename !== "runtimed-wasm.tgz") {
    const {unlinkSync} = await import("node:fs");
    unlinkSync(join(packed, result[0].filename));
  }
}
