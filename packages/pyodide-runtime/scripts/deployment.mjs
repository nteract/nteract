import { copyFile, cp, mkdir, readFile, readdir } from "node:fs/promises";

/** Assemble immutable machine assets without exposing the build cache layout. */
export async function assembleRuntimeAssets(destination) {
  const root = new URL("../", import.meta.url);
  await cp(new URL("dist/", root), destination, { recursive: true });
  await copyFile(new URL("runtime-lock.json", root), new URL("runtime-lock.json", destination));
  const wheels = JSON.parse(await readFile(new URL("dist/packages.json", root), "utf8"));
  await mkdir(new URL("wheels/", destination), { recursive: true });
  for (const { filename } of wheels) {
    await copyFile(
      new URL(`.scratch/packages/${filename}`, root),
      new URL(`wheels/${filename}`, destination),
    );
  }
  for (const filename of await readdir(new URL("dist/", root))) {
    if (filename.endsWith(".wasm"))
      await copyFile(new URL(`dist/${filename}`, root), new URL(`wheels/${filename}`, destination));
  }
}
