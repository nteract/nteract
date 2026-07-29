"use client";

import { Share2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Eyebrow } from "@/components/surface-primitives";
import { CloudSharingPanel } from "../../notebook-cloud/viewer/sharing-panel";
import {
  buildCloudShareAccessProjection,
  type CloudNotebookAccessRequest,
  type CloudNotebookAclRow,
  type CloudNotebookInvite,
} from "../../notebook-cloud/viewer/sharing-client";

/**
 * Every reachable state of `CloudSharingControls`
 * (apps/notebook-cloud/viewer/sharing-controls.tsx), rendered through the
 * real `CloudSharingPanel` presentational component and the real
 * `buildCloudShareAccessProjection` projection — static ACL/invite/access-
 * request fixtures stand in for the hosted facts a live notebook would
 * supply. Because the panel component is shared, this page cannot drift
 * from the real markup; only the fixture data below needs updating when new
 * states are added.
 */

const NOTEBOOK_ID = "nb-fixture";

const ownerAcl: CloudNotebookAclRow = {
  notebook_id: NOTEBOOK_ID,
  subject_kind: "principal",
  subject: "user:dev:kyle",
  scope: "owner",
  created_at: "2026-06-01T12:00:00Z",
  updated_at: "2026-06-01T12:00:00Z",
  created_by_actor_label: "Kyle",
  display: {
    kind: "principal",
    label: "Kyle",
    principal: "user:dev:kyle",
    email: "kyle@notebook.local",
  },
};

const editorAcl: CloudNotebookAclRow = {
  notebook_id: NOTEBOOK_ID,
  subject_kind: "principal",
  subject: "user:dev:morgan",
  scope: "editor",
  created_at: "2026-06-02T09:00:00Z",
  updated_at: "2026-06-02T09:00:00Z",
  created_by_actor_label: "Kyle",
  display: {
    kind: "principal",
    label: "Morgan",
    principal: "user:dev:morgan",
    email: "morgan@example.com",
  },
};

const publicAcl: CloudNotebookAclRow = {
  notebook_id: NOTEBOOK_ID,
  subject_kind: "public",
  subject: "anonymous",
  scope: "viewer",
  created_at: "2026-06-03T09:00:00Z",
  updated_at: "2026-06-03T09:00:00Z",
  created_by_actor_label: "Kyle",
};

const runtimePeerAcl: CloudNotebookAclRow = {
  notebook_id: NOTEBOOK_ID,
  subject_kind: "principal",
  subject: "runtime:aurora",
  scope: "runtime_peer",
  created_at: "2026-06-04T09:00:00Z",
  updated_at: "2026-06-04T09:00:00Z",
  created_by_actor_label: "Kyle",
  display: { kind: "principal", label: "aurora", principal: "runtime:aurora", email: null },
};

const pendingInvite: CloudNotebookInvite = {
  id: "invite-jamie",
  notebook_id: NOTEBOOK_ID,
  email: "jamie@example.com",
  provider_hint: null,
  scope: "viewer",
  status: "pending",
  invited_by_actor_label: "Kyle",
  accepted_by_principal: null,
  created_at: "2026-06-05T09:00:00Z",
  expires_at: null,
  accepted_at: null,
  revoked_at: null,
  revoked_by_actor_label: null,
};

const pendingAccessRequest: CloudNotebookAccessRequest = {
  id: "request-riley",
  notebook_id: NOTEBOOK_ID,
  requester_principal: "user:dev:riley",
  scope: "editor",
  status: "pending",
  requested_by_actor_label: "riley@example.com",
  resolved_by_actor_label: null,
  created_at: "2026-06-06T09:00:00Z",
  updated_at: "2026-06-06T09:00:00Z",
  resolved_at: null,
  display: {
    kind: "principal",
    label: "riley@example.com",
    principal: "user:dev:riley",
    email: "riley@example.com",
  },
};

interface ShareScenario {
  id: string;
  title: string;
  description: string;
  publicEnabled: boolean;
  showInitialAccessLoading: boolean;
  acl: CloudNotebookAclRow[];
  invites: CloudNotebookInvite[];
  accessRequests: CloudNotebookAccessRequest[];
  message?: { kind: "info" | "error"; text: string };
  formError?: string;
}

