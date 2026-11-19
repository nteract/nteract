import { checkAnywidgetSpec, widgetDefinitions } from "./schema.mjs";

/** The most libraries one mount's map may name. */
export const MAX_LIBRARIES = 64;
/** The most catalog modules one mount's integrity map may name: the
 * libraries and the chunks they share. */
export const MAX_LIBRARY_FILES = 256;
// A bare specifier a view imports a library by: an optionally scoped package
// name and optional subpath, such as "d3" or "@scope/name/sub".
const LIBRARY_NAME =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;
const LIBRARY_PATH = /^\/catalog\/([a-f0-9]{64})\/[\w-]+\.js$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// A sha256 integrity value, as an import map's `integrity` takes it.
const SHA256_INTEGRITY = /^sha256-[A-Za-z0-9+/]{43}=$/;

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);

/** The catalog revision of `value`, a module URL in the embedder's catalog:
 * `<origin>/catalog/<revision>/<file>.js`, exactly as written, over https or
 * over http on a loopback host. Throws, naming `label`, otherwise. */
function catalogRevision(value, origin, label) {
  let url;
  try {
    if (typeof value !== "string") throw Error();
    url = new URL(value);
  } catch {
    throw Error(`${label} needs an absolute URL.`);
  }
  const path = LIBRARY_PATH.exec(url.pathname);
  if (
    url.href !== value ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    !path ||
    url.search ||
    url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))
  )
    throw Error(
      `${label} must be a module in the page's catalog: ${origin}/catalog/<revision>/<file>.js over https.`,
    );
  return path[1];
}

/**
 * A view's library map, checked: `libraries`, bare name → absolute URL of
 * the module, and `integrity`, module URL → its sha256 integrity value. The
 * embedder serves its library catalog on its own origin, so every URL is
 * `<origin>/catalog/<revision>/<file>.js` with the embedding document's
 * `origin` and one revision for both maps, over https, or over http only on a
 * loopback host. At most MAX_LIBRARIES names and MAX_LIBRARY_FILES integrity
 * entries; integrity needs libraries. Returns copies, each undefined when
 * empty.
 */
export function checkLibraries(libraries, origin, integrity) {
  if (libraries === undefined && integrity === undefined)
    return { libraries: undefined, integrity: undefined };
  if (!isRecord(libraries)) throw Error("A library map is an object of names to URLs.");
  const entries = Object.entries(libraries);
  if (entries.length > MAX_LIBRARIES)
    throw Error(`A view's library map names at most ${MAX_LIBRARIES} libraries.`);
  let revision;
  const same = (next) => {
    if ((revision ??= next) !== next)
      throw Error("A view's libraries come from one catalog revision.");
  };
  const checked = {};
  for (const [name, value] of entries) {
    if (!LIBRARY_NAME.test(name) || name.length > 200 || name in Object.prototype)
      throw Error("A library is named by a bare specifier.");
    same(catalogRevision(value, origin, `Library ${name}`));
    checked[name] = value;
  }
  let hashes;
  if (integrity !== undefined) {
    if (!isRecord(integrity) || !entries.length)
      throw Error("Library integrity is an object of library module URLs to sha256 values.");
    const listed = Object.entries(integrity);
    if (listed.length > MAX_LIBRARY_FILES)
      throw Error(`A view's library integrity names at most ${MAX_LIBRARY_FILES} modules.`);
    hashes = {};
    for (const [url, value] of listed) {
      same(catalogRevision(url, origin, "A library integrity entry"));
      if (typeof value !== "string" || !SHA256_INTEGRITY.test(value))
        throw Error("A library integrity value is sha256-<base64>.");
      hashes[url] = value;
    }
  }
  return {
    libraries: entries.length ? checked : undefined,
    integrity: hashes && Object.keys(hashes).length ? hashes : undefined,
  };
}

// Copy exactly the authorized view, never the unseen tail of a shared buffer.
// Only dedicated buffers are transferred; callers retain their data.
// `origin` is the embedding document's origin, the one origin a library map
// may name (checkLibraries).
export function preparePayload(payload, { origin } = {}) {
  const module = payload.kind === "module";
  const checked = module ? { ok: true, names: ["entry"] } : checkAnywidgetSpec(payload.spec);
  if (!checked.ok) throw Error(checked.error);
  const inputs = payload.assets ?? {};
  if (
    Object.keys(inputs).length !== checked.names.length ||
    checked.names.some((name) => !Object.hasOwn(inputs, name))
  )
    throw Error("Provide exactly the assets named by the widget spec.");
  let total = 0;
  function copy(input) {
    if (!(input?.bytes instanceof Uint8Array) || input.bytes.length > 5 * 1024 * 1024)
      throw Error("Widget assets require Uint8Array bytes, at most 5 MiB each.");
    total += input.bytes.length;
    if (total > 32 * 1024 * 1024) throw Error("Widget assets exceed 32 MiB.");
    return {
      bytes: new Uint8Array(input.bytes),
      mediaType: input.mediaType,
      assetId: input.assetId,
    };
  }
  const assets = Object.fromEntries(checked.names.map((name) => [name, copy(inputs[name])]));
  const entries = Object.entries(payload.imports ?? {});
  if (entries.length > 16) throw Error("At most 16 widget module imports are supported.");
  const imports = Object.fromEntries(
    entries.map(([name, input]) => {
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
        name in Object.prototype ||
        input?.mediaType !== "text/javascript"
      )
        throw Error("Widget imports require a bare name and text/javascript.");
      return [name, copy(input)];
    }),
  );
  const { libraries, integrity } = checkLibraries(
    payload.libraries,
    origin,
    payload.libraryIntegrity,
  );
  if (module && assets.entry.mediaType !== "text/javascript")
    throw Error("Module entry requires text/javascript.");
  for (const [, definition] of module ? [] : widgetDefinitions(payload.spec)) {
    if (assets[definition._esm].mediaType !== "text/javascript")
      throw Error("_esm requires text/javascript.");
    if (definition._css && assets[definition._css].mediaType !== "text/css")
      throw Error("_css requires text/css.");
  }
  return {
    title: payload.title,
    ...(module ? { kind: "module" } : { spec: structuredClone(payload.spec) }),
    assets,
    ...(entries.length && { imports }),
    ...(libraries && { libraries }),
    ...(integrity && { libraryIntegrity: integrity }),
  };
}
