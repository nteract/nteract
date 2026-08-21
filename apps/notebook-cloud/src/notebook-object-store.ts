import type {
  R2Bucket,
  R2HTTPMetadata,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
} from "./cloudflare-types.ts";

export type NotebookObjectBodyInput =
  | ReadableStream
  | ArrayBuffer
  | ArrayBufferView
  | string
  | null;

export interface NotebookObjectHttpMetadata {
  contentType?: string;
  cacheControl?: string;
}

export interface NotebookObjectPutOptions {
  httpMetadata?: NotebookObjectHttpMetadata;
  customMetadata?: Record<string, string>;
}

export interface NotebookObject {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: NotebookObjectHttpMetadata;
  customMetadata?: Record<string, string>;
  writeHttpMetadata(headers: Headers): void;
}

export interface NotebookObjectBody extends NotebookObject {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/**
 * Durable object storage used by notebook-cloud.
 *
 * Keep this interface limited to the behavior the application needs. Signed
 * transfers belong in a future BlobTransferBroker, not in this persistence
 * contract.
 */
export interface NotebookObjectStore {
  get(key: string): Promise<NotebookObjectBody | null>;
  head(key: string): Promise<NotebookObject | null>;
  put(
    key: string,
    value: NotebookObjectBodyInput,
    options?: NotebookObjectPutOptions,
  ): Promise<NotebookObject>;
  delete(key: string): Promise<void>;
}

export class R2NotebookObjectStore implements NotebookObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  get(key: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(key);
  }

  head(key: string): Promise<R2Object | null> {
    return this.bucket.head(key);
  }

  put(
    key: string,
    value: NotebookObjectBodyInput,
    options?: NotebookObjectPutOptions,
  ): Promise<R2Object> {
    return this.bucket.put(key, value, options as R2PutOptions | undefined);
  }

  delete(key: string): Promise<void> {
    return this.bucket.delete(key);
  }
}

export interface NotebookObjectStoreEnv {
  NOTEBOOK_OBJECT_STORE?: NotebookObjectStore;
  NOTEBOOK_SNAPSHOTS?: R2Bucket;
}

export function notebookObjectStore(env: NotebookObjectStoreEnv): NotebookObjectStore | undefined {
  if (env.NOTEBOOK_OBJECT_STORE) {
    return env.NOTEBOOK_OBJECT_STORE;
  }
  if (env.NOTEBOOK_SNAPSHOTS) {
    return new R2NotebookObjectStore(env.NOTEBOOK_SNAPSHOTS);
  }
  return undefined;
}

export function writeNotebookObjectHttpMetadata(
  metadata: NotebookObjectHttpMetadata | undefined,
  headers: Headers,
): void {
  if (metadata?.contentType) {
    headers.set("Content-Type", metadata.contentType);
  }
  if (metadata?.cacheControl) {
    headers.set("Cache-Control", metadata.cacheControl);
  }
}

// Type-level checks keep the Cloudflare adapter aligned with the portable
// contract without coupling the application to the R2 names.
const _r2HttpMetadataCompatibility: NotebookObjectHttpMetadata = {} as R2HTTPMetadata;
void _r2HttpMetadataCompatibility;