const scenarios: readonly ShareScenario[] = [
  {
    id: "default",
    title: "Owner, public link off",
    description: "Baseline owner view: link access disabled, one collaborator, no pending items.",
    publicEnabled: false,
    showInitialAccessLoading: false,
    acl: [ownerAcl, editorAcl],
    invites: [],
    accessRequests: [],
  },
  {
    id: "public-link",
    title: "Public link enabled",
    description: "Anyone with the link can view; the public row joins current access.",
    publicEnabled: true,
    showInitialAccessLoading: false,
    acl: [ownerAcl, publicAcl],
    invites: [],
    accessRequests: [],
  },
  {
    id: "invites-and-requests",
    title: "Pending invite + edit request",
    description: "A pending email invite and an edit-access request both need attention.",
    publicEnabled: false,
    showInitialAccessLoading: false,
    acl: [ownerAcl],
    invites: [pendingInvite],
    accessRequests: [pendingAccessRequest],
  },
  {
    id: "runtime-peers",
    title: "Compute access",
    description: "A runtime peer has compute access, shown in its own ledger below people.",
    publicEnabled: false,
    showInitialAccessLoading: false,
    acl: [ownerAcl, runtimePeerAcl],
    invites: [],
    accessRequests: [],
  },
  {
    id: "loading",
    title: "Loading access",
    description: "Panel just opened; the access ledger fetch is still in flight.",
    publicEnabled: false,
    showInitialAccessLoading: true,
    acl: [],
    invites: [],
    accessRequests: [],
  },
  {
    id: "empty",
    title: "Owner only",
    description: "No collaborators, invites, or link access yet.",
    publicEnabled: false,
    showInitialAccessLoading: false,
    acl: [],
    invites: [],
    accessRequests: [],
  },
  {
    id: "error",
    title: "Load error",
    description: "The access list failed to load; the panel surfaces the host error inline.",
    publicEnabled: false,
    showInitialAccessLoading: false,
    acl: [],
    invites: [],
    accessRequests: [],
    message: { kind: "error", text: "Unable to load access list" },
  },
  {
    id: "invite-form-error",
    title: "Invalid invite email",
    description: "The invite form rejects a malformed address before it reaches the host.",
    publicEnabled: false,
    showInitialAccessLoading: false,
    acl: [ownerAcl],
    invites: [],
    accessRequests: [],
    formError: "Enter a valid email address.",
  },
  {
    id: "link-copied",
    title: "Link copied",
    description: "Copy-link confirmation message after a successful clipboard write.",
    publicEnabled: true,
    showInitialAccessLoading: false,
    acl: [ownerAcl, publicAcl],
    invites: [],
    accessRequests: [],
    message: { kind: "info", text: "Link copied." },
  },
] as const;

export function SharingSheetExample() {
  const [open, setOpen] = useState(true);

  return (
    <div className="not-prose space-y-8" data-elements-slot="sharing-sheet">
      <div className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border px-4 py-3">
          <Eyebrow>Interactive</Eyebrow>
          <h3 className="mt-1 text-sm font-semibold">Live popover</h3>
          <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
            The real Radix Popover: trigger, positioning, and focus behavior.
          </p>
        </div>
        <div className="flex min-h-[420px] items-start justify-center bg-fd-muted/30 p-6">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5" title="Share notebook">
                <Share2 className="size-3.5" aria-hidden="true" />
                <span>Share</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[min(30rem,calc(100vw-1.5rem))] max-h-[calc(100vh-5.5rem)] overflow-y-auto p-0"
              align="start"
              sideOffset={8}
            >
              <ScenarioPanel scenario={scenarios[0]!} />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/*
        One column, not a multi-column grid: the panel's own invite-form
        breakpoint (`sm:grid-cols-...` in CloudSharingPanel) is keyed off
        viewport width, matching how the real floating Popover behaves (it
        sizes off the viewport, not a parent container). A narrow grid column
        would activate that breakpoint without the width to support it.
      */}
      <div className="grid gap-6">
        {scenarios.map((scenario) => (
          <div
            key={scenario.id}
            className="overflow-hidden rounded-lg border border-fd-border bg-fd-card"
          >
            <div className="border-b border-fd-border px-4 py-3">
              <Eyebrow>{scenario.id}</Eyebrow>
              <h3 className="mt-1 text-sm font-semibold">{scenario.title}</h3>
              <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
                {scenario.description}
              </p>
            </div>
            <div className="flex items-start justify-center bg-fd-muted/30 p-6">
              <div className="w-[min(30rem,calc(100vw-1.5rem))] max-h-[calc(100vh-5.5rem)] overflow-y-auto rounded-md border bg-popover p-0 text-popover-foreground shadow-md">
                <ScenarioPanel scenario={scenario} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScenarioPanel({ scenario }: { scenario: ShareScenario }) {
  const [inviteEmail, setInviteEmail] = useState(scenario.formError ? "not-an-email" : "");
  const [inviteScope, setInviteScope] = useState<"viewer" | "editor">("viewer");
  const accessProjection = buildCloudShareAccessProjection({
    acl: scenario.acl,
    invites: scenario.invites,
    accessRequests: scenario.accessRequests,
  });
  const copyLabel = scenario.message?.text === "Link copied." ? "Copied link" : "Copy link";
  const compactCopyLabel = scenario.message?.text === "Link copied." ? "Copied" : "Copy";

  return (
    <CloudSharingPanel
      accessProjection={accessProjection}
      busyAction={null}
      compactCopyLinkLabel={compactCopyLabel}
      copyLinkLabel={copyLabel}
      formError={scenario.formError ?? null}
      inviteEmail={inviteEmail}
      inviteReady={Boolean(inviteEmail) && !scenario.formError}
      inviteScope={inviteScope}
      message={scenario.message?.text ?? null}
      messageKind={scenario.message?.kind ?? "info"}
      onCopyLink={() => {}}
      onInviteEmailChange={setInviteEmail}
      onInviteScopeChange={setInviteScope}
      onRemoveAccessRow={() => {}}
      onResolveAccessRequest={() => {}}
      onSubmitInvite={(event) => event.preventDefault()}
      onTogglePublicAccess={() => {}}
      publicBusy={false}
      publicEnabled={scenario.publicEnabled}
      showInitialAccessLoading={scenario.showInitialAccessLoading}
    />
  );
}
