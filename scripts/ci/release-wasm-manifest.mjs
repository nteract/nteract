#!/usr/bin/env node
// The release's one WASM build records identity and every retained byte.
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const roots = ['apps/notebook/src/wasm/runtimed-wasm', 'crates/sift-wasm/pkg', 'packages/sift/public/wasm', 'apps/notebook/src/renderer-plugins', 'target/xtask'];
const files = {};
function walk(path) {
  for (const name of readdirSync(path).sort()) {
    const file = join(path, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (!file.startsWith('target/xtask/') || /(?:\.fingerprint|renderer-.*\.inputs\.json)$/.test(file)) {
      files[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  }
}
for (const root of roots) walk(root);
writeFileSync('release-wasm.json', JSON.stringify({
  schema: 1, sourceSha: process.env.NTERACT_BUILD_GIT_HASH,
  channel: process.env.RUNT_BUILD_CHANNEL, version: process.env.RELEASE_VERSION,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  files,
}, null, 2) + '\n');
