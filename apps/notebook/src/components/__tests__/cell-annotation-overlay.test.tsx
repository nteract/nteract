/**
 * Tests for CellAnnotationOverlay component.
 *
 * - Each known `kind` renders the correct label
 * - Unknown `kind` renders with fallback (no crash, uses kind as label)
 * - Message is rendered verbatim
 * - "Show details" button is absent when details is undefined
 * - "Show details" toggles a <pre> block containing JSON details
 * - Component renders with role="note"
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type { CellAnnotation } from "runtimed";
import { CellAnnotationOverlay } from "../CellAnnotationOverlay";

const KNOWN_KINDS: Array<{ kind: string; expectedLabel: string }> = [
  { kind: "sandbox_domain_blocked", expectedLabel: "Domain blocked" },
  { kind: "sandbox_credential_missing", expectedLabel: "Credential missing" },
  { kind: "sandbox_credential_rejected", expectedLabel: "Credential rejected by upstream" },
  { kind: "sandbox_proxy_degraded", expectedLabel: "Sandbox proxy stopped" },
  { kind: "sandbox_startup_failed", expectedLabel: "Sandbox failed to start" },
];

describe("CellAnnotationOverlay", () => {
  for (const { kind, expectedLabel } of KNOWN_KINDS) {
    it(`renders correct label for kind="${kind}"`, () => {
      const annotation: CellAnnotation = {
        kind,
        message: `Test message for ${kind}`,
      };
      render(<CellAnnotationOverlay annotation={annotation} />);
      expect(screen.getByText(expectedLabel)).toBeDefined();
      expect(screen.getByText(annotation.message)).toBeDefined();
    });
  }

  it("renders fallback for unknown kind without crashing", () => {
    const annotation: CellAnnotation = {
      kind: "sandbox_future_unknown_event",
      message: "Something happened.",
    };
    render(<CellAnnotationOverlay annotation={annotation} />);
    // The kind string itself becomes the label
    expect(screen.getByText("sandbox_future_unknown_event")).toBeDefined();
    expect(screen.getByText("Something happened.")).toBeDefined();
  });

  it("has role=note for accessibility", () => {
    const annotation: CellAnnotation = {
      kind: "sandbox_domain_blocked",
      message: "Blocked.",
    };
    render(<CellAnnotationOverlay annotation={annotation} />);
    expect(screen.getByRole("note")).toBeDefined();
  });

  it("does not show 'Show details' button when details is absent", () => {
    const annotation: CellAnnotation = {
      kind: "sandbox_domain_blocked",
      message: "Blocked.",
    };
    render(<CellAnnotationOverlay annotation={annotation} />);
    expect(screen.queryByText(/Show details/i)).toBeNull();
  });

  it("shows and expands details when details is present", () => {
    const details = { host: "api.example.com", port: 443 };
    const annotation: CellAnnotation = {
      kind: "sandbox_domain_blocked",
      message: "Blocked.",
      details,
    };
    render(<CellAnnotationOverlay annotation={annotation} />);

    const btn = screen.getByRole("button", { name: /Show details/i });
    expect(btn).toBeDefined();

    // Expand
    fireEvent.click(btn);
    // The pre block exists after expansion
    const preEl = document.querySelector("pre");
    expect(preEl).toBeTruthy();
    expect(preEl?.textContent).toContain('"host": "api.example.com"');

    // Collapse
    fireEvent.click(screen.getByRole("button", { name: /Hide details/i }));
    expect(document.querySelector("pre")).toBeNull();
  });
});
