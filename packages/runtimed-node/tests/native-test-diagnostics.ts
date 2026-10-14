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
  private writeError: string | undefined;

  constructor(artifactRoot?: string) {
    if (artifactRoot) {
      try {
        fs.mkdirSync(artifactRoot, { recursive: true });
        this.directory = fs.mkdtempSync(path.join(artifactRoot, "native-session-"));
      } catch (error) {
        this.reportWriteError(error);
      }
    }
  }

  private reportWriteError(error: unknown) {
    if (this.writeError) return;
    this.writeError = String(error);
    console.warn(`[native-session] Unable to persist diagnostics: ${this.writeError}`);
  }

  record(event: string, details: unknown) {
    try {
      if (this.directory) {
        fs.appendFileSync(
          path.join(this.directory, "events.jsonl"),
          `${JSON.stringify({ time: new Date().toISOString(), event, details })}\n`,
        );
      }
    } catch (error) {
      this.reportWriteError(error);
    }
  }

  daemonOutput(chunk: Buffer) {
    this.tail = (this.tail + chunk.toString()).slice(-16000);
    try {
      if (this.directory) fs.appendFileSync(path.join(this.directory, "daemon.log"), chunk);
    } catch (error) {
      this.reportWriteError(error);
    }
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

  forTest(name: string) {
    return {
      step: <T>(stage: string, run: () => Promise<T>) => this.step(`${name}: ${stage}`, run),
      capture: (snapshot: string, read: () => Promise<unknown>) =>
        this.capture(`${name}: ${snapshot}`, read),
      bodyFailed: (error: unknown) => this.bodyFailed(name, error),
    };
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
      ...(this.writeError ? [`Artifact write error: ${this.writeError}`] : []),
      this.tail,
    ].join("\n");
  }

  bodyFailed(name: string, error: unknown) {
    this.record("test_body_failed", { name, error: errorDetails(error) });
  }
}
