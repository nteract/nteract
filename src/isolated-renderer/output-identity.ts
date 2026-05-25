interface OutputIdentityPayload {
  outputId?: string;
  cellId?: string;
  outputIndex?: number;
}

interface OutputEntryIdOptions {
  fallbackIndex?: number;
  transientFallback?: boolean;
  createTransientId?: () => string;
}

function defaultTransientOutputId(): string {
  return `output-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function outputEntryIdForPayload(
  payload: OutputIdentityPayload,
  options: OutputEntryIdOptions = {},
): string {
  // Daemon-stamped output_id is the identity boundary: display_update keeps
  // the same key, while fresh execution outputs get fresh ids and remount.
  if (payload.outputId) return payload.outputId;

  const fallbackIndex = options.fallbackIndex ?? 0;
  if (payload.cellId) {
    return `${payload.cellId}-${payload.outputIndex ?? fallbackIndex}`;
  }

  if (options.transientFallback) {
    return (options.createTransientId ?? defaultTransientOutputId)();
  }

  return `output-${fallbackIndex}`;
}
