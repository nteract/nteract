/**
 * Browser-side continuation guard for hosted execution requests.
 *
 * Hosted Run / Run all / Restart and run all first wait for local document
 * sync (and sometimes a workstation attach) before they send execution intent
 * to the room. Those waits are local async continuations: once the room
 * accepts the request the queue is server-owned, but until then nothing on the
 * server knows the intent exists. Interrupt, restart, and connection teardown
 * must therefore invalidate the pending browser continuation, or the old intent
 * fires later against the replacement runtime.
 *
 * This is not a queue. A cancelled command is dropped, never replayed; the
 * user issues a fresh explicit action to run again.
 */
export interface CloudExecutionCommand {
  /** False once the live room connection that issued this command is gone. */
  isCurrent: () => boolean;
  /** Deliver local NotebookDoc changes so the room executes the synced cell. */
  flush: () => Promise<boolean>;
  /** Optional compute start/attach; `false` means the attach did not happen. */
  start?: () => Promise<boolean>;
  /** Send execution intent to the room (execute_cell / run_all_cells). */
  execute: () => Promise<unknown>;
}

export type CloudExecutionOutcome = "submitted" | "cancelled" | "sync_failed" | "start_failed";

export class CloudExecutionCommands {
  private generation = 0;

  /** Invalidate every command that has not yet sent execution intent. */
  cancelPending(): void {
    this.generation += 1;
  }

  async submit(command: CloudExecutionCommand): Promise<CloudExecutionOutcome> {
    const generation = this.generation;
    const current = () => generation === this.generation && command.isCurrent();
    if (!current()) return "cancelled";
    const delivered = await command.flush();
    if (!current()) return "cancelled";
    if (!delivered) return "sync_failed";
    if (command.start) {
      const started = await command.start();
      if (!current()) return "cancelled";
      if (!started) return "start_failed";
    }
    await command.execute();
    return "submitted";
  }
}
