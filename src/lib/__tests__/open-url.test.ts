import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { isSafeExternalUrl, openUrl, setOpenUrlHost } from "../open-url";

describe("external notebook links", () => {
  afterEach(() => {
    setOpenUrlHost(null);
    vi.restoreAllMocks();
  });

  it.each(["https://nteract.io/", "http://localhost:3000/", "mailto:hello@nteract.io", "tel:+15555555555"])("allows %s", (url) => {
    expect(isSafeExternalUrl(url)).toBe(true);
  });

  it.each(["javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd", "about:srcdoc#heading", "#heading", "not a URL", null, {}, 123])("rejects %s", (url) => {
    expect(isSafeExternalUrl(url)).toBe(false);
  });

  it("applies the same protocol policy before opening through the notebook host", async () => {
    const open = vi.fn(async () => {});
    setOpenUrlHost({ externalLinks: { open } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await openUrl("file:///etc/passwd");
    expect(open).not.toHaveBeenCalled();
    await openUrl(" https://nteract.io/ ");
    expect(open).toHaveBeenCalledExactlyOnceWith("https://nteract.io/");
  });
});
