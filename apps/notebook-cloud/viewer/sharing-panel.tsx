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
  CloudCollaboratorPerson,
  CloudSearchPerson,
  CloudPeopleSearchState,
} from "./people-search-types";
import { HiddenPeoplePanel, type HiddenPeoplePanelProps } from "./hidden-people-panel";
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
  peopleSearch?: CloudPeopleSearchState;
  selectedPerson?: CloudSearchPerson | null;
  onSelectPerson?: (person: CloudSearchPerson) => void;
  onHidePerson?: (person: CloudCollaboratorPerson) => void;
  hiddenSuggestions?: HiddenPeoplePanelProps;
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
  peopleSearch,
  selectedPerson,
  onSelectPerson,
  onHidePerson,
  hiddenSuggestions,
}: CloudSharingPanelProps) {
  const directoryEnabled =
    peopleSearch?.directoryEnabled === true || peopleSearch?.collaboratorsEnabled === true;
  const peopleGroups = [
    { source: "collaborator", label: "Previous collaborators" },
    { source: "directory", label: "Company directory" },
  ] as const;
  return (
    <>
      <header className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Share notebook</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Invite people, review requests, and manage link access.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-label={copyLinkLabel}
          onClick={onCopyLink}
        >
          <Link2 />
          <span className="hidden sm:inline">{copyLinkLabel}</span>
          <span className="sm:hidden">{compactCopyLinkLabel}</span>
        </Button>
      </header>

      <section
        className="flex items-start justify-between gap-3 border-b border-l-2 border-b-border border-l-emerald-500/70 bg-emerald-500/[0.06] px-4 py-3"
        aria-label="Public link access"
      >
        <div className="flex min-w-0 items-start gap-2.5 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
          <Globe2 className="text-emerald-700 dark:text-emerald-300" />
          <div className="min-w-0">
            <strong className="block text-sm font-semibold">Anyone with the link</strong>
            <span className="block text-xs text-muted-foreground">
              {publicEnabled
                ? "Can view this notebook without signing in"
                : "Link access is off. Only listed people can open this notebook"}
            </span>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={publicBusy}
          onClick={onTogglePublicAccess}
        >
          {publicEnabled ? "Disable" : "Enable"}
        </Button>
      </section>

      <form
        className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto]"
        onSubmit={onSubmitInvite}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="cloud-share-invite-email" className="text-xs text-muted-foreground">
            {directoryEnabled ? "Name or email" : "Invite by email"}
          </Label>
          <Input
            id="cloud-share-invite-email"
            name="invite-email"
            type={directoryEnabled ? "text" : "email"}
            value={inviteEmail}
            placeholder={
              directoryEnabled ? "Search people or enter full email" : "name@example.com"
            }
            autoComplete={directoryEnabled ? "off" : "email"}
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
          aria-label={
            selectedPerson?.source === "collaborator"
              ? `Share with ${selectedPerson.displayName}`
              : undefined
          }
          className="self-end"
          disabled={!inviteReady || busyAction === "invite"}
        >
          {selectedPerson?.source === "collaborator" ? <UserRound /> : <Mail />}
          {selectedPerson?.source === "collaborator" ? "Share" : "Invite"}
        </Button>
        {selectedPerson ? (
          <p className="col-span-full text-xs text-muted-foreground">
            {selectedPerson.displayName} selected. Choose access, then{" "}
            {selectedPerson.source === "collaborator"
              ? "share this notebook."
              : "invite them to this notebook."}
          </p>
        ) : directoryEnabled ? (
          <div className="col-span-full" aria-live="polite">
            {peopleSearch.people.length > 0 ? (
              peopleGroups.map((group) =>
                peopleSearch.people.some((person) => person.source === group.source) ? (
                  <section key={group.source} aria-label={`${group.label} results`}>
                    <p className="mb-1 text-xs text-muted-foreground">{group.label}</p>
                    <ul className="divide-y divide-border/70">
                      {peopleSearch.people
                        .filter((person) => person.source === group.source)
                        .map((person) => (
                          <li
                            key={`${person.source}:${person.id}`}
                            className="flex items-center gap-1"
                          >
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() => onSelectPerson?.(person)}
                              aria-label={`Select ${person.displayName}`}
                            >
                              {person.avatarUrl ? (
                                <img
                                  src={person.avatarUrl}
                                  alt=""
                                  className="size-6 rounded-full object-cover"
                                  referrerPolicy="no-referrer"
                                />
                              ) : (
                                <UserRound
                                  className="size-4 text-muted-foreground"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="min-w-0 truncate">{person.displayName}</span>
                            </button>
                            {person.source === "collaborator" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                title="Hide collaboration suggestion"
                                aria-label={`Hide collaboration suggestion for ${person.displayName}`}
                                disabled={
                                  hiddenSuggestions?.state.busyId !== null &&
                                  hiddenSuggestions?.state.busyId !== undefined
                                }
                                onClick={() => onHidePerson?.(person)}
                              >
                                Hide
                              </Button>
                            ) : null}
                          </li>
                        ))}
                    </ul>
                  </section>
                ) : null,
              )
            ) : (
              <p className="text-xs text-muted-foreground">
                {peopleSearch.status === "error"
                  ? "People search is unavailable. You can still invite by full email."
                  : peopleSearch.query.length > 80
                    ? "Use 80 characters or fewer to search, or enter a full email."
                    : peopleSearch.status === "loading" && peopleSearch.query
                      ? "Searching people…"
                      : peopleSearch.query
                        ? "No matching people. You can invite by full email."
                        : "Type at least two characters to find people, or enter a full email."}
              </p>
            )}
          </div>
        ) : null}
        {hiddenSuggestions ? <HiddenPeoplePanel {...hiddenSuggestions} /> : null}
        {peopleSearch?.requiresReverification ? (
          <p className="col-span-full text-xs text-muted-foreground" role="status">
            Sign in again to search the company directory. You can still invite by full email.
          </p>
        ) : null}
        {formError ? (
          <div
            className="col-span-full rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
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
            className="border-l-2 border-amber-500/60 bg-amber-500/[0.05] px-4 py-3"
            aria-label="Edit access requests"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">Edit requests</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
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
                <CloudShareRow key={row.id} row={row}>
                  <CloudShareRowAction
                    label={`Approve ${row.label}`}
                    disabled={busyAction === `${row.id}:approve`}
                    onClick={() => onResolveAccessRequest(row, "approve")}
                  >
                    <Check />
                  </CloudShareRowAction>
                  <CloudShareRowAction
                    label={`Deny ${row.label}`}
                    disabled={busyAction === `${row.id}:deny`}
                    onClick={() => onResolveAccessRequest(row, "deny")}
                  >
                    <X />
                  </CloudShareRowAction>
                  <CloudShareRowAction
                    label={`Dismiss ${row.label}`}
                    disabled={busyAction === `${row.id}:dismiss`}
                    onClick={() => onResolveAccessRequest(row, "dismiss")}
                  >
                    <Trash2 />
                  </CloudShareRowAction>
                </CloudShareRow>
              ))}
            </ul>
          </section>
        </>
      ) : null}

      <Separator />
      <section className="px-4 py-3" aria-label="Current notebook access">
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
              <CloudShareRow key={row.id} row={row}>
                {row.removable ? (
                  <CloudShareRowAction
                    label={`Remove ${row.label}`}
                    disabled={busyAction === row.id}
                    onClick={() => onRemoveAccessRow(row)}
                  >
                    <Trash2 />
                  </CloudShareRowAction>
                ) : null}
              </CloudShareRow>
            ))}
          </ul>
        )}
      </section>

      {accessProjection.runtimeAccessRows.length > 0 ? (
        <>
          <Separator />
          <section className="px-4 py-3" aria-label="Compute access">
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
                <CloudShareRow key={row.id} row={row} />
              ))}
            </ul>
          </section>
        </>
      ) : null}

      {message ? (
        <div className="px-4 pt-3 pb-4">
          <div
            className={cn(
              "rounded-md border px-2.5 py-2 text-xs",
              messageKind === "error"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            )}
            data-kind={messageKind}
          >
            {message}
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Owns row geometry for every section so trailing controls line up. The action
 * column is reserved even when a row has no buttons, and is pulled right by the
 * icon button's 6px padding so glyphs — not button boxes — land on the content
 * edge, matching where plain text ends in button-less rows.
 */
function CloudShareRow({ row, children }: { row: CloudShareAccessRow; children?: ReactNode }) {
  return (
    <li
      title={row.title}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 py-2.5 [&>svg]:size-4 [&>svg]:shrink-0"
    >
      <CloudShareRowIcon row={row} />
      <div className="min-w-0">
        <strong className="block truncate text-sm font-medium">{row.label}</strong>
        <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{row.badge}</span>
        {row.stateLabel ? (
          <CloudShareStateLabel tone={row.stateTone}>{row.stateLabel}</CloudShareStateLabel>
        ) : null}
      </div>
      <div className="-mr-1.5 flex min-w-7 items-center justify-end">{children}</div>
    </li>
  );
}

function CloudShareRowAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
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
    return <Mail className="text-muted-foreground" />;
  }
  if (row.kind === "access_request") {
    return <UserRound className="text-muted-foreground" />;
  }
  if (row.kind === "acl" && row.scope === "runtime_peer") {
    return <ServerCog className="text-muted-foreground" />;
  }
  if (row.acl.subject_kind === "public") {
    return <Globe2 className="text-emerald-700 dark:text-emerald-300" />;
  }
  return <UserRound className="text-muted-foreground" />;
}
