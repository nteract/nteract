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

const REQUIRED_TRACE_PHASES = [
  "app.execute.invoke",
  "sync.required_heads.captured",
  "sync.flush.dispatched.start",
  "client.execute.request.start",
  "client.execute.response",
  "react.outputs.committed",
  "playwright.output.visible",
];

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

function executionTraces(snapshot: ExecutionPerformanceSnapshot): ExecutionPerformanceTrace[] {
  const traces = snapshot.traces.filter((trace) =>
    trace.marks.some((mark) => mark.name === "client.execute.request.start"),
  );
  if (traces.length === 0) {
    throw new Error(`No execution performance traces found: ${JSON.stringify(snapshot)}`);
  }
  return traces;
}

function phaseOffset(trace: ExecutionPerformanceTrace, phase: string): number | null {
  const first = trace.marks[0]?.t ?? trace.startedAt;
  const mark = trace.marks.find((candidate) => candidate.name === phase);
  return mark ? Math.round((mark.t - first) * 10) / 10 : null;
}

function summarizeTrace(trace: ExecutionPerformanceTrace, iteration: number) {
  return {
    iteration,
    traceId: trace.traceId,
    executionId: trace.marks.find((mark) => mark.executionId)?.executionId ?? null,
    requestMs: phaseOffset(trace, "client.execute.request.start"),
    responseMs: phaseOffset(trace, "client.execute.response"),
    outputAppliedMs: phaseOffset(trace, "runtime.output.applied"),
    reactOutputCommittedMs: phaseOffset(trace, "react.outputs.committed"),
    visibleMs: phaseOffset(trace, "playwright.output.visible"),
    doneMs: phaseOffset(trace, "runtime.execution.snapshot.done"),
  };
}

test.describe("browser execution performance tracing", () => {
  test("captures local execute latency phases across warm runs", async ({ page }, testInfo) => {
    await enableExecutionPerformanceTracing(page);

    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    const cell = await ensureCodeCell(page);

    await resetExecutionPerformanceTracing(page);
    const markers: string[] = [];
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const marker = `execution performance ${iteration} ${crypto.randomUUID()}`;
      markers.push(marker);
      await setCellSource(cell, `print(${JSON.stringify(marker)})`);
      await executeCell(cell);
      await waitForOutputContaining(cell, marker, 60_000);
      await markExecutionPerformance(page, "playwright.output.visible", { iteration });
      await waitForKernelStatus(page, "idle", 60_000);
    }

    const snapshot = await getExecutionPerformanceSnapshot(page);
    const traces = executionTraces(snapshot).slice(-markers.length);
    expect(traces).toHaveLength(markers.length);

    const formatted = traces.map((trace, iteration) => ({
      summary: summarizeTrace(trace, iteration),
      trace: formatTrace(trace),
    }));
    const artifact = JSON.stringify({ notebookId, markers, traces: formatted, snapshot }, null, 2);
    const artifactPath = testInfo.outputPath("execution-performance.json");

    await writeFile(artifactPath, artifact);
    await testInfo.attach("execution-performance.json", {
      path: artifactPath,
      contentType: "application/json",
    });
    console.info(`[execution-performance]\n${JSON.stringify(formatted, null, 2)}`);

    for (const trace of traces) {
      const phases = new Set(trace.marks.map((mark) => mark.name));
      for (const phase of REQUIRED_TRACE_PHASES) {
        expect(phases).toContain(phase);
      }

      const request = trace.marks.find((mark) => mark.name === "client.execute.request.start");
      expect(request?.executionId).toEqual(expect.any(String));
      expect(request?.detail?.clientGeneratedExecutionId).toBe(true);

      const response = trace.marks.find((mark) => mark.name === "client.execute.response");
      expect(response?.detail?.result).toBe("cell_queued");
      expect(response?.executionId).toBe(request?.executionId);
    }
  });
});
