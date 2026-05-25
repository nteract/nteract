interface OutputIdentityPayload {
  outputId: string;
}

export function outputEntryIdForPayload(payload: OutputIdentityPayload): string {
  // Daemon-stamped output_id is the identity boundary: display_update keeps
  // the same key, while fresh execution outputs get fresh ids and remount.
  if (!payload.outputId) {
    throw new Error("Isolated renderer payload is missing outputId");
  }
  return payload.outputId;
}
