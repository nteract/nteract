export interface Env {
  NOTEBOOK_ROOMS: DurableObjectNamespace;
  OWNER_COMPUTE_INDEX?: DurableObjectNamespace;
  WORKSTATION_EVENTS?: DurableObjectNamespace;
  DB?: D1Database;
  NOTEBOOK_SNAPSHOTS?: R2Bucket;
  ASSETS?: WorkerAssets;
  DEPLOYMENT_ENV?: string;
  NOTEBOOK_CLOUD_BUILD_SHA?: string;
  NOTEBOOK_CLOUD_ALLOWED_ORIGINS?: string;
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE?: string;
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL?: string;
  NOTEBOOK_CLOUD_APP_SESSION_SECRET?: string;
  NOTEBOOK_CLOUD_DEV_TOKEN?: string;
  NOTEBOOK_CLOUD_TRUST_LOOPBACK_HEADERS?: string;
  NOTEBOOK_CLOUD_WORKSTATION_LATEST_BUILD_BASE_URL?: string;
  NOTEBOOK_CLOUD_LOCAL_OIDC?: string;
  NOTEBOOK_CLOUD_LOCAL_OIDC_DELAY_MS?: string;
  NOTEBOOK_CLOUD_LOCAL_OIDC_TTL_SECONDS?: string;
  NOTEBOOK_CLOUD_OIDC_AUDIENCE?: string;
  NOTEBOOK_CLOUD_OIDC_CLIENT_ID?: string;
  NOTEBOOK_CLOUD_OIDC_ISSUER?: string;
  NOTEBOOK_CLOUD_OIDC_JWKS_JSON?: string;
  NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE?: string;
  NOTEBOOK_CLOUD_OIDC_PROVIDER_LABEL?: string;
  NOTEBOOK_CLOUD_OIDC_REDIRECT_URI?: string;
  NOTEBOOK_CLOUD_HOST_SESSION_COOKIE_NAMES?: string;
  NOTEBOOK_CLOUD_HOST_SESSION_IDENTITY_ADAPTER?: string;
  NOTEBOOK_CLOUD_HOST_SESSION_IDENTITY_URL?: string;
  NOTEBOOK_CLOUD_HOST_SESSION_PRINCIPAL_NAMESPACE?: string;
  RENDERER_ASSETS_BASE_URL?: string;
  RUNTIMED_WASM_BASE_URL?: string;
  OUTPUT_DOCUMENT_BASE_URL?: string;
}

export interface WorkerAssets {
  fetch(request: Request): Promise<Response>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface ExportedHandler<E> {
  fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectState {
  id: DurableObjectId;
  storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
  acceptWebSocket?(socket: CloudflareWebSocket, tags?: string[]): void;
  getWebSockets?(tag?: string): CloudflareWebSocket[];
  // Optional like the other hibernation APIs: the runtime answers matching
  // text messages without waking the DO; fakes in tests need not implement
  // it (the room feature-detects before calling).
  setWebSocketAutoResponse?(pair: WebSocketRequestResponsePair): void;
}

export interface WebSocketRequestResponsePair {
  readonly request: string;
  readonly response: string;
}

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: {
    prefix?: string;
    limit?: number;
    reverse?: boolean;
  }): Promise<Map<string, T>>;
  // Alarm API (Cloudflare-provided). Optional here so the existing fake
  // storage in tests need not implement it; the runtime_peer-gone watchdog
  // feature-detects these before arming.
  setAlarm?(scheduledTime: number | Date): Promise<void>;
  getAlarm?(): Promise<number | null>;
  deleteAlarm?(): Promise<void>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<D1Result>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = unknown>(columnName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

export type D1Value = string | number | boolean | null | ArrayBuffer;

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  error?: string;
  meta: Record<string, unknown>;
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object>;
  delete(key: string): Promise<void>;
}

export interface R2Object {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  writeHttpMetadata(headers: Headers): void;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

export interface R2HTTPMetadata {
  contentType?: string;
  cacheControl?: string;
}

export type CloudflareWebSocket = WebSocket & {
  accept(): void;
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
};

export interface WebSocketPair {
  0: CloudflareWebSocket;
  1: CloudflareWebSocket;
}

declare global {
  const WebSocketPair: {
    new (): WebSocketPair;
  };
}
