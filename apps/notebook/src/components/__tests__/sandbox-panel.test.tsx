/**
 * Component tests for SandboxPanel.
 *
 * Validates rendering, the enabled toggle, missing-credential indicator,
 * and inline validation error display.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";
import * as React from "react";
import { NotebookHostProvider } from "@nteract/notebook-host";
import type { CredentialMeta, NotebookHost } from "@nteract/notebook-host";

// Mock notebook-metadata module to control useSandboxProfile and setSandboxProfile
vi.mock("~/lib/notebook-metadata", () => ({
  useSandboxProfile: vi.fn(() => undefined),
  setSandboxProfile: vi.fn(async () => true),
}));

import * as notebookMetadata from "~/lib/notebook-metadata";
import { SandboxPanel } from "../SandboxPanel";

function makeMockHost(creds: CredentialMeta[] = []) {
  return {
    credentials: {
      list: vi.fn(async () => creds),
      add: vi.fn(async () => {}),
      updateValue: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
  } as unknown as NotebookHost;
}

function renderWithHost(
  ui: React.ReactElement,
  host: ReturnType<typeof makeMockHost>,
) {
  return render(
    <NotebookHostProvider host={host as never}>
      {ui}
    </NotebookHostProvider>,
  );
}

describe("SandboxPanel", () => {
  it("renders with sandbox disabled by default when no profile is set", async () => {
    const host = makeMockHost();
    renderWithHost(<SandboxPanel />, host);
    expect(screen.getByRole("switch", { name: /Enable sandbox/i })).toBeTruthy();
    expect(screen.getByText(/Off/i)).toBeTruthy();
  });

  it("shows credential present indicator (green check) when credential exists", async () => {
    vi.mocked(notebookMetadata.useSandboxProfile).mockReturnValue({
      enabled: true,
      credentials: [{ name: "my_key", routes: [] }],
      allowed_domains: [],
    });
    const host = makeMockHost([{ name: "my_key", description: null }]);
    renderWithHost(<SandboxPanel />, host);

    await waitFor(() => {
      expect(
        screen.getByLabelText(/Credential present on this machine/),
      ).toBeTruthy();
    });
  });

  it("shows missing-credential indicator (red exclamation) for absent credential", async () => {
    vi.mocked(notebookMetadata.useSandboxProfile).mockReturnValue({
      enabled: true,
      credentials: [{ name: "missing_key", routes: [] }],
      allowed_domains: [],
    });
    const host = makeMockHost([]); // empty keychain
    renderWithHost(<SandboxPanel />, host);

    await waitFor(() => {
      expect(
        screen.getByLabelText(/Credential missing on this machine/),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: /Add credential/i })).toBeTruthy();
    });
  });

  it("shows validation errors for bad templates", async () => {
    vi.mocked(notebookMetadata.useSandboxProfile).mockReturnValue({
      enabled: true,
      credentials: [
        {
          name: "key",
          routes: [
            {
              host: "api.example.com",
              inject_as: "header",
              header: "Authorization",
              template: "Bearer TOKEN", // missing {credential}
            },
          ],
        },
      ],
      allowed_domains: [],
    });
    const host = makeMockHost([{ name: "key", description: null }]);
    renderWithHost(<SandboxPanel />, host);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByText(/\{credential\}/)).toBeTruthy();
    });
  });

  it("calls setSandboxProfile when Save profile is clicked", async () => {
    vi.mocked(notebookMetadata.useSandboxProfile).mockReturnValue({
      enabled: false,
      credentials: [],
      allowed_domains: [],
    });
    const host = makeMockHost();
    const user = userEvent.setup();
    renderWithHost(<SandboxPanel />, host);

    // Toggle sandbox on
    await user.click(screen.getByRole("switch", { name: /Enable sandbox/i }));

    await user.click(screen.getByRole("button", { name: /Save profile/i }));

    await waitFor(() => {
      expect(notebookMetadata.setSandboxProfile).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      );
    });
  });
});
