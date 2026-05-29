import { describe, expect, it, vi } from "vite-plus/test";

import { findTableSource, renderTableTextForSource } from "./repl";

const ARROW_STREAM_MIME = "application/vnd.apache.arrow.stream";
const ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function outputWithData(data: Record<string, unknown>) {
  return {
    outputType: "display_data",
    dataJson: JSON.stringify(data),
  };
}

function manifestOutput(manifest: unknown) {
  return outputWithData({
    [ARROW_STREAM_MANIFEST_MIME]: {
      type: "json",
      value: manifest,
    },
  });
}

describe("pi REPL Arrow table rendering", () => {
  it("renders a regular Arrow display blob with the DataTable path", () => {
    const source = findTableSource({
      cellId: "cell-1",
      executionId: "exec-1",
      status: "done",
      success: true,
      outputs: [
        {
          outputType: "execute_result",
          blobPathsJson: JSON.stringify({ [ARROW_STREAM_MIME]: "/tmp/table.arrow" }),
        },
      ],
    });

    expect(source).toEqual({ kind: "arrow", path: "/tmp/table.arrow" });

    const text = renderTableTextForSource(
      source,
      7,
      theme,
      {
        readParquetFile: vi.fn(),
        readArrowFile: vi.fn(() => ({
          columns: ["id", "label", "score", "passed"],
          rows: [
            ["1", "alpha", "1.0000", "true"],
            ["2", "beta", "3.0000", "false"],
          ],
          totalRows: 2,
          offset: 0,
        })),
        summarizeArrowFile: vi.fn(() => ({
          numRows: 2,
          numBytes: 256,
          columns: [
            {
              name: "id",
              dataType: "int32",
              nullCount: 0,
              statsJson: '{"kind":"numeric","min":1,"max":2}',
            },
            {
              name: "label",
              dataType: "string",
              nullCount: 0,
              statsJson: '{"kind":"string","distinct_count":2,"top":[["alpha",1],["beta",1]]}',
            },
            {
              name: "score",
              dataType: "float64",
              nullCount: 0,
              statsJson: '{"kind":"numeric","min":1,"max":3}',
            },
            {
              name: "passed",
              dataType: "bool",
              nullCount: 0,
              statsJson: '{"kind":"boolean","true_count":73,"false_count":47}',
            },
          ],
        })),
      } as any,
      120,
    );

    expect(text).toContain("Out[7]:");
    expect(text).toContain("label");
    expect(text).toContain("alpha");
    expect(text).toContain("1.0..3.0");
    expect(text).toContain("│████▎  │");
    expect(text).toContain("T:73 F:47");
  });

  it("renders streamed display-update manifests as cheap skeletons while incomplete", () => {
    const readArrowChunks = vi.fn();
    const source = findTableSource(
      {
        cellId: "cell-1",
        executionId: "exec-1",
        status: "running",
        success: true,
        outputs: [
          manifestOutput({
            schema: {
              columns: [
                { name: "city", type: "string", nullable: false },
                { name: "value", type: "int64", nullable: false },
              ],
            },
            chunks: [{ index: 0, hash: "abcdef0123456789", row_count: 10 }],
            complete: false,
            summary: { total_rows: 100, included_rows: 10, sampled: false },
          }),
        ],
      },
      { resolveBlobPath: vi.fn(() => "/tmp/blobs/ab/cdef0123456789") },
    );

    expect(source).toEqual({
      kind: "arrow-manifest",
      manifest: expect.objectContaining({ complete: false }),
      chunkPaths: ["/tmp/blobs/ab/cdef0123456789"],
    });

    const text = renderTableTextForSource(
      source,
      3,
      theme,
      { readParquetFile: vi.fn(), readArrowChunks } as any,
      120,
    );

    expect(readArrowChunks).not.toHaveBeenCalled();
    expect(text).toContain("city");
    expect(text).toContain("value");
    expect(text).toContain("loading 10/100 rows × 2 columns");
  });

  it("decodes completed display-update manifests from resolved chunk paths", () => {
    const readArrowChunks = vi.fn(() => ({
      columns: ["city", "value"],
      rows: [
        ["Akron", "1"],
        ["Boise", "4"],
      ],
      totalRows: 2,
      offset: 0,
    }));
    const summarizeArrowChunks = vi.fn(() => ({
      numRows: 2,
      numBytes: 512,
      columns: [
        {
          name: "city",
          dataType: "string",
          nullCount: 0,
          statsJson: '{"kind":"string","distinct_count":2,"top":[["Akron",1],["Boise",1]]}',
        },
        {
          name: "value",
          dataType: "int64",
          nullCount: 0,
          statsJson: '{"kind":"numeric","min":1,"max":4}',
        },
      ],
    }));

    const source = findTableSource(
      {
        cellId: "cell-1",
        executionId: "exec-1",
        status: "done",
        success: true,
        outputs: [
          manifestOutput({
            schema: {
              columns: [
                { name: "city", type: "string" },
                { name: "value", type: "int64" },
              ],
            },
            chunks: [
              { index: 0, hash: "abcdef0123456789", row_count: 1 },
              { index: 1, hash: "0123456789abcdef", row_count: 1 },
            ],
            complete: true,
            summary: { total_rows: 2, included_rows: 2, sampled: false },
          }),
        ],
      },
      {
        resolveBlobPath: vi.fn((hash: string) => `/tmp/blobs/${hash.slice(0, 2)}/${hash.slice(2)}`),
      },
    );

    const text = renderTableTextForSource(
      source,
      4,
      theme,
      { readParquetFile: vi.fn(), readArrowChunks, summarizeArrowChunks } as any,
      120,
    );

    expect(readArrowChunks).toHaveBeenCalledWith(
      ["/tmp/blobs/ab/cdef0123456789", "/tmp/blobs/01/23456789abcdef"],
      0,
      40,
    );
    expect(text).toContain("Akron");
    expect(text).toContain("1.0..4.0");
  });
});
