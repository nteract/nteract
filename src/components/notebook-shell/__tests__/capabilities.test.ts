import { describe, expect, it } from "vite-plus/test";
import { createNotebookShellCapabilities } from "../capabilities";
import type {
  NotebookShellAccessCapabilities,
  NotebookShellAuthCapabilities,
} from "../capabilities";

const auth: NotebookShellAuthCapabilities = {
  canSignIn: false,
  canUseAuthenticatedIdentity: true,
  needsAttention: false,
};

function access(
  overrides: Partial<NotebookShellAccessCapabilities> = {},
): NotebookShellAccessCapabilities {
  return {
    level: "owner",
    source: "local",
    isPublic: false,
    actorLabel: "local:kyle/desktop:window",
    identityLabel: "Kyle",
    ...overrides,
  };
}

describe("createNotebookShellCapabilities", () => {
  it("derives edit, execute, package, and sharing capability from writable owner access", () => {
    const capabilities = createNotebookShellCapabilities({
      access: access(),
      auth,
      canMutateDocument: true,
      canExecute: true,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: true,
      canManageSharing: true,
    });

    expect(capabilities.canRead).toBe(true);
    expect(capabilities.canEditMarkdown).toBe(true);
    expect(capabilities.canEditCells).toBe(true);
    expect(capabilities.canExecute).toBe(true);
    expect(capabilities.canToggleCode).toBe(true);
    expect(capabilities.canViewPackages).toBe(true);
    expect(capabilities.canManagePackages).toBe(true);
    expect(capabilities.canManageSharing).toBe(true);
  });

  it("keeps viewer access read-only even when a host supports write affordances", () => {
    const capabilities = createNotebookShellCapabilities({
      access: access({ level: "viewer", source: "cloud" }),
      auth,
      canMutateDocument: true,
      canExecute: true,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: true,
      canManageSharing: true,
    });

    expect(capabilities.canRead).toBe(true);
    expect(capabilities.canEditMarkdown).toBe(false);
    expect(capabilities.canEditCells).toBe(false);
    expect(capabilities.canExecute).toBe(false);
    expect(capabilities.canToggleCode).toBe(true);
    expect(capabilities.canViewPackages).toBe(true);
    expect(capabilities.canManagePackages).toBe(false);
    expect(capabilities.canManageSharing).toBe(false);
  });

  it("lets hosts expose request-edit affordances independently of current write access", () => {
    const capabilities = createNotebookShellCapabilities({
      access: access({ level: "viewer", source: "cloud" }),
      auth,
      canRequestEdit: true,
    });

    expect(capabilities.canEditCells).toBe(false);
    expect(capabilities.canRequestEdit).toBe(true);
  });

  it("treats no access as fully non-readable regardless of host affordances", () => {
    const capabilities = createNotebookShellCapabilities({
      access: access({ level: "none", source: "cloud" }),
      auth,
      canMutateDocument: true,
      canExecute: true,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: true,
      canManageSharing: true,
    });

    expect(capabilities.canRead).toBe(false);
    expect(capabilities.canEditCells).toBe(false);
    expect(capabilities.canExecute).toBe(false);
    expect(capabilities.canToggleCode).toBe(false);
    expect(capabilities.canViewPackages).toBe(false);
    expect(capabilities.canManagePackages).toBe(false);
    expect(capabilities.canManageSharing).toBe(false);
  });
});
