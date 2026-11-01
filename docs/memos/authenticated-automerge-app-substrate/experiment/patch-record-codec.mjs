import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Keep this representation change separate from history admission and indexing.
// Exact single-match source anchors fail closed when the pinned bridge changes.
export function patchRecordCodec(root) {
  const path = "packages/automerge-repo-subduction/src/storage.ts";
  let source = readFileSync(`${root}/${path}`, "utf8");
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const before = hash(source);
  const encodeStart = "    return new TextEncoder().encode(\n      JSON.stringify({\n        v: 1,";
  const encodeEnd = "        blob: hex(record.blob),\n      })\n    )";
  const readStart = "    if (value.byteLength > this.limits.maxRecordBytes * 4 + 4096)";
  const readEnd = "    const encoded = bytes(frame.signed)";
  const replaceRegion = (start, end, replacement) => {
    if (source.split(start).length !== 2 || source.split(end).length !== 2)
      throw new Error("Unexpected upstream compound-record codec source");
    const from = source.indexOf(start),
      to = source.indexOf(end, from);
    if (to < from) throw new Error("Unexpected upstream codec region order");
    source = source.slice(0, from) + replacement + source.slice(to + end.length);
  };
  replaceRegion(
    encodeStart,
    encodeEnd,
    `    return encodeRecordFrame({
      tree,
      kind: record.kind,
      key: record.kind === "commit" ? record.id : record.head,
      signed,
      signedDigest: digest(signed),
      blob: record.blob,
    }, this.limits.maxRecordBytes)`,
  );
  replaceRegion(
    readStart,
    readEnd,
    `    const frame = decodeRecordFrame(value, this.limits.maxRecordBytes)
    if (frame.tree !== tree || frame.kind !== kind || frame.key !== key)
      throw new Error("Invalid compound record version/tree/key/kind")
    const blob = frame.blob
    const encoded = frame.signed`,
  );
  source = `import { encodeRecordFrame, decodeRecordFrame } from "./record-codec.js"\n${source}`;
  const codecPath = "packages/automerge-repo-subduction/src/record-codec.ts";
  const codec = CODEC_SOURCE;
  // The package entry exports the frame reader, so hosts that observe saved
  // records (Pages' authorship) decode them with this codec, not a copy.
  const indexPath = "packages/automerge-repo-subduction/src/index.ts";
  let index = readFileSync(`${root}/${indexPath}`, "utf8");
  const indexBefore = hash(index);
  const indexAnchor = 'export { MemoryByteStore } from "./MemoryByteStore.js"\n';
  if (index.split(indexAnchor).length !== 2)
    throw new Error("Unexpected upstream backend export source");
  index = index.replace(
    indexAnchor,
    `export { decodeRecordFrame, RECORD_HEADER_BYTES } from "./record-codec.js"\n${indexAnchor}`,
  );
  writeFileSync(`${root}/${path}`, source);
  writeFileSync(`${root}/${codecPath}`, codec);
  writeFileSync(`${root}/${indexPath}`, index);
  return {
    path,
    before,
    after: hash(source),
    codec: { path: codecPath, sha256: hash(codec) },
    index: { path: indexPath, before: indexBefore, after: hash(index) },
  };
}

const CODEC_SOURCE = String.raw`/** Persisted compound-record format only; native signed/wire bytes are opaque.
 * v2: SDR, version, kind, 3 reserved bytes, two u32 lengths, tree, key,
 * signed-envelope checksum, signed envelope, blob. Integers are big endian.
 */
export const RECORD_HEADER_BYTES = 112
const MAGIC = [0x53, 0x44, 0x52, 2]
type Frame = {
  kind: "commit" | "fragment"
  tree: string
  key: string
  signedDigest: string
  signed: Uint8Array
  blob: Uint8Array
}
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
const hex = (value: Uint8Array): string =>
  Array.from(value, b => b.toString(16).padStart(2, "0")).join("")
function unhex(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})*$/.test(value))
    throw new Error("Invalid compound record hex bytes")
  return Uint8Array.from(value.match(/../g) ?? [], b => parseInt(b, 16))
}
function bounded(signed: number, blob: number, maxRecordBytes: number): void {
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1 ||
      signed < 1 || signed > 0xffffffff || blob > 0xffffffff ||
      signed + blob > maxRecordBytes)
    throw new Error("Record limit exceeded")
}

export function encodeRecordFrame(frame: Frame, maxRecordBytes: number): Uint8Array {
  const { tree, key, kind, signedDigest, signed, blob } = frame
  if (!isHash(tree) || !isHash(key) || !isHash(signedDigest) ||
      (kind !== "commit" && kind !== "fragment"))
    throw new Error("Invalid compound record metadata")
  bounded(signed.length, blob.length, maxRecordBytes)
  const result = new Uint8Array(RECORD_HEADER_BYTES + signed.length + blob.length)
  result.set(MAGIC)
  result[4] = kind === "commit" ? 0 : 1
  const view = new DataView(result.buffer)
  view.setUint32(8, signed.length)
  view.setUint32(12, blob.length)
  result.set(unhex(tree), 16)
  result.set(unhex(key), 48)
  result.set(unhex(signedDigest), 80)
  result.set(signed, RECORD_HEADER_BYTES)
  result.set(blob, RECORD_HEADER_BYTES + signed.length)
  return result
}

export function decodeRecordFrame(value: Uint8Array, maxRecordBytes: number): Frame {
  // Existing v1 records remain readable; new writes always use binary v2.
  if (value[0] === 0x7b) {
    if (value.length > maxRecordBytes * 4 + 4096)
      throw new Error("Compound record too large")
    const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value))
    const kind = frame.kind === undefined ? "commit" : frame.kind
    const key = kind === "commit" ? frame.commit : frame.head
    if (frame.v !== 1 || !isHash(frame.tree) || !isHash(key) ||
        !isHash(frame.signedDigest) ||
        (kind === "commit" ? frame.kind !== undefined || frame.head !== undefined
          : kind !== "fragment" || frame.commit !== undefined))
      throw new Error("Invalid compound record version/tree/key/kind")
    const signed = unhex(frame.signed), blob = unhex(frame.blob)
    bounded(signed.length, blob.length, maxRecordBytes)
    return { kind, tree: frame.tree, key, signedDigest: frame.signedDigest, signed, blob }
  }
  if (value.length < RECORD_HEADER_BYTES ||
      value.length > maxRecordBytes + RECORD_HEADER_BYTES)
    throw new Error("Invalid compound record length")
  if (!MAGIC.every((byte, i) => value[i] === byte) || value[4] > 1 ||
      value[5] !== 0 || value[6] !== 0 || value[7] !== 0)
    throw new Error("Invalid compound record version/kind/flags")
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
  const signedLength = view.getUint32(8), blobLength = view.getUint32(12)
  bounded(signedLength, blobLength, maxRecordBytes)
  if (RECORD_HEADER_BYTES + signedLength + blobLength !== value.length)
    throw new Error("Invalid compound record length")
  return {
    kind: value[4] === 0 ? "commit" : "fragment",
    tree: hex(value.subarray(16, 48)),
    key: hex(value.subarray(48, 80)),
    signedDigest: hex(value.subarray(80, 112)),
    // Own the returned bytes: the byte store must not retain aliases into them.
    signed: value.slice(RECORD_HEADER_BYTES, RECORD_HEADER_BYTES + signedLength),
    blob: value.slice(RECORD_HEADER_BYTES + signedLength),
  }
}
`;
