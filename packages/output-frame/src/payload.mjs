import { checkAnywidgetSpec, widgetDefinitions } from "./schema.mjs";

// Copy exactly the authorized view, never the unseen tail of a shared buffer.
// Only dedicated buffers are transferred; callers retain their data.
export function preparePayload(payload) {
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
  };
}
