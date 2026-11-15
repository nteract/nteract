// Copy exactly the authorized view, never the unseen tail of a shared buffer.
// The caller retains its data; only these dedicated buffers are transferred.
export function preparePayload(payload) {
  const asset = (input) => {
    if (!(input?.bytes instanceof Uint8Array))
      throw Error("Output inputs require Uint8Array bytes.");
    return {
      bytes: new Uint8Array(input.bytes),
      mediaType: input.mediaType,
      assetId: input.assetId,
    };
  };
  return {
    title: payload.title,
    module: asset(payload.module),
    inputs: Object.fromEntries(
      Object.entries(payload.inputs).map(([name, input]) => [name, asset(input)]),
    ),
    state: structuredClone(payload.state ?? {}),
  };
}
