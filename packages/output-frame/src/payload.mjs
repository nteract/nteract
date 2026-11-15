import { checkAnywidgetSpec, widgetDefinitions } from "./schema.mjs";

// Copy exactly the authorized view, never the unseen tail of a shared buffer.
// Only dedicated buffers are transferred; callers retain their data.
export function preparePayload(payload) {
  const checked = checkAnywidgetSpec(payload.spec);
  if (!checked.ok) throw Error(checked.error);
  const inputs = payload.assets ?? {};
  if (
    Object.keys(inputs).length !== checked.names.length ||
    checked.names.some((name) => !Object.hasOwn(inputs, name))
  )
    throw Error("Provide exactly the assets named by the widget spec.");
  let total = 0;
  const assets = Object.fromEntries(
    checked.names.map((name) => {
      const input = inputs[name];
      if (!(input?.bytes instanceof Uint8Array) || input.bytes.length > 5 * 1024 * 1024)
        throw Error("Widget assets require Uint8Array bytes, at most 5 MiB each.");
      total += input.bytes.length;
      if (total > 32 * 1024 * 1024) throw Error("Widget assets exceed 32 MiB.");
      return [
        name,
        { bytes: new Uint8Array(input.bytes), mediaType: input.mediaType, assetId: input.assetId },
      ];
    }),
  );
  for (const [, definition] of widgetDefinitions(payload.spec)) {
    if (assets[definition._esm].mediaType !== "text/javascript")
      throw Error("_esm requires text/javascript.");
    if (definition._css && assets[definition._css].mediaType !== "text/css")
      throw Error("_css requires text/css.");
  }
  return { title: payload.title, spec: structuredClone(payload.spec), assets };
}
