import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Check, Globe2, Link2, Mail, ServerCog, Share2, Trash2, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
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

type CloudSharingMessageKind = "info" | "error";
type CloudSharingAccessRequestAction = "approve" | "deny" | "dismiss";

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

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
        <header className="flex items-start justify-between gap-3 border-b px-4 py-3.5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Share notebook</h2>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Invite people, review requests, and manage link access.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 gap-1.5"
            aria-label={sharingFacts.copyLinkLabel}
            onClick={() => void copyPublicLink()}
          >
            <Link2 className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">{sharingFacts.copyLinkLabel}</span>
            <span className="sm:hidden">{sharingFacts.compactCopyLinkLabel}</span>
          </Button>
        </header>

        <section
          className="mx-4 mt-3 flex items-start justify-between gap-3 border-l-2 border-emerald-500/70 bg-emerald-500/[0.06] py-2.5 pl-3 pr-2.5"
          aria-label="Public link access"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <Globe2
              className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <strong className="block text-sm font-semibold">Anyone with the link</strong>
              <span className="text-xs leading-5 text-muted-foreground">
                {publicEnabled
                  ? "Can view this notebook without signing in"
                  : "Link access is off. Only listed people can open this notebook"}
              </span>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
            disabled={busyAction === "public" || loadState === "loading"}
            onClick={() => void togglePublicAccess()}
          >
            {publicEnabled ? "Disable" : "Enable"}
          </Button>
        </section>

        <form
          className="grid gap-2 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_9rem_auto]"
          onSubmit={submitInvite}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="cloud-share-invite-email" className="text-xs text-muted-foreground">
              Invite by email
            </Label>
            <Input
              id="cloud-share-invite-email"
              name="invite-email"
              type="email"
              value={inviteEmail}
              placeholder="name@example.com"
              autoComplete="email"
              onChange={(event) => {
                setInviteEmail(event.target.value);
                setFormError(null);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cloud-share-invite-scope" className="text-xs text-muted-foreground">
              Access
            </Label>
            <Select
              value={inviteScope}
              onValueChange={(value) => setInviteScope(value as CloudShareInviteScope)}
            >
              <SelectTrigger id="cloud-share-invite-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">Can view</SelectItem>
                <SelectItem value="editor">Can edit</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            type="submit"
            className="self-end gap-1.5"
            disabled={!inviteReady || busyAction === "invite"}
          >
            <Mail className="size-3.5" aria-hidden="true" />
            Invite
          </Button>
          {formError ? (
            <div
              className="col-span-full rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs leading-5 text-destructive"
              role="alert"
            >
              {formError}
            </div>
          ) : null}
        </form>

        {accessProjection.accessRequestRows.length > 0 ? (
          <>
            <Separator />
            <section
              className="border-l-2 border-amber-500/60 bg-amber-500/[0.05] px-4 py-3.5"
              aria-label="Edit access requests"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">Edit requests</h3>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    Approve collaborators you recognize, or dismiss stale requests.
                  </p>
                </div>
                {accessProjection.accessRequestSummary ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {accessProjection.accessRequestSummary}
                  </span>
                ) : null}
              </div>
              <ul className="divide-y divide-border/70">
                {accessProjection.accessRequestRows.map((row) => (
                  <li
                    key={row.id}
                    title={row.title}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5"
                  >
                    <CloudShareRowIcon row={row} />
                    <div className="min-w-0">
                      <strong className="block truncate text-sm font-medium">{row.label}</strong>
                      <span className="block truncate text-xs text-muted-foreground">
                        {row.detail}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">{row.badge}</span>
                      <CloudShareStateLabel tone={row.stateTone}>
                        {row.stateLabel}
                      </CloudShareStateLabel>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0"
                        aria-label={`Approve ${row.label}`}
                        title={`Approve ${row.label}`}
                        disabled={busyAction === `${row.id}:approve`}
                        onClick={() => void resolveAccessRequest(row, "approve")}
                      >
                        <Check className="size-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0"
                        aria-label={`Deny ${row.label}`}
                        title={`Deny ${row.label}`}
                        disabled={busyAction === `${row.id}:deny`}
                        onClick={() => void resolveAccessRequest(row, "deny")}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0"
                        aria-label={`Dismiss ${row.label}`}
                        title={`Dismiss ${row.label}`}
                        disabled={busyAction === `${row.id}:dismiss`}
                        onClick={() => void resolveAccessRequest(row, "dismiss")}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}

        <Separator />
        <section className="px-4 py-3.5" aria-label="Current notebook access">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Current access</h3>
            {accessProjection.notebookAccessSummary ? (
              <span className="text-xs text-muted-foreground">
                {accessProjection.notebookAccessSummary}
              </span>
            ) : null}
          </div>
          {sharingFacts.showInitialAccessLoading ? (
            <div className="py-2 text-xs text-muted-foreground">Loading access...</div>
          ) : accessProjection.notebookAccessRows.length === 0 ? (
            <div className="py-2 text-xs text-muted-foreground">
              Only the owner can access this notebook.
            </div>
          ) : (
            <ul className="divide-y divide-border/70">
              {accessProjection.notebookAccessRows.map((row) => (
                <li
                  key={row.id}
                  title={row.title}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5"
                >
                  <CloudShareRowIcon row={row} />
                  <div className="min-w-0">
                    <strong className="block truncate text-sm font-medium">{row.label}</strong>
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.detail}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">{row.badge}</span>
                    {row.stateLabel ? (
                      <CloudShareStateLabel tone={row.stateTone}>
                        {row.stateLabel}
                      </CloudShareStateLabel>
                    ) : null}
                    {row.removable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0"
                        aria-label={`Remove ${row.label}`}
                        title={`Remove ${row.label}`}
                        disabled={busyAction === row.id}
                        onClick={() => void removeAccessRow(row)}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {accessProjection.runtimeAccessRows.length > 0 ? (
          <>
            <Separator />
            <section className="px-4 py-3.5" aria-label="Compute access">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Compute access</h3>
                {accessProjection.runtimeAccessSummary ? (
                  <span className="text-xs text-muted-foreground">
                    {accessProjection.runtimeAccessSummary}
                  </span>
                ) : null}
              </div>
              <ul className="divide-y divide-border/70">
                {accessProjection.runtimeAccessRows.map((row) => (
                  <li
                    key={row.id}
                    title={row.title}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5"
                  >
                    <CloudShareRowIcon row={row} />
                    <div className="min-w-0">
                      <strong className="block truncate text-sm font-medium">{row.label}</strong>
                      <span className="block truncate text-xs text-muted-foreground">
                        {row.detail}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">{row.badge}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}

        {message ? (
          <div
            className={cn(
              "mx-4 mb-3.5 rounded-md border px-2.5 py-2 text-xs leading-5",
              messageKind === "error"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            )}
            data-kind={messageKind}
          >
            {message}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function CloudShareStateLabel({
  tone,
  children,
}: {
  tone: CloudShareAccessRow["stateTone"];
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "text-xs font-semibold",
        tone === "success" && "text-emerald-700 dark:text-emerald-300",
        tone === "pending" && "text-amber-700 dark:text-amber-300",
        !tone && "text-muted-foreground",
      )}
      data-tone={tone ?? undefined}
    >
      {children}
    </span>
  );
}

function CloudShareRowIcon({ row }: { row: CloudShareAccessRow }) {
  if (row.kind === "invite") {
    return <Mail className="size-4 text-muted-foreground" aria-hidden="true" />;
  }
  if (row.kind === "access_request") {
    return <UserRound className="size-4 text-muted-foreground" aria-hidden="true" />;
  }
  if (row.kind === "acl" && row.scope === "runtime_peer") {
    return <ServerCog className="size-4 text-muted-foreground" aria-hidden="true" />;
  }
  if (row.acl.subject_kind === "public") {
    return <Globe2 className="size-4 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />;
  }
  return <UserRound className="size-4 text-muted-foreground" aria-hidden="true" />;
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
