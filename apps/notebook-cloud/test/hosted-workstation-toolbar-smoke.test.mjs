import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertToolbarWorkstationAction,
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
      isIgnorableRequestFailure("https://preview.runt.run/api/workstations", "net::ERR_ABORTED"),
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

  it("checks blocked and attach workstation toolbar action labels", () => {
    assert.doesNotThrow(() =>
      assertToolbarWorkstationAction(
        {
          label: "Set up compute",
          title: "Open workstations panel",
        },
        {
          context: "no registered workstations",
          label: "Set up compute",
          titleIncludes: ["Open workstations panel"],
        },
      ),
    );
    assert.doesNotThrow(() =>
      assertToolbarWorkstationAction(
        {
          label: "Review compute",
          title: "Open workstations panel",
        },
        {
          context: "offline default workstation",
          label: "Review compute",
          titleIncludes: ["Open workstations panel"],
        },
      ),
    );
    assert.doesNotThrow(() =>
      assertToolbarWorkstationAction(
        {
          label: "Attach compute",
          title: "Attach lab2 workstation to this notebook",
        },
        {
          context: "online default workstation",
          label: "Attach compute",
          titleIncludes: ["lab2", "workstation"],
        },
      ),
    );
  });

  it("rejects missing or mismatched workstation toolbar actions", () => {
    assert.throws(
      () =>
        assertToolbarWorkstationAction(null, {
          context: "missing setup",
          label: "Set up compute",
        }),
      /missing setup expected workstation toolbar action Set up compute/,
    );
    assert.throws(
      () =>
        assertToolbarWorkstationAction(
          { label: "Run", title: "Open workstations panel" },
          { context: "wrong label", label: "Review compute" },
        ),
      /wrong label expected workstation toolbar action Review compute, saw Run/,
    );
    assert.throws(
      () =>
        assertToolbarWorkstationAction(
          { label: "Attach compute", title: "Open workstations panel" },
          {
            context: "wrong target",
            label: "Attach compute",
            titleIncludes: ["lab2"],
          },
        ),
      /wrong target expected workstation toolbar title to include lab2/,
    );
  });
});
