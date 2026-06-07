import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  enableExecutionPerformanceTracing,
  ensureCodeCell,
  executeCell,
  getExecutionPerformanceSnapshot,
  markExecutionPerformance,
  openNotebookRoom,
  resetExecutionPerformanceTracing,
  setCellSource,
  waitForKernelStatus,
  waitForOutputContaining,
  type ExecutionPerformanceSnapshot,
  type ExecutionPerformanceTrace,
} from "./helpers";

function formatTrace(trace: ExecutionPerformanceTrace) {
  const first = trace.marks[0]?.t ?? trace.startedAt;
  return trace.marks.map((mark) => ({
    phase: mark.name,
    ms: Math.round((mark.t - first) * 10) / 10,
    cellId: mark.cellId,
    executionId: mark.executionId,
    outputId: mark.outputId,
    detail: mark.detail,
  }));
}

function latestTrace(snapshot: ExecutionPerformanceSnapshot): ExecutionPerformanceTrace {
  const trace = snapshot.traces.at(-1);
  if (!trace) {
    throw new Error(`No execution performance traces found: ${JSON.stringify(snapshot)}`);
  }
  return trace;
}

test.describe("browser execution performance tracing", () => {
  test("captures local execute latency phases from click to visible output", async ({
    page,
  }, testInfo) => {
    await enableExecutionPerformanceTracing(page);

    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    const cell = await ensureCodeCell(page);
    const marker = `execution performance ${crypto.randomUUID()}`;
    await setCellSource(cell, `print(${JSON.stringify(marker)})`);

    await resetExecutionPerformanceTracing(page);
    await executeCell(cell);
    await waitForOutputContaining(cell, marker, 60_000);
    await markExecutionPerformance(page, "playwright.output.visible");

    const snapshot = await getExecutionPerformanceSnapshot(page);
    const trace = latestTrace(snapshot);
    const formatted = formatTrace(trace);
    const artifact = JSON.stringify({ notebookId, trace: formatted, snapshot }, null, 2);
    const artifactPath = testInfo.outputPath("execution-performance.json");

    await writeFile(artifactPath, artifact);
    await testInfo.attach("execution-performance.json", {
      path: artifactPath,
      contentType: "application/json",
    });
    console.info(`[execution-performance]\n${JSON.stringify(formatted, null, 2)}`);

    const phases = new Set(trace.marks.map((mark) => mark.name));
    expect(phases).toContain("app.execute.invoke");
    expect(phases).toContain("sync.required_heads.captured");
    expect(phases).toContain("sync.flush.dispatched.start");
    expect(phases).toContain("client.execute.request.start");
    expect(phases).toContain("client.execute.response");
    expect(phases).toContain("playwright.output.visible");

    const response = trace.marks.find((mark) => mark.name === "client.execute.response");
    expect(response?.detail?.result).toBe("cell_queued");
  });
});
