// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import * as identity from "@nteract/identity";
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
} from "@runtimed/contract/scopes";

describe("@runtimed/contract/scopes", () => {
  it("names the same scope lattice as @nteract/identity", () => {
    expect(CONNECTION_SCOPES).toBe(identity.CONNECTION_SCOPES);
    expect(allowsAclMutation).toBe(identity.allowsAclMutation);
    expect(allowsBlobUpload).toBe(identity.allowsBlobUpload);
    expect(allowsExecutionRequestSubmit).toBe(identity.allowsExecutionRequestSubmit);
    expect(allowsNotebookWrite).toBe(identity.allowsNotebookWrite);
    expect(allowsPublish).toBe(identity.allowsPublish);
    expect(allowsRuntimeStateWrite).toBe(identity.allowsRuntimeStateWrite);
    expect(isConnectionScope).toBe(identity.isConnectionScope);
    expect(parseConnectionScope).toBe(identity.parseConnectionScope);
  });

  it("lists the scopes in privilege order", () => {
    expect(CONNECTION_SCOPES).toEqual(["viewer", "editor", "runtime_peer", "owner"]);
  });
});
