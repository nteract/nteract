import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// A byte store may refuse one record: it throws, before writing anything, an
// error whose `recordRefused` is true. The bridge then rejects that save to
// native ingress and nothing else. The record index stays valid (nothing was
// written), the owner's storage-failure callback isn't called (so the native
// engine isn't reset and other connections stay up), and the attempt leaves
// the mutation ledger (so a later flush doesn't report it as a failed
// persistence). A flush already waiting on the attempt filters the refusal
// out of its results too. Any other error keeps today's failure path. Pages uses this
// for per-author admission of comment records.
export function patchRecordRefusal(root) {
  const path = "packages/automerge-repo-subduction/src/storage.ts";
  let source = readFileSync(`${root}/${path}`, "utf8");
  const before = createHash("sha256").update(source).digest("hex");
  if (before !== "c13da8f677672ba78161336729e5f9f092559d8dcfc60dacb17aa53651115e27")
    throw Error(`Unexpected record refusal source hash: ${path}`);
  const replacements = [
    [
      `export class HistoryCapacityError extends BackendError {`,
      `/** Whether a byte store refused a record: it threw, before writing
 * anything, an error whose \`recordRefused\` is true. A refusal rejects that
 * save only; it is not a storage failure. */
export function isRecordRefusal(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { recordRefused?: unknown }).recordRefused === true
  )
}

export class HistoryCapacityError extends BackendError {`,
    ],
    [
      `      } catch (cause) {
        // A failed write/remove can already have reached storage. Recovery must`,
      `      } catch (cause) {
        // A refused record wrote nothing: the index stays valid, and the owner
        // isn't told of a storage failure it would repair by resetting.
        if (isRecordRefusal(cause)) throw cause
        // A failed write/remove can already have reached storage. Recovery must`,
    ],
    [
      `    void work.then(
      () => this.attempts.delete(attempt),
      () => {
        attempt.settled = true
      }
    )`,
      `    void work.then(
      () => this.attempts.delete(attempt),
      cause => {
        // A refusal is the store's answer, not a failed persistence attempt.
        if (isRecordRefusal(cause)) this.attempts.delete(attempt)
        else attempt.settled = true
      }
    )`,
    ],
    [
      `    const errors = results.flatMap(r =>
      r.status === "rejected" ? [r.reason] : []
    )
    if (errors.length)
      throw new AggregateError(errors, "Accepted bridge mutations failed")`,
      `    // A flush that captured an attempt before its record was refused still
    // sees the refusal here: it isn't a failed mutation either.
    const errors = results.flatMap(r =>
      r.status === "rejected" && !isRecordRefusal(r.reason) ? [r.reason] : []
    )
    if (errors.length)
      throw new AggregateError(errors, "Accepted bridge mutations failed")`,
    ],
  ];
  for (const [needle, replacement] of replacements) {
    if (source.split(needle).length !== 2) throw Error(`Record refusal patch mismatch: ${needle}`);
    source = source.replace(needle, replacement);
  }
  writeFileSync(`${root}/${path}`, source);
  return [{ path, before, after: createHash("sha256").update(source).digest("hex") }];
}
