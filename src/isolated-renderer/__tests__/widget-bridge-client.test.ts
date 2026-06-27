import { describe, expect, it } from "vitest";
import { isLocalDaemonBlobUrl } from "../widget-bridge-client";

describe("isLocalDaemonBlobUrl", () => {
  it("accepts local daemon blob URLs across loopback host spellings", () => {
    expect(isLocalDaemonBlobUrl("http://127.0.0.1:48469/blob/abc123")).toBe(true);
    expect(isLocalDaemonBlobUrl("http://localhost:48469/blob/abc123")).toBe(true);
    expect(isLocalDaemonBlobUrl("http://[::1]:48469/blob/abc123")).toBe(true);
  });

  it("rejects non-blob and non-local URLs", () => {
    expect(isLocalDaemonBlobUrl("http://127.0.0.1:48469/not-blob/abc123")).toBe(false);
    expect(isLocalDaemonBlobUrl("http://127.0.0.1:48469/blob/abc123?download=1")).toBe(false);
    expect(isLocalDaemonBlobUrl("https://example.com/blob/abc123")).toBe(false);
    expect(isLocalDaemonBlobUrl("not a url")).toBe(false);
  });
});
