import { Check, Globe2, Link2, Mail, ServerCog, Trash2, UserRound, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
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
import { cn } from "@/lib/utils";
import type {
  CloudShareAccessProjection,
  CloudShareAccessRow,
  CloudShareInviteScope,
} from "./sharing-client";

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

/**
 * Presentational body of the sharing popover, extracted so the Elements
 * fixture can render the exact same markup `CloudSharingControls` renders
 * inside its `PopoverContent`, instead of a hand-copied JSX recreation that
 * can drift from the real component.
 */
export function CloudSharingPanel({
  accessProjection,
  busyAction,
  compactCopyLinkLabel,
  copyLinkLabel,
  formError,
  inviteEmail,
  inviteReady,
  inviteScope,
  message,
  messageKind,
  onCopyLink,
  onInviteEmailChange,
  onInviteScopeChange,
  onRemoveAccessRow,
  onResolveAccessRequest,
  onSubmitInvite,
  onTogglePublicAccess,
  publicBusy,
  publicEnabled,
  showInitialAccessLoading,
}: CloudSharingPanelProps) {
  return (
    <>
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
          aria-label={copyLinkLabel}
          onClick={onCopyLink}
        >
          <Link2 className="size-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">{copyLinkLabel}</span>
          <span className="sm:hidden">{compactCopyLinkLabel}</span>
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
          disabled={publicBusy}
          onClick={onTogglePublicAccess}
        >
          {publicEnabled ? "Disable" : "Enable"}
        </Button>
      </section>

      <form
        className="grid gap-2 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_9rem_auto]"
        onSubmit={onSubmitInvite}
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
            onChange={(event) => onInviteEmailChange(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cloud-share-invite-scope" className="text-xs text-muted-foreground">
            Access
          </Label>
          <Select
            value={inviteScope}
            onValueChange={(value) => onInviteScopeChange(value as CloudShareInviteScope)}
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
                      onClick={() => onResolveAccessRequest(row, "approve")}
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
                      onClick={() => onResolveAccessRequest(row, "deny")}
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
                      onClick={() => onResolveAccessRequest(row, "dismiss")}
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
        {showInitialAccessLoading ? (
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
                  <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>
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
                      onClick={() => onRemoveAccessRow(row)}
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
    </>
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
