// ZIP builders for the release artifact tests.
import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";

export const SHA = "a".repeat(40);
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A minimal ZIP writer. Each entry: { name, data?, method?, mode?, dosDirectory? }. */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "latin1");
    const data = Buffer.from(entry.data ?? "");
    const method = entry.method ?? (entry.name.endsWith("/") ? 0 : 8);
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.mode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((((entry.mode ?? 0) << 16) + (entry.dosDirectory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A release whose receipt certifies `files` for `sha`. */
export function releaseZip({
  sha = SHA,
  files = { "index.js": "worker", "public/index.html": "<html>", "public/chunks/a.js": "a" },
  receipt = {},
  extra = [],
  directories = true,
} = {}) {
  const certified = Object.fromEntries(
    Object.entries(files).map(([file, data]) => [file, sha256(Buffer.from(data))]),
  );
  const body = JSON.stringify({
    schema: 1,
    source_sha: sha,
    source_dirty: false,
    build_id: "0123456789ab",
    files: certified,
    ...receipt,
  });
  return makeZip([
    ...(directories ? [{ name: "public/" }, { name: "public/chunks/" }] : []),
    { name: "build-receipt.json", data: body },
    ...Object.entries(files).map(([name, data]) => ({ name, data, mode: 0o100644 })),
    ...extra,
  ]);
}
