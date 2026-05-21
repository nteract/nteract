import type {
  OutputBlobRef,
  OutputBlobResolver,
} from "../../../src/components/isolated/output-manifest";

export interface RelayHealth {
  relay: string;
  paths: { config: string; websocket: string };
  auth: {
    token_required: boolean;
    same_origin_required: boolean;
    token_configured: boolean;
  };
  daemon: {
    socket_path: string | null;
    socket_exists: boolean;
    version: string | null;
    is_dev_mode: boolean | null;
  };
  blobs: { port: number | null };
}

export interface RelayConfig {
  websocket_url: string;
  token: string;
  blob_port: number | null;
  daemon: {
    version: string;
    socket_path: string;
    is_dev_mode: boolean;
  } | null;
}

export async function fetchRelayHealth(): Promise<RelayHealth> {
  const response = await fetch("/__nteract_dev_relay/health", {
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`relay health returned ${response.status}`);
  }
  return (await response.json()) as RelayHealth;
}

export async function fetchRelayConfig(): Promise<RelayConfig> {
  const response = await fetch("/__nteract_dev_relay/config", {
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`relay config returned ${response.status}`);
  }
  return (await response.json()) as RelayConfig;
}

export function createRelayBlobResolver(port: number): OutputBlobResolver {
  const url = (ref: OutputBlobRef) =>
    `http://127.0.0.1:${port}/blob/${encodeURIComponent(ref.blob)}`;
  return {
    port,
    url,
    fetch(ref) {
      return fetch(url(ref));
    },
  };
}

export async function loadRelayBlobResolver(): Promise<OutputBlobResolver | null> {
  const config = await fetchRelayConfig();
  return config.blob_port === null ? null : createRelayBlobResolver(config.blob_port);
}
