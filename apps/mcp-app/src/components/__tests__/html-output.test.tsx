// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { setHostLogSink, type HostLogParams } from "../../lib/host-log";
import { HTML_OUTPUT_HEIGHT_MESSAGE, HtmlOutput } from "../html-output";

describe("HtmlOutput", () => {
  let logs: HostLogParams[];

  beforeEach(() => {
    logs = [];
    setHostLogSink({
      sendLog: (params) => {
        logs.push(params);
      },
    });
  });

  afterEach(() => {
    setHostLogSink(null);
    vi.restoreAllMocks();
  });

  it("resizes the iframe from height messages sent by its srcdoc", () => {
    render(<HtmlOutput html="<div style='height: 420px'>diagram</div>" />);

    const frame = screen.getByTitle("HTML output") as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: HTML_OUTPUT_HEIGHT_MESSAGE, height: 420 },
      }),
    );

    expect(frame.style.height).toBe("422px");
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "debug",
        data: expect.objectContaining({
          event: "html-output-iframe-resized",
          height: 422,
        }),
      }),
    );
  });

  it("ignores height messages from unrelated frames", () => {
    render(<HtmlOutput html="<div>diagram</div>" />);

    const frame = screen.getByTitle("HTML output") as HTMLIFrameElement;
    const otherFrame = document.createElement("iframe");
    document.body.appendChild(otherFrame);

    window.dispatchEvent(
      new MessageEvent("message", {
        source: otherFrame.contentWindow,
        data: { type: HTML_OUTPUT_HEIGHT_MESSAGE, height: 420 },
      }),
    );

    expect(frame.style.height).toBe("");
  });
});
