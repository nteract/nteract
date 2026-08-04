import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fetchWithCloudPrototypeAuth, type CloudPrototypeAuthState } from "./collaborator-auth";
import { appendEndpointPathSegment, cloudResponseError } from "./cloud-response";
import {
  CloudSharingFactsStore,
  type CloudSharingCopyState,
  type CloudSharingFactsProjection,
  type CloudSharingLoadState,
  type CloudSharingSourceFacts,
} from "./cloud-sharing-facts";
import { useCloudFactsProjection } from "./cloud-facts-react";
import {
  CloudSharingPanel,
  type CloudSharingAccessRequestAction,
  type CloudSharingMessageKind,
} from "./sharing-panel";
import {
  normalizeShareInviteEmail,
  type CloudNotebookAccessRequest,
  type CloudNotebookAclRow,
  type CloudNotebookInvite,
  type CloudShareAccessRow,
  type CloudShareInviteScope,
} from "./sharing-client";

interface CloudSharingControlsProps {
  accessRequestsEndpoint: string;
  aclEndpoint: string;
  authState: CloudPrototypeAuthState;
  invitesEndpoint: string;
  publicLink: string;
}

function useCloudSharingFactsProjection(
  source: CloudSharingSourceFacts,
): CloudSharingFactsProjection {
  return useCloudFactsProjection(source, (initial) => new CloudSharingFactsStore(initial));
}

