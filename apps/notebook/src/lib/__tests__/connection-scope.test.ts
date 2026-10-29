import { describe, expect, it } from "vite-plus/test";
import { connectionScopeAllowsNotebookWrite } from "../connection-scope";

describe("connectionScopeAllowsNotebookWrite", () => {
  it("lets an unscoped local connection, editors and owners write", () => {
    expect(connectionScopeAllowsNotebookWrite(null)).toBe(true);
    expect(connectionScopeAllowsNotebookWrite("editor")).toBe(true);
    expect(connectionScopeAllowsNotebookWrite("owner")).toBe(true);
  });

  it("refuses viewers, runtime peers and unknown scopes", () => {
    expect(connectionScopeAllowsNotebookWrite("viewer")).toBe(false);
    expect(connectionScopeAllowsNotebookWrite("runtime_peer")).toBe(false);
    expect(connectionScopeAllowsNotebookWrite("admin")).toBe(false);
    expect(connectionScopeAllowsNotebookWrite("")).toBe(false);
  });
});
