import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  SharingPanel,
  type SharingPrimitives,
  type SharingScopeSelectProps,
} from "../../../src/components/sharing/SharingPanel";
import type {
  CloudShareAccessProjection,
  CloudShareAccessRow,
  CloudShareInviteScope,
} from "./sharing-client";
import type { FormEvent } from "react";

export type CloudSharingAccessRequestAction = "approve" | "deny" | "dismiss";
export type CloudSharingMessageKind = "info" | "error";

export interface CloudSharingPanelProps {
  accessProjection: CloudShareAccessProjection;
  busyAction: string | null;
  compactCopyLinkLabel: string;
  copyLinkLabel: string;
  formError: string | null;
  inviteEmail: string;
  inviteReady: boolean;
  inviteScope: CloudShareInviteScope;
  message: string | null;
  messageKind: CloudSharingMessageKind;
  onCopyLink: () => void;
  onInviteEmailChange: (value: string) => void;
  onInviteScopeChange: (value: CloudShareInviteScope) => void;
  onRemoveAccessRow: (row: CloudShareAccessRow) => void;
  onResolveAccessRequest: (
    row: Extract<CloudShareAccessRow, { kind: "access_request" }>,
    action: CloudSharingAccessRequestAction,
  ) => void;
  onSubmitInvite: (event: FormEvent<HTMLFormElement>) => void;
  onTogglePublicAccess: () => void;
  publicBusy: boolean;
  publicEnabled: boolean;
  showInitialAccessLoading: boolean;
}

const primitives: SharingPrimitives = {
  Button,
  Input,
  Label,
  Separator,
  ScopeSelect: ({ id, value, onValueChange }: SharingScopeSelectProps) => (
    <Select value={value} onValueChange={(next) => onValueChange(next as CloudShareInviteScope)}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="viewer">Can view</SelectItem>
        <SelectItem value="editor">Can edit</SelectItem>
      </SelectContent>
    </Select>
  ),
};

function displayRow(row: CloudShareAccessRow) {
  const icon =
    row.kind === "acl" && row.scope === "runtime_peer"
      ? "runtime"
      : row.kind === "acl" && row.acl.subject_kind === "public"
        ? "public"
        : "person";
  return { ...row, icon } as CloudShareAccessRow & { icon: "person" | "public" | "runtime" };
}

/** Notebook adapter keeps cloud records and shadcn styling outside the shared panel. */
export function CloudSharingPanel({
  accessProjection,
  onResolveAccessRequest,
  ...props
}: CloudSharingPanelProps) {
  return (
    <SharingPanel
      {...props}
      appearance="notebook"
      primitives={primitives}
      accessProjection={{
        accessRows: accessProjection.notebookAccessRows.map(displayRow),
        accessSummary: accessProjection.notebookAccessSummary,
        accessRequestRows: accessProjection.accessRequestRows.map(displayRow),
        accessRequestSummary: accessProjection.accessRequestSummary,
        runtimeAccessRows: accessProjection.runtimeAccessRows.map(displayRow),
        runtimeAccessSummary: accessProjection.runtimeAccessSummary,
      }}
      onResolveAccessRequest={(row, action) => {
        if (row.kind === "access_request") onResolveAccessRequest(row, action);
      }}
    />
  );
}