export function CloudSharingControls({
  accessRequestsEndpoint,
  aclEndpoint,
  authState,
  invitesEndpoint,
  publicLink,
}: CloudSharingControlsProps) {
  const [open, setOpen] = useState(false);
  const [acl, setAcl] = useState<CloudNotebookAclRow[]>([]);
  const [invites, setInvites] = useState<CloudNotebookInvite[]>([]);
  const [accessRequests, setAccessRequests] = useState<CloudNotebookAccessRequest[]>([]);
  const [loadState, setLoadState] = useState<CloudSharingLoadState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<CloudSharingMessageKind>("info");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteScope, setInviteScope] = useState<CloudShareInviteScope>("viewer");
  const [formError, setFormError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CloudSharingCopyState>("idle");
  const inviteSubmitLockRef = useRef(false);
  const sharingSourceFacts = useMemo<CloudSharingSourceFacts>(
    () => ({
      accessRequests,
      acl,
      copyState,
      inviteEmail,
      invites,
      loadState,
    }),
    [accessRequests, acl, copyState, inviteEmail, invites, loadState],
  );
  const sharingFacts = useCloudSharingFactsProjection(sharingSourceFacts);
  const accessProjection = sharingFacts.access;
  const publicEnabled = sharingFacts.publicEnabled;
  const inviteReady = sharingFacts.inviteReady;

  const loadSharingState = useCallback(
    async (options?: { preserveMessage?: boolean; signal?: AbortSignal }) => {
      setLoadState("loading");
      if (!options?.preserveMessage) {
        setMessage(null);
      }
      try {
        const [aclResponse, invitesResponse, accessRequestsResponse] = await Promise.all([
          fetchWithCloudPrototypeAuth(
            aclEndpoint,
            { headers: { Accept: "application/json" }, signal: options?.signal },
            authState,
          ),
          fetchWithCloudPrototypeAuth(
            invitesEndpoint,
            { headers: { Accept: "application/json" }, signal: options?.signal },
            authState,
          ),
          fetchWithCloudPrototypeAuth(
            accessRequestsEndpoint,
            { headers: { Accept: "application/json" }, signal: options?.signal },
            authState,
          ),
        ]);
        if (options?.signal?.aborted) {
          return;
        }
        if (!aclResponse.ok) {
          throw await cloudResponseError(
            aclResponse,
            aclResponse.status === 403
              ? "Only the notebook owner can manage sharing"
              : "Unable to load access list",
          );
        }
        if (!invitesResponse.ok) {
          throw await cloudResponseError(
            invitesResponse,
            invitesResponse.status === 403
              ? "Only the notebook owner can manage invites"
              : "Unable to load invites",
          );
        }
        if (!accessRequestsResponse.ok) {
          throw await cloudResponseError(
            accessRequestsResponse,
            accessRequestsResponse.status === 403
              ? "Only the notebook owner can manage access requests"
              : "Unable to load access requests",
          );
        }
        const aclBody = (await aclResponse.json()) as { acl?: CloudNotebookAclRow[] };
        const invitesBody = (await invitesResponse.json()) as { invites?: CloudNotebookInvite[] };
        const accessRequestsBody = (await accessRequestsResponse.json()) as {
          access_requests?: CloudNotebookAccessRequest[];
        };
        setAcl(Array.isArray(aclBody.acl) ? aclBody.acl : []);
        setInvites(Array.isArray(invitesBody.invites) ? invitesBody.invites : []);
        setAccessRequests(
          Array.isArray(accessRequestsBody.access_requests)
            ? accessRequestsBody.access_requests
            : [],
        );
        setLoadState("ready");
      } catch (error) {
        if (options?.signal?.aborted) {
          return;
        }
        setLoadState("error");
        setMessageKind("error");
        setMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [accessRequestsEndpoint, aclEndpoint, authState, invitesEndpoint],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void loadSharingState({ signal: controller.signal });
    return () => controller.abort();
  }, [loadSharingState, open]);

  const copyPublicLink = async () => {
    try {
      await navigator.clipboard.writeText(publicLink);
      setCopyState("copied");
      setMessageKind("info");
      setMessage("Link copied.");
    } catch {
      setCopyState("failed");
      setMessageKind("error");
      setMessage("Unable to copy the link.");
    }
  };

  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inviteSubmitLockRef.current) {
      return;
    }
    const email = normalizeShareInviteEmail(inviteEmail);
    if (!email) {
      setFormError("Enter a valid email address.");
      return;
    }

    inviteSubmitLockRef.current = true;
    setBusyAction("invite");
    setFormError(null);
    setMessage(null);
    try {
      const response = await fetchWithCloudPrototypeAuth(
        invitesEndpoint,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email, scope: inviteScope }),
        },
        authState,
      );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to create invite");
      }
      setInviteEmail("");
      setMessageKind("info");
      setMessage(`Invite created for ${email}.`);
      await loadSharingState({ preserveMessage: true });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      inviteSubmitLockRef.current = false;
      setBusyAction(null);
    }
  };

  const togglePublicAccess = async () => {
    setBusyAction("public");
    setMessage(null);
    try {
      const response = await fetchWithCloudPrototypeAuth(
        aclEndpoint,
        {
          method: publicEnabled ? "DELETE" : "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subject_kind: "public",
            subject: "anonymous",
            scope: "viewer",
          }),
        },
        authState,
      );
      if (!response.ok) {
        throw await cloudResponseError(
          response,
          publicEnabled ? "Unable to disable public link" : "Unable to enable public link",
        );
      }
      setMessageKind("info");
      setMessage(publicEnabled ? "Public link disabled." : "Public link enabled.");
      await loadSharingState({ preserveMessage: true });
    } catch (error) {
      setMessageKind("error");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const removeAccessRow = async (row: CloudShareAccessRow) => {
    if (!row.removable) return;
    if (row.kind === "access_request") return;

    setBusyAction(row.id);
    setMessage(null);
    try {
      const response =
        row.kind === "invite"
          ? await fetchWithCloudPrototypeAuth(
              appendEndpointPathSegment(invitesEndpoint, row.invite.id),
              {
                method: "DELETE",
                headers: { Accept: "application/json" },
              },
              authState,
            )
          : await fetchWithCloudPrototypeAuth(
              aclEndpoint,
              {
                method: "DELETE",
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  subject_kind: row.acl.subject_kind,
                  subject: row.acl.subject,
                  scope: row.acl.scope,
                }),
              },
              authState,
            );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to remove access");
      }
      setMessageKind("info");
      setMessage(`${row.label} removed.`);
      await loadSharingState({ preserveMessage: true });
    } catch (error) {
      setMessageKind("error");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const resolveAccessRequest = async (
    row: Extract<CloudShareAccessRow, { kind: "access_request" }>,
    action: CloudSharingAccessRequestAction,
  ) => {
    setBusyAction(`${row.id}:${action}`);
    setMessage(null);
    try {
      const response = await fetchWithCloudPrototypeAuth(
        appendEndpointPathSegment(accessRequestsEndpoint, row.accessRequest.id),
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action }),
        },
        authState,
      );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to update access request");
      }
      setMessageKind("info");
      setMessage(accessRequestActionMessage(row.label, action));
      await loadSharingState({ preserveMessage: true });
    } catch (error) {
      setMessageKind("error");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setCopyState("idle");
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5" title="Share notebook">
          <Share2 className="size-3.5" aria-hidden="true" />
          <span>Share</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(30rem,calc(100vw-1.5rem))] max-h-[calc(100vh-5.5rem)] overflow-y-auto p-0"
        align="end"
        sideOffset={8}
      >
        <CloudSharingPanel
          accessProjection={accessProjection}
          busyAction={busyAction}
          compactCopyLinkLabel={sharingFacts.compactCopyLinkLabel}
          copyLinkLabel={sharingFacts.copyLinkLabel}
          formError={formError}
          inviteEmail={inviteEmail}
          inviteReady={inviteReady}
          inviteScope={inviteScope}
          message={message}
          messageKind={messageKind}
          onCopyLink={() => void copyPublicLink()}
          onInviteEmailChange={(value) => {
            setInviteEmail(value);
            setFormError(null);
          }}
          onInviteScopeChange={setInviteScope}
          onRemoveAccessRow={(row) => void removeAccessRow(row)}
          onResolveAccessRequest={(row, action) => void resolveAccessRequest(row, action)}
          onSubmitInvite={submitInvite}
          onTogglePublicAccess={() => void togglePublicAccess()}
          publicBusy={busyAction === "public" || loadState === "loading"}
          publicEnabled={publicEnabled}
          showInitialAccessLoading={sharingFacts.showInitialAccessLoading}
        />
      </PopoverContent>
    </Popover>
  );
}

function accessRequestActionMessage(
  label: string,
  action: CloudSharingAccessRequestAction,
): string {
  switch (action) {
    case "approve":
      return `${label} can now edit.`;
    case "deny":
      return `${label} denied.`;
    case "dismiss":
      return `${label} dismissed.`;
  }
}
