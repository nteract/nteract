import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SharingPanel, type SharingAccessRow, type SharingPanelProps } from "../SharingPanel";
import { CloudSharingPanel } from "../../../../apps/notebook-cloud/viewer/sharing-panel";
import { buildCloudShareAccessProjection } from "../../../../apps/notebook-cloud/viewer/sharing-client";

const owner: SharingAccessRow = {
  id: "owner",
  kind: "acl",
  label: "Kyle Kelley",
  detail: "kyle@example.com",
  title: "Kyle Kelley",
  badge: "Owner",
  stateLabel: null,
  stateTone: null,
  removable: false,
};
const editor: SharingAccessRow = {
  ...owner,
  id: "editor",
  label: "Owen",
  detail: "owen@example.com",
  title: "Owen",
  badge: "Can edit",
  removable: true,
};
const request: SharingAccessRow = {
  ...editor,
  id: "request",
  kind: "access_request",
  removable: false,
};
function props(): SharingPanelProps {
  return {
    accessProjection: {
      accessRows: [owner, editor],
      accessSummary: "2 people",
      accessRequestRows: [request],
      accessRequestSummary: "1 request",
      runtimeAccessRows: [],
      runtimeAccessSummary: null,
    },
    busyAction: null,
    compactCopyLinkLabel: "Copy",
    copyLinkLabel: "Copy link",
    formError: null,
    inviteEmail: "",
    inviteReady: false,
    inviteScope: "viewer",
    message: null,
    messageKind: "info",
    onCopyLink: vi.fn(),
    onInviteEmailChange: vi.fn(),
    onInviteScopeChange: vi.fn(),
    onRemoveAccessRow: vi.fn(),
    onResolveAccessRequest: vi.fn(),
    onSubmitInvite: vi.fn((event) => event.preventDefault()),
    onTogglePublicAccess: vi.fn(),
    publicBusy: false,
    publicEnabled: false,
    showInitialAccessLoading: false,
  };
}

describe("SharingPanel host boundary", () => {
  it("shows Pages controls only when backed by host capabilities and forwards native form actions", () => {
    const callbacks = props();
    const { rerender } = render(
      <SharingPanel
        {...callbacks}
        resourceLabel="page"
        description="Invite people to this page."
        sections={{ publicAccess: false, runtimeAccess: false, accessRequests: false }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Share page" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Public link access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve Owen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Kyle Kelley" })).toBeNull();
    const submit = screen.getByRole("button", { name: "Invite" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Invite by email" }), {
      target: { value: "friend@example.com" },
    });
    expect(callbacks.onInviteEmailChange).toHaveBeenCalledWith("friend@example.com");
    fireEvent.change(screen.getByRole("combobox", { name: "Access" }), {
      target: { value: "editor" },
    });
    expect(callbacks.onInviteScopeChange).toHaveBeenCalledWith("editor");
    fireEvent.click(screen.getByRole("button", { name: "Remove Owen" }));
    expect(callbacks.onRemoveAccessRow).toHaveBeenCalledWith(editor);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(callbacks.onCopyLink).toHaveBeenCalledOnce();
    rerender(<SharingPanel {...callbacks} inviteEmail="friend@example.com" inviteReady />);
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(callbacks.onSubmitInvite).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Approve Owen" }));
    expect(callbacks.onResolveAccessRequest).toHaveBeenCalledWith(request, "approve");
  });

  it("keeps labels isolated when two sharing panels are mounted", () => {
    const first = render(<SharingPanel {...props()} />);
    const second = render(<SharingPanel {...props()} resourceLabel="page" />);
    const a = within(first.container).getByRole("textbox", { name: "Invite by email" });
    const b = within(second.container).getByRole("textbox", { name: "Invite by email" });
    expect(a.id).not.toBe(b.id);
  });

  it("keeps notebook default labels, shadcn selection, public access and original records", () => {
    const acl = {
      notebook_id: "notebook",
      subject_kind: "principal" as const,
      subject: "user:anaconda:owen",
      scope: "editor" as const,
      created_at: "2026-10-23",
      updated_at: "2026-10-23",
      created_by_actor_label: "owner",
      display: {
        kind: "principal" as const,
        label: "Owen",
        principal: "user:anaconda:owen",
        email: "owen@example.com",
      },
    };
    const accessProjection = buildCloudShareAccessProjection({ acl: [acl], invites: [] });
    const remove = vi.fn();
    render(
      <CloudSharingPanel
        {...props()}
        accessProjection={accessProjection}
        onRemoveAccessRow={remove}
      />,
    );
    expect(screen.getByRole("heading", { name: "Share notebook" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Public link access" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Access" }).tagName).toBe("BUTTON");
    fireEvent.click(screen.getByRole("button", { name: "Remove Owen" }));
    expect(remove.mock.calls[0][0].acl).toEqual(acl);
  });
});
