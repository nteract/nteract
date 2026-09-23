import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { startCelld } from "./local-celld.mjs";

/** Test-only loopback driver. No diagnostic routes ship in the provider. */
export async function startProviderFixture() {
  const files = {};
  for (const filename of await readdir(new URL("../dist/wheels/", import.meta.url)))
    files[`assets/__preview-python-packages/${filename}`] = await readFile(
      new URL(`../dist/wheels/${filename}`, import.meta.url),
    );
  const bundle = await build({
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
    plugins: [
      {
        name: "wasm-modules",
        setup(builder) {
          builder.onResolve({ filter: /\.wasm$/ }, async (args) => {
            const name = basename(args.path);
            files[name] = await readFile(resolve(args.resolveDir, args.path));
            return { path: `./${name}`, external: true };
          });
        },
      },
    ],
    stdin: {
      resolveDir: fileURLToPath(new URL("../dist/", import.meta.url)),
      contents: `import publicWorker, { PreviewPythonSessions as Sessions } from './provider.js'; export { PackageAssets } from './provider.js';
      export class PreviewPythonSessions extends Sessions {
        async fetch(request) {
          if(new URL(request.url).pathname === '/probe') return Response.json({ok: true});
          if(new URL(request.url).pathname === '/prewarm') return Response.json(await this.pool.prewarm());
          return super.fetch(request);
        }
      }
      export default { fetch(request, env) {
        if(new URL(request.url).pathname === '/public') return publicWorker.fetch(request);
        return env.SESSIONS.get(env.SESSIONS.idFromName('test-deployment')).fetch(request);
      }};`,
    },
  });
  return startCelld(
    { ...files, "index.js": bundle.outputFiles[0].text },
    {
      assets: { directory: "assets", binding: "ASSETS" },
      worker_loaders: [{ binding: "LOADER" }],
      durable_objects: { bindings: [{ name: "SESSIONS", class_name: "PreviewPythonSessions" }] },
      services: [
        { binding: "PACKAGES", service: "python-runtime-probe", entrypoint: "PackageAssets" },
      ],
    },
  );
}
