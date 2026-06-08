/**
 * Component tests for CredentialManager.
 *
 * Uses a mock NotebookHost to verify list, add, edit, and delete flows.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";
import * as React from "react";
import { NotebookHostContext } from "@nteract/notebook-host";
import type { CredentialMeta } from "@nteract/notebook-host";
import { CredentialManager } from "../CredentialManager";

// ── Mock host ──────────────────────────────────────────────────────────────

function makeMockHost(creds: CredentialMeta[] = []) {
  const store = [...creds];
  return {
    credentials: {
      list: vi.fn(async () => [...store]),
      add: vi.fn(async (name: string, description: string | null, _value: string) => {
        store.push({ name, description });
      }),
      updateValue: vi.fn(async () => {}),
      delete: vi.fn(async (name: string) => {
        const i = store.findIndex((c) => c.name === name);
        if (i !== -1) store.splice(i, 1);
      }),
    },
  } as unknown as Parameters<typeof NotebookHostContext.Provider>[0]["value"];
}

function renderWithHost(
  ui: React.ReactElement,
  host: ReturnType<typeof makeMockHost>,
) {
  return render(
    <NotebookHostContext.Provider value={host as never}>
      {ui}
    </NotebookHostContext.Provider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("CredentialManager", () => {
  it("shows empty-state copy when no credentials exist", async () => {
    const host = makeMockHost([]);
    renderWithHost(<CredentialManager />, host);
    await waitFor(() => {
      expect(screen.getByText(/No credentials yet/)).toBeTruthy();
    });
  });

  it("lists credentials by name", async () => {
    const host = makeMockHost([
      { name: "my_key", description: "Test key" },
      { name: "other_token", description: null },
    ]);
    renderWithHost(<CredentialManager />, host);
    await waitFor(() => {
      expect(screen.getByText("my_key")).toBeTruthy();
      expect(screen.getByText("other_token")).toBeTruthy();
      expect(screen.getByText("Test key")).toBeTruthy();
    });
  });

  it("adds a credential via the dialog", async () => {
    const host = makeMockHost([]);
    const user = userEvent.setup();
    renderWithHost(<CredentialManager />, host);

    // Open add dialog
    await user.click(screen.getByRole("button", { name: /Add/i }));
    await screen.findByRole("dialog");

    await user.type(screen.getByLabelText(/Name/i), "new_cred");
    await user.type(screen.getByLabelText(/Secret value/i), "supersecret");
    await user.click(screen.getByRole("button", { name: /Add credential/i }));

    await waitFor(() => {
      expect(host.credentials.add).toHaveBeenCalledWith("new_cred", null, "supersecret");
    });
  });

  it("shows validation error for invalid name", async () => {
    const host = makeMockHost([]);
    const user = userEvent.setup();
    renderWithHost(<CredentialManager />, host);

    await user.click(screen.getByRole("button", { name: /Add/i }));
    await screen.findByRole("dialog");

    await user.type(screen.getByLabelText(/Name/i), "1bad");
    await user.type(screen.getByLabelText(/Secret value/i), "val");
    await user.click(screen.getByRole("button", { name: /Add credential/i }));

    await waitFor(() => {
      expect(screen.getByText(/must start with a letter/)).toBeTruthy();
    });
    expect(host.credentials.add).not.toHaveBeenCalled();
  });

  it("requires a secret value", async () => {
    const host = makeMockHost([]);
    const user = userEvent.setup();
    renderWithHost(<CredentialManager />, host);

    await user.click(screen.getByRole("button", { name: /Add/i }));
    await screen.findByRole("dialog");

    await user.type(screen.getByLabelText(/Name/i), "good_name");
    // Do NOT fill value
    await user.click(screen.getByRole("button", { name: /Add credential/i }));

    await waitFor(() => {
      expect(screen.getByText(/Secret value is required/)).toBeTruthy();
    });
  });

  it("opens edit dialog and updates the value", async () => {
    const host = makeMockHost([{ name: "my_key", description: "Test" }]);
    const user = userEvent.setup();
    renderWithHost(<CredentialManager />, host);

    await waitFor(() => screen.getByText("my_key"));

    await user.click(screen.getByRole("button", { name: /Edit my_key/i }));
    await screen.findByRole("dialog");

    // Name should be disabled
    expect(screen.getByLabelText(/Name/i)).toBeDisabled();

    await user.type(screen.getByLabelText(/New secret value/i), "newvalue");
    await user.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => {
      expect(host.credentials.updateValue).toHaveBeenCalledWith("my_key", "newvalue");
    });
  });

  it("deletes a credential after confirmation", async () => {
    const host = makeMockHost([{ name: "to_delete", description: null }]);
    const user = userEvent.setup();
    renderWithHost(<CredentialManager />, host);

    await waitFor(() => screen.getByText("to_delete"));

    await user.click(screen.getByRole("button", { name: /Delete to_delete/i }));
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: /^Delete$/i }));

    await waitFor(() => {
      expect(host.credentials.delete).toHaveBeenCalledWith("to_delete");
    });
  });

  it("pre-fills name when openAddWithName is provided", async () => {
    const host = makeMockHost([]);
    renderWithHost(
      <CredentialManager openAddWithName="prefilled_cred" />,
      host,
    );

    await screen.findByRole("dialog");
    expect((screen.getByLabelText(/Name/i) as HTMLInputElement).value).toBe("prefilled_cred");
  });
});
