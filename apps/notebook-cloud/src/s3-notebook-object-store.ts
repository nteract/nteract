import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectOutput,
  type HeadObjectOutput,
  type PutObjectCommandInput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import {
  type NotebookObject,
  type NotebookObjectBody,
  type NotebookObjectBodyInput,
  type NotebookObjectPutOptions,
  type NotebookObjectStore,
  writeNotebookObjectHttpMetadata,
} from "./notebook-object-store.ts";

export interface S3NotebookObjectStoreConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  prefix?: string;
  forcePathStyle?: boolean;
}

export interface S3NotebookObjectStoreEnv {
  NOTEBOOK_CLOUD_S3_BUCKET?: string;
  NOTEBOOK_CLOUD_S3_REGION?: string;
  NOTEBOOK_CLOUD_S3_ENDPOINT?: string;
  NOTEBOOK_CLOUD_S3_PREFIX?: string;
  NOTEBOOK_CLOUD_S3_FORCE_PATH_STYLE?: string;
}

interface S3CommandClient {
  send(command: unknown): Promise<unknown>;
}

interface S3StreamingBody {
  transformToWebStream?(): ReadableStream;
}

export class S3NotebookObjectStore implements NotebookObjectStore {
  private readonly prefix: string;

  constructor(
    private readonly client: S3CommandClient,
    private readonly config: S3NotebookObjectStoreConfig,
  ) {
    if (!config.bucket.trim()) {
      throw new Error("S3 notebook object store bucket is required");
    }
    if (!config.region.trim()) {
      throw new Error("S3 notebook object store region is required");
    }
    this.prefix = normalizedPrefix(config.prefix);
  }

  async get(key: string): Promise<NotebookObjectBody | null> {
    let output: GetObjectOutput;
    try {
      output = (await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: this.storageKey(key) }),
      )) as GetObjectOutput;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
    if (!output.Body) {
      return null;
    }

    const body = output.Body as S3StreamingBody;
    if (typeof body.transformToWebStream !== "function") {
      throw new Error("S3 GetObject response body does not support transformToWebStream");
    }
    const stream = body.transformToWebStream();
    return notebookObjectBodyFromS3(key, output, stream);
  }

  async head(key: string): Promise<NotebookObject | null> {
    let output: HeadObjectOutput;
    try {
      output = (await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.storageKey(key) }),
      )) as HeadObjectOutput;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
    return notebookObjectFromS3(key, output);
  }

  async put(
    key: string,
    value: NotebookObjectBodyInput,
    options: NotebookObjectPutOptions = {},
  ): Promise<NotebookObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.storageKey(key),
        Body: s3Body(value),
        ContentType: options.httpMetadata?.contentType,
        CacheControl: options.httpMetadata?.cacheControl,
        Metadata: options.customMetadata,
      }),
    );
    const stored = await this.head(key);
    if (!stored) {
      throw new Error(`S3 object ${key} was not visible after PutObject`);
    }
    return stored;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.storageKey(key) }),
    );
  }

  private storageKey(key: string): string {
    const normalized = normalizedKey(key);
    return this.prefix ? `${this.prefix}/${normalized}` : normalized;
  }
}

export function createS3NotebookObjectStore(
  config: S3NotebookObjectStoreConfig,
  clientConfig: Omit<S3ClientConfig, "region" | "endpoint" | "forcePathStyle"> = {},
): S3NotebookObjectStore {
  const client = new S3Client({
    ...clientConfig,
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
  });
  return new S3NotebookObjectStore(client, config);
}

export function createS3NotebookObjectStoreFromEnv(
  env: S3NotebookObjectStoreEnv,
  clientConfig: Omit<S3ClientConfig, "region" | "endpoint" | "forcePathStyle"> = {},
): S3NotebookObjectStore {
  return createS3NotebookObjectStore(s3NotebookObjectStoreConfigFromEnv(env), clientConfig);
}

export function s3NotebookObjectStoreConfigFromEnv(
  env: S3NotebookObjectStoreEnv,
): S3NotebookObjectStoreConfig {
  const bucket = requiredEnv(env.NOTEBOOK_CLOUD_S3_BUCKET, "NOTEBOOK_CLOUD_S3_BUCKET");
  const region = requiredEnv(env.NOTEBOOK_CLOUD_S3_REGION, "NOTEBOOK_CLOUD_S3_REGION");
  return {
    bucket,
    region,
    endpoint: optionalEnv(env.NOTEBOOK_CLOUD_S3_ENDPOINT),
    prefix: optionalEnv(env.NOTEBOOK_CLOUD_S3_PREFIX),
    forcePathStyle: optionalBooleanEnv(
      env.NOTEBOOK_CLOUD_S3_FORCE_PATH_STYLE,
      "NOTEBOOK_CLOUD_S3_FORCE_PATH_STYLE",
    ),
  };
}

function notebookObjectBodyFromS3(
  key: string,
  output: GetObjectOutput,
  body: ReadableStream,
): NotebookObjectBody {
  const object = notebookObjectFromS3(key, output);
  return {
    ...object,
    body,
    arrayBuffer: () => new Response(body).arrayBuffer(),
    text: () => new Response(body).text(),
  };
}

function notebookObjectFromS3(
  key: string,
  output: Pick<
    HeadObjectOutput,
    | "VersionId"
    | "ContentLength"
    | "ETag"
    | "LastModified"
    | "ContentType"
    | "CacheControl"
    | "Metadata"
  >,
): NotebookObject {
  const httpEtag = output.ETag ?? '""';
  const httpMetadata = {
    contentType: output.ContentType,
    cacheControl: output.CacheControl,
  };
  return {
    key,
    version: output.VersionId ?? "",
    size: output.ContentLength ?? 0,
    etag: httpEtag.replace(/^"|"$/g, ""),
    httpEtag,
    uploaded: output.LastModified ?? new Date(0),
    httpMetadata,
    customMetadata: output.Metadata,
    writeHttpMetadata(headers: Headers): void {
      writeNotebookObjectHttpMetadata(httpMetadata, headers);
    },
  };
}

function s3Body(value: NotebookObjectBodyInput): PutObjectCommandInput["Body"] {
  if (value instanceof ReadableStream) {
    return Readable.fromWeb(value as never);
  }
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function normalizedPrefix(prefix: string | undefined): string {
  return (prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
}

function normalizedKey(key: string): string {
  const normalized = key.trim().replace(/^\/+/g, "");
  if (!normalized || normalized.split("/").includes("..")) {
    throw new Error(`Invalid notebook object key: ${key}`);
  }
  return normalized;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    candidate.name === "NoSuchKey" ||
    candidate.name === "NotFound" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function requiredEnv(value: string | undefined, name: string): string {
  const normalized = optionalEnv(value);
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function optionalEnv(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function optionalBooleanEnv(value: string | undefined, name: string): boolean | undefined {
  const normalized = optionalEnv(value)?.toLowerCase();
  if (normalized == null) {
    return undefined;
  }
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}
