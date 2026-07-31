import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  clearNotebookWorkstationUsageProjectionCacheForTests,
  projectNotebookWorkstationUsage,
  type NotebookWorkstationUsageSample,
} from "../src";

beforeEach(() => {
  clearNotebookWorkstationUsageProjectionCacheForTests();
});

const GIB = 1024 ** 3;

function sampleSeries(
  fractions: readonly number[],
  { memoryFractions }: { memoryFractions?: readonly number[] } = {},
): NotebookWorkstationUsageSample[] {
  const startMs = Date.parse("2026-07-30T12:00:00.000Z");
  return fractions.map((cpuFraction, index) => ({
    at: new Date(startMs + index * 30_000).toISOString(),
    cpuFraction,
    memoryBytes: memoryFractions === undefined ? null : (memoryFractions[index] ?? 0) * (16 * GIB),
  }));
}

describe("projectNotebookWorkstationUsage", () => {
  it("returns null until at least two samples describe a trend", () => {
    expect(projectNotebookWorkstationUsage({ samples: null })).toBeNull();
    expect(projectNotebookWorkstationUsage({ samples: [] })).toBeNull();
    expect(projectNotebookWorkstationUsage({ samples: sampleSeries([0.5]) })).toBeNull();
  });

  it("projects a CPU series with latest, peak, and the covered window", () => {
    const usage = projectNotebookWorkstationUsage({
      samples: sampleSeries([0.1, 0.75, 0.34]),
    });

    expect(usage).not.toBeNull();
    expect(usage!.windowLabel).toBe("last 60 s");
    expect(usage!.series).toHaveLength(1);

    const cpu = usage!.series[0]!;
    expect(cpu.id).toBe("cpu");
    expect(cpu.label).toBe("CPU");
    expect(cpu.latestLabel).toBe("34%");
    expect(cpu.peakLabel).toBe("peak 75%");
    expect(cpu.tone).toBe("neutral");
    expect(cpu.points.map((point) => point.fraction)).toEqual([0.1, 0.75, 0.34]);
    expect(cpu.points.map((point) => point.atLabel)).toEqual(["-60 s", "-30 s", "now"]);
    expect(cpu.points.map((point) => point.valueLabel)).toEqual(["10%", "75%", "34%"]);
  });

  it("adds a memory series only when total capacity is known", () => {
    const samples = sampleSeries([0.2, 0.3], { memoryFractions: [0.25, 0.5] });

    const withoutCapacity = projectNotebookWorkstationUsage({ samples });
    expect(withoutCapacity!.series.map((series) => series.id)).toEqual(["cpu"]);

    const withCapacity = projectNotebookWorkstationUsage({
      memoryBytes: 16 * GIB,
      samples,
    });
    expect(withCapacity!.series.map((series) => series.id)).toEqual(["cpu", "memory"]);

    const memory = withCapacity!.series[1]!;
    expect(memory.label).toBe("Memory");
    expect(memory.latestLabel).toBe("8 GiB");
    expect(memory.peakLabel).toBe("peak 8 GiB");
    expect(memory.points.map((point) => point.valueLabel)).toEqual(["4 GiB", "8 GiB"]);
  });

  it("drops a series with a reporting gap rather than drawing through it", () => {
    const samples = sampleSeries([0.2, 0.3], { memoryFractions: [0.25, 0.5] });
    const gapped = [{ ...samples[0]!, memoryBytes: null }, samples[1]!];

    const usage = projectNotebookWorkstationUsage({ memoryBytes: 16 * GIB, samples: gapped });

    expect(usage!.series.map((series) => series.id)).toEqual(["cpu"]);
  });

  it("returns null when no series survives", () => {
    const samples = sampleSeries([0.2, 0.3]).map((sample) => ({ ...sample, cpuFraction: null }));

    expect(projectNotebookWorkstationUsage({ samples })).toBeNull();
  });

  it("marks sustained load as attention from the latest reading", () => {
    expect(
      projectNotebookWorkstationUsage({ samples: sampleSeries([0.2, 0.95]) })!.series[0]!.tone,
    ).toBe("attention");
    // A past spike is not a current problem; the tone follows the latest value.
    expect(
      projectNotebookWorkstationUsage({ samples: sampleSeries([0.95, 0.2]) })!.series[0]!.tone,
    ).toBe("neutral");
  });

  it("clamps out-of-range fractions and ignores unparseable timestamps", () => {
    const usage = projectNotebookWorkstationUsage({
      samples: [{ at: "not-a-date", cpuFraction: 0.5 }, ...sampleSeries([-0.4, 1.6])],
    });

    expect(usage!.series[0]!.points.map((point) => point.fraction)).toEqual([0, 1]);
    expect(usage!.series[0]!.points).toHaveLength(2);
  });

  it("orders samples by time regardless of the reported order", () => {
    const ordered = sampleSeries([0.1, 0.2, 0.9]);
    const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!];

    const usage = projectNotebookWorkstationUsage({ samples: shuffled });

    expect(usage!.series[0]!.points.map((point) => point.fraction)).toEqual([0.1, 0.2, 0.9]);
    expect(usage!.series[0]!.latestLabel).toBe("90%");
  });

  it("returns the cached projection for identical inputs", () => {
    const samples = sampleSeries([0.1, 0.2]);

    expect(projectNotebookWorkstationUsage({ samples })).toBe(
      projectNotebookWorkstationUsage({ samples: [...samples] }),
    );
  });

  it("projects kernel activity as a busy/idle step series summarized by share busy", () => {
    const startMs = Date.parse("2026-07-30T12:00:00.000Z");
    // Busy for three of four samples, ending idle.
    const usage = projectNotebookWorkstationUsage({
      samples: [1, 1, 1, 0].map((activityFraction, index) => ({
        at: new Date(startMs + index * 5_000).toISOString(),
        activityFraction,
      })),
    });

    expect(usage).not.toBeNull();
    expect(usage!.series).toHaveLength(1);
    const activity = usage!.series[0]!;
    expect(activity.id).toBe("activity");
    expect(activity.label).toBe("Kernel activity");
    expect(activity.latestLabel).toBe("idle");
    expect(activity.peakLabel).toBe("75% busy");
    expect(activity.points.map((point) => point.fraction)).toEqual([1, 1, 1, 0]);
    expect(activity.points.map((point) => point.valueLabel)).toEqual([
      "busy",
      "busy",
      "busy",
      "idle",
    ]);
  });

  it("keeps a busy kernel neutral, since executing is not a warning", () => {
    const startMs = Date.parse("2026-07-30T12:00:00.000Z");
    const usage = projectNotebookWorkstationUsage({
      samples: [1, 1].map((activityFraction, index) => ({
        at: new Date(startMs + index * 5_000).toISOString(),
        activityFraction,
      })),
    });

    expect(usage!.series[0]!.latestLabel).toBe("busy");
    expect(usage!.series[0]!.tone).toBe("neutral");
  });

  it("charts activity alongside hardware series without disturbing their tone", () => {
    const startMs = Date.parse("2026-07-30T12:00:00.000Z");
    const usage = projectNotebookWorkstationUsage({
      memoryBytes: 16 * GIB,
      samples: [0, 1].map((activityFraction, index) => ({
        at: new Date(startMs + index * 5_000).toISOString(),
        activityFraction,
        cpuFraction: index === 0 ? 0.1 : 0.95,
        memoryBytes: 8 * GIB,
      })),
    });

    // Activity leads, then the hardware series in declaration order.
    expect(usage!.series.map((series) => series.id)).toEqual(["activity", "cpu", "memory"]);
    expect(usage!.series[0]!.tone).toBe("neutral");
    expect(usage!.series[1]!.tone).toBe("attention");
  });

  it("labels longer windows in minutes and hours", () => {
    const startMs = Date.parse("2026-07-30T12:00:00.000Z");
    const overFiveMinutes = [0, 300_000].map((offset) => ({
      at: new Date(startMs + offset).toISOString(),
      cpuFraction: 0.5,
    }));
    const overTwoHours = [0, 7_200_000].map((offset) => ({
      at: new Date(startMs + offset).toISOString(),
      cpuFraction: 0.5,
    }));

    expect(projectNotebookWorkstationUsage({ samples: overFiveMinutes })!.windowLabel).toBe(
      "last 5 min",
    );
    expect(projectNotebookWorkstationUsage({ samples: overTwoHours })!.windowLabel).toBe(
      "last 2 hr",
    );
  });
});
