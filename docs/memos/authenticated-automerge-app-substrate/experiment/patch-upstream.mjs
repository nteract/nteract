import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { patchStorageIndex } from "./patch-storage-index.mjs";
import { patchSnapshotStore } from "./patch-snapshot-store.mjs";
import { patchAdmission } from "./patch-admission.mjs";
import { patchRecordCodec } from "./patch-record-codec.mjs";
import { patchCompaction } from "./patch-compaction.mjs";
import { patchCausalHistory } from "./patch-causal-history.mjs";

// Source-hash-checked alterations to pinned Repo3. No wire or WASM changes.
export function patchUpstream(root) {
  const path = `${root}/packages/automerge-repo-subduction/src/index.ts`;
  let source = readFileSync(path, "utf8");
  const before = createHash("sha256").update(source).digest("hex");
  if (before !== "1a870be50a4a447a91038034cb5ec227568b34afc844d4f5e19d787fd58a0bd3")
    throw new Error("Unexpected upstream backend source hash");
  const replacements = [
    [
      "  storage: LocalByteStore\n",
      "  storage: LocalByteStore\n  /** Spike: forward existing native authorization interfaces. */\n  policy?: N.Policy\n  ephemeralPolicy?: N.EphemeralPolicy\n",
    ],
    [
      'Omit<SubductionBackendOptions, "signer" | "storage">',
      'Omit<SubductionBackendOptions, "signer" | "storage" | "policy" | "ephemeralPolicy">',
    ],
    [
      "  private readonly signer: NativeSigner\n",
      "  private readonly signer: NativeSigner\n  private readonly policy?: N.Policy\n  private readonly ephemeralPolicy?: N.EphemeralPolicy\n",
    ],
    [
      "    this.signer = options.signer\n",
      "    this.signer = options.signer\n    this.policy = options.policy\n    this.ephemeralPolicy = options.ephemeralPolicy\n",
    ],
    [
      "      signer: this.signer,\n      storage,",
      "      signer: this.signer,\n      policy: this.policy,\n      ephemeralPolicy: this.ephemeralPolicy,\n      storage,",
    ],
  ];
  for (const [needle, replacement] of replacements) {
    if (source.split(needle).length !== 2) throw new Error(`Patch mismatch: ${needle}`);
    source = source.replace(needle, replacement);
  }
  source = patchSnapshotStore(source);
  writeFileSync(path, source);
  const storageIndex = patchStorageIndex(root);
  const admission = patchAdmission(root);
  const compaction = patchCompaction(root);
  const recordCodec = patchRecordCodec(root);
  const causalHistory = patchCausalHistory(root);
  const after = createHash("sha256").update(readFileSync(path)).digest("hex");
  return {
    path: "packages/automerge-repo-subduction/src/index.ts",
    before,
    after,
    storageIndex,
    admission,
    compaction,
    recordCodec,
    causalHistory,
  };
}
