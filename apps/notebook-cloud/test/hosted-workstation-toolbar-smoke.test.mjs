import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isIgnorableRequestFailure,
  redactDiagnosticUrl,
} from "../scripts/hosted-workstation-toolbar-smoke.mjs";

describe("hosted workstation toolbar smoke helpers", () => {
  it("redacts credential-shaped query parameters in diagnostic URLs", () => {
    assert.equal(
      redactDiagnosticUrl(
        "https://preview.runt.run/n/demo?token=secret&next=1&access_token=another",
      ),
      "https://preview.runt.run/n/demo?token=[redacted]&next=1&access_token=[redacted]",
    );
    assert.equal(
      redactDiagnosticUrl("https://preview.runt.run/n/demo?authorization=bearer"),
      "https://preview.runt.run/n/demo?authorization=[redacted]",
    );
  });

  it("ignores expected output-frame aborts and browser side requests", () => {
    assert.equal(
      isIgnorableRequestFailure(
        "https://preview.runtusercontent.com/frame/?nteract_theme=light",
        "net::ERR_ABORTED",
      ),
      true,
    );
    assert.equal(
      isIgnorableRequestFailure("https://preview.runt.run/cdn-cgi/rum?", "net::ERR_ABORTED"),
      true,
    );
    assert.equal(
      isIgnorableRequestFailure(
        "https://preview.runtusercontent.com/frame/?nteract_theme=light",
        "net::ERR_FAILED",
      ),
      false,
    );
  });
});
