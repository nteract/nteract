import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// A local store starts a native sync round with each connected peer: a
// request, the peer's reply, then the commits it asked for. One Automerge
// change per keystroke made that three frames per character. The backend
// gains an optional `scheduleLocalSync(id, start)` hook so the application
// decides when a local store's round starts, and can group a run of stores
// into one round. `start` is the existing coalescing scheduleSync, so a round
// already in flight still absorbs it, and it is a no-op after close, delete or
// a stopped generation. Durability is unchanged: the store has persisted
// before the hook runs. Reconnect replay and session opens still start their
// rounds at once. Without the hook, behavior is exactly the previous one.
// The TypeScript below uses no template literals.

export function patchOutboundSync(root) {
  const path = "packages/automerge-repo-subduction/src/index.ts";
  const expected = "112a57f36a78db48b7b520a2a24e312ba022e1d380ab9011352a221dbd3cc2d1";
  let source = readFileSync(`${root}/${path}`, "utf8");
  const before = createHash("sha256").update(source).digest("hex");
  if (before !== expected) throw Error(`Unexpected outbound sync source hash: ${path}`);
  const replacements = [
    [
      `  policy?: N.Policy
  ephemeralPolicy?: N.EphemeralPolicy
  /** Native request deadline`,
      `  policy?: N.Policy
  ephemeralPolicy?: N.EphemeralPolicy
  /** When a local store's sync round starts. \`start\` begins it, coalescing
   * with a round already queued, and does nothing once the backend closed,
   * the tree is being deleted or its connection generation stopped. Without
   * this hook a round starts right after each store. */
  scheduleLocalSync?: (id: SedimentreeId, start: () => void) => void
  /** Native request deadline`,
    ],
    [
      `Omit<SubductionBackendOptions, "signer" | "storage" | "policy" | "ephemeralPolicy">`,
      `Omit<SubductionBackendOptions, "signer" | "storage" | "policy" | "ephemeralPolicy" | "scheduleLocalSync">`,
    ],
    [
      `  private readonly ephemeralPolicy?: N.EphemeralPolicy
`,
      `  private readonly ephemeralPolicy?: N.EphemeralPolicy
  private readonly scheduleLocalSync?: SubductionBackendOptions["scheduleLocalSync"]
`,
    ],
    [
      `    this.ephemeralPolicy = options.ephemeralPolicy
`,
      `    this.ephemeralPolicy = options.ephemeralPolicy
    this.scheduleLocalSync = options.scheduleLocalSync
`,
    ],
    [
      `  private scheduleSync(id: SedimentreeId): void {
`,
      `  /** A local store's sync round, started when scheduleLocalSync says. A
   * hook that throws falls back to starting it now. */
  private localSync(id: SedimentreeId): void {
    const schedule = this.scheduleLocalSync
    if (!schedule) return this.scheduleSync(id)
    try {
      schedule(id, () => this.scheduleSync(id))
    } catch {
      this.scheduleSync(id)
    }
  }
  private scheduleSync(id: SedimentreeId): void {
`,
    ],
    [
      `          if (records.length) this.scheduleSync(id)
`,
      `          if (records.length) this.localSync(id)
`,
    ],
  ];
  for (const [needle, replacement] of replacements) {
    if (source.split(needle).length !== 2) throw Error(`Outbound sync patch mismatch: ${needle}`);
    source = source.replace(needle, replacement);
  }
  writeFileSync(`${root}/${path}`, source);
  return { path, before, after: createHash("sha256").update(source).digest("hex") };
}
