import fs from "node:fs";
import path from "node:path";

function errorDetails(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : error;
}

/** Test-only evidence, stored outside the daemon fixture's disposable directory. */
export class NativeTestDiagnostics {
  readonly directory: string | undefined;
  private tail = "";

  constructor(artifactRoot?: string) {
    if (artifactRoot) {
      fs.mkdirSync(artifactRoot, { recursive: true });
      this.directory = fs.mkdtempSync(path.join(artifactRoot, "native-session-"));
    }
  }

  record(event: string, details: unknown) {
    if (this.directory) {
      fs.appendFileSync(
        path.join(this.directory, "events.jsonl"),
        `${JSON.stringify({ time: new Date().toISOString(), event, details })}\n`,
      );
    }
  }

  daemonOutput(chunk: Buffer) {
    this.tail = (this.tail + chunk.toString()).slice(-16000);
    if (this.directory) fs.appendFileSync(path.join(this.directory, "daemon.log"), chunk);
  }

  async step<T>(name: string, run: () => Promise<T>): Promise<T> {
    this.record("step_started", { name });
    try {
      const result = await run();
      this.record("step_completed", { name, result });
      return result;
    } catch (error) {
      this.record("step_failed", { name, error: errorDetails(error) });
      throw error;
    }
  }

  /** A failed diagnostic read must neither mask the test error nor hang cleanup. */
  async capture(name: string, read: () => Promise<unknown>, timeoutMs = 1000) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(read),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Diagnostic read timed out")), timeoutMs);
        }),
      ]);
      this.record(name, { result });
    } catch (error) {
      this.record(name, { error: errorDetails(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  failureSummary(name: string, errors: unknown): string {
    this.record("test_failed", { name, errors });
    return [
      `[native-session] Failed: ${name}`,
      this.directory ? `Full diagnostics: ${this.directory}` : "Daemon output (last 16000 chars):",
      this.tail,
    ].join("\n");
  }
}
