#!/usr/bin/env node
import {writeFile} from "node:fs/promises";
import {pack, digest} from "./bundle.mjs";

const [directory, sha, output] = process.argv.slice(2);
if (!directory || !sha || !output) throw new Error("usage: pack.mjs EXPORT_DIR SOURCE_SHA OUTPUT");
const bytes = await pack(directory, sha);
await writeFile(output, bytes, {mode: 0o600});
console.log(JSON.stringify({sha, sha256: digest(bytes), bytes: bytes.length}));
