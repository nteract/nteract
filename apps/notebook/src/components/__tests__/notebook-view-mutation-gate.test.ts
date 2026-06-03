/**
 * Behavioral coverage for the cell-mutation gate that NotebookView applies to
 * add/delete/move and source/output-hiding affordances.
 *
 * This exercises `computeCanMutateCells` directly across the truth table rather
 * than grepping the source string, so it proves the resolved boolean — the same
 * value NotebookView feeds into every `canMutateCells ? ... : undefined` prop —
 * rather than the shape of the expression that produces it.
 */

import { describe, expect, it } from "vite-plus/test";
import type { NotebookShellCapabilities } from "@/components/notebook";
import { computeCanMutateCells } from "@/components/notebook/mutation-gate";

/** Minimal capability projection: only `canEditStructure` is consulted. */
function caps(canEditStructure: boolean): Pick<NotebookShellCapabilities, "canEditStructure"> {
  return { canEditStructure };
}

describe("computeCanMutateCells", () => {
  describe("canAcceptCellMutations is a hard gate", () => {
    it("blocks mutations when the host rejects them, even if the capability allows structure edits", () => {
      // canEditStructure=true would normally enable add/delete/move, but a host
      // that cannot accept mutations (e.g. cloud notebook with no editing host)
      // overrides it.
      expect(
        computeCanMutateCells({
          canAcceptCellMutations: false,
          capabilities: caps(true),
          readOnly: false,
        }),
      ).toBe(false);
    });

    it("blocks mutations when the host rejects them and readOnly is false with no capabilities", () => {
      expect(
        computeCanMutateCells({
          canAcceptCellMutations: false,
          capabilities: undefined,
          readOnly: false,
        }),
      ).toBe(false);
    });
  });

  describe("once the host accepts mutations, capability decides", () => {
    it("allows mutations when canEditStructure is true", () => {
      expect(
        computeCanMutateCells({
          canAcceptCellMutations: true,
          capabilities: caps(true),
          readOnly: false,
        }),
      ).toBe(true);
    });

    it("blocks mutations when canEditStructure is false (capability overrides readOnly fallback)", () => {
      // Even with readOnly=false, an explicit capability projection saying
      // structure edits are not permitted wins.
      expect(
        computeCanMutateCells({
          canAcceptCellMutations: true,
          capabilities: caps(false),
          readOnly: false,
        }),
      ).toBe(false);
    });
  });

  describe("readOnly fallback when no capability projection is supplied", () => {
    it("allows mutations when readOnly is false", () => {
      expect(
        computeCanMutateCells({
          canAcceptCellMutations: true,
          capabilities: undefined,
          readOnly: false,
        }),
      ).toBe(true);
    });

    it("blocks mutations when readOnly is true", () => {
      expect(
        computeCanMutateCells({
          canAcceptCellMutations: true,
          capabilities: undefined,
          readOnly: true,
        }),
      ).toBe(false);
    });

    it("treats null capabilities the same as undefined", () => {
      expect(
        computeCanMutateCells({
          canAcceptCellMutations: true,
          capabilities: null,
          readOnly: false,
        }),
      ).toBe(true);
    });
  });

  describe("full truth table", () => {
    // canAcceptCellMutations × canEditStructure (capability present) × readOnly
    const cases: Array<{
      accept: boolean;
      structure: boolean | "none";
      readOnly: boolean;
      expected: boolean;
    }> = [
      // Host rejects: always false regardless of anything else.
      { accept: false, structure: true, readOnly: false, expected: false },
      { accept: false, structure: false, readOnly: false, expected: false },
      { accept: false, structure: "none", readOnly: false, expected: false },
      { accept: false, structure: "none", readOnly: true, expected: false },
      // Host accepts + explicit capability: capability decides.
      { accept: true, structure: true, readOnly: false, expected: true },
      { accept: true, structure: true, readOnly: true, expected: true },
      { accept: true, structure: false, readOnly: false, expected: false },
      { accept: true, structure: false, readOnly: true, expected: false },
      // Host accepts + no capability: readOnly fallback decides.
      { accept: true, structure: "none", readOnly: false, expected: true },
      { accept: true, structure: "none", readOnly: true, expected: false },
    ];

    for (const { accept, structure, readOnly, expected } of cases) {
      it(`accept=${accept} structure=${structure} readOnly=${readOnly} → ${expected}`, () => {
        expect(
          computeCanMutateCells({
            canAcceptCellMutations: accept,
            capabilities: structure === "none" ? undefined : caps(structure),
            readOnly,
          }),
        ).toBe(expected);
      });
    }
  });
});
