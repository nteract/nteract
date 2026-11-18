// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import {
  CONNECTION_SCOPES,
  allowsAclMutation,
  allowsBlobUpload,
  allowsExecutionRequestSubmit,
  allowsNotebookWrite,
  allowsPublish,
  allowsRuntimeStateWrite,
  isConnectionScope,
  parseConnectionScope,
  type ConnectionScope,
} from "../src/index";

describe("connection scope lattice", () => {
  it("lists every scope in privilege order", () => {
    expect(CONNECTION_SCOPES).toEqual(["viewer", "editor", "runtime_peer", "owner"]);
  });

  it("recognizes and parses only known scopes", () => {
    for (const scope of CONNECTION_SCOPES) {
      expect(isConnectionScope(scope)).toBe(true);
      expect(parseConnectionScope(scope)).toBe(scope);
    }
    for (const value of ["", "Owner", "admin", null, undefined]) {
      expect(isConnectionScope(value)).toBe(false);
    }
    expect(() => parseConnectionScope("admin")).toThrow("unknown connection scope: admin");
  });

  it("grants each capability to the scopes the daemon allows", () => {
    const granted = (predicate: (scope: ConnectionScope) => boolean) =>
      CONNECTION_SCOPES.filter(predicate);
    expect(granted(allowsNotebookWrite)).toEqual(["editor", "owner"]);
    expect(granted(allowsRuntimeStateWrite)).toEqual(["runtime_peer"]);
    expect(granted(allowsBlobUpload)).toEqual(["runtime_peer", "owner"]);
    expect(granted(allowsExecutionRequestSubmit)).toEqual(["owner"]);
    expect(granted(allowsPublish)).toEqual(["owner"]);
    expect(granted(allowsAclMutation)).toEqual(["owner"]);
  });
});
