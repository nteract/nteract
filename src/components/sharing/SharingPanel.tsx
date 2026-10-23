import { Check, Globe2, Link2, Mail, ServerCog, Trash2, UserRound, X } from "lucide-react";
import {
  useId,
  type ButtonHTMLAttributes,
  type ComponentType,
  type FormEvent,
  type ComponentProps,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
} from "react";

export type SharingAccessRequestAction = "approve" | "deny" | "dismiss";
export type SharingMessageKind = "info" | "error";
export type SharingInviteScope = "viewer" | "editor";
export interface SharingAccessRow {
  id: string;
  kind: "acl" | "invite" | "access_request";
  icon?: "person" | "public" | "runtime";
  label: string;
  detail: string;
  title: string;
  badge: string;
  stateLabel: string | null;
  stateTone: "success" | "pending" | null;
  removable: boolean;
}
export interface SharingAccessProjection<Row extends SharingAccessRow> {
  accessRows: readonly Row[];
  accessSummary: string | null;
  accessRequestRows: readonly Row[];
  accessRequestSummary: string | null;
  runtimeAccessRows: readonly Row[];
  runtimeAccessSummary: string | null;
}
export interface SharingScopeSelectProps {
  id: string;
  value: SharingInviteScope;
  onValueChange: (value: SharingInviteScope) => void;
}
export interface SharingPrimitives {
  Button: ComponentType<
    ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: "outline" | "ghost";
      size?: "sm" | "icon";
    }
  >;
  Input: ComponentType<InputHTMLAttributes<HTMLInputElement>>;
  Label: ComponentType<LabelHTMLAttributes<HTMLLabelElement>>;
  ScopeSelect: ComponentType<SharingScopeSelectProps>;
  Separator: ComponentType;
}
export interface SharingPanelProps<Row extends SharingAccessRow = SharingAccessRow> {
  accessProjection: SharingAccessProjection<Row>;
  busyAction: string | null;
  compactCopyLinkLabel: string;
  copyLinkLabel: string;
  formError: string | null;
  inviteEmail: string;
  inviteReady: boolean;
  inviteScope: SharingInviteScope;
  message: string | null;
  messageKind: SharingMessageKind;
  onCopyLink: () => void;
  onInviteEmailChange: (value: string) => void;
  onInviteScopeChange: (value: SharingInviteScope) => void;
  onRemoveAccessRow: (row: Row) => void;
  onResolveAccessRequest: (row: Row, action: SharingAccessRequestAction) => void;
  onSubmitInvite: (event: FormEvent<HTMLFormElement>) => void;
  onTogglePublicAccess: () => void;
  publicBusy: boolean;
  publicEnabled: boolean;
  showInitialAccessLoading: boolean;
  resourceLabel?: string;
  title?: string;
  description?: string;
  emptyAccessMessage?: string;
  sections?: {
    publicAccess?: boolean;
    invites?: boolean;
    accessRequests?: boolean;
    runtimeAccess?: boolean;
  };
  primitives?: SharingPrimitives;
  /** Native styling is opt-in via sharing-panel.css; notebook hosts inject their primitives. */
  appearance?: "native" | "notebook";
}

function NativeButton({ variant, size, ...props }: ComponentProps<SharingPrimitives["Button"]>) {
  return <button data-variant={variant} data-size={size} {...props} />;
}
const nativePrimitives: SharingPrimitives = {
  Button: NativeButton,
  Input: (props) => <input {...props} />,
  Label: (props) => <label {...props} />,
  ScopeSelect: ({ id, value, onValueChange }) => (
    <select
      id={id}
      value={value}
      onChange={(event) => onValueChange(event.target.value as SharingInviteScope)}
    >
      <option value="viewer">Can view</option>
      <option value="editor">Can edit</option>
    </select>
  ),
  Separator: () => <hr />,
};
const classes = (...values: (string | false | null | undefined)[]) =>
  values.filter(Boolean).join(" ");

/**
 * Presentational body shared by notebook, Elements, and Pages. Hosts supply access facts
 * and actions; this component does not fetch or derive authorization.
 */
export function SharingPanel<Row extends SharingAccessRow>({
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
  resourceLabel = "notebook",
  title = `Share ${resourceLabel}`,
  description = "Invite people, review requests, and manage link access.",
  emptyAccessMessage = `Only the owner can access this ${resourceLabel}.`,
  sections = {},
  primitives = nativePrimitives,
  appearance = "native",
}: SharingPanelProps<Row>) {
  const { Button, Input, Label, ScopeSelect, Separator } = primitives;
  const inputId = useId();
  return (
    <div className="sharing-panel" data-appearance={appearance}>
      <header
        data-sharing-header
        className="flex items-start justify-between gap-3 border-b px-4 py-3"
      >
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
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
          <span data-sharing-copy-full className="hidden sm:inline">
            {copyLinkLabel}
          </span>
          <span data-sharing-copy-compact className="sm:hidden">
            {compactCopyLinkLabel}
          </span>
        </Button>
      </header>

      {sections.publicAccess !== false && (
        <section
          data-sharing-public
          className="flex items-start justify-between gap-3 border-b border-l-2 border-b-border border-l-emerald-500/70 bg-emerald-500/[0.06] px-4 py-3"
          aria-label="Public link access"
        >
          <div className="flex min-w-0 items-start gap-2.5 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
            <Globe2 className="text-emerald-700 dark:text-emerald-300" />
            <div className="min-w-0">
              <strong className="block text-sm font-semibold">Anyone with the link</strong>
              <span className="block text-xs text-muted-foreground">
                {publicEnabled
                  ? `Can view this ${resourceLabel} without signing in`
                  : `Link access is off. Only listed people can open this ${resourceLabel}`}
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
      )}

      {sections.invites !== false && (
        <form
          data-sharing-invite
          className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto]"
          onSubmit={onSubmitInvite}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={`${inputId}-email`} className="text-xs text-muted-foreground">
              Invite by email
            </Label>
            <Input
              id={`${inputId}-email`}
              name="invite-email"
              type="email"
              value={inviteEmail}
              placeholder="name@example.com"
              autoComplete="email"
              onChange={(event) => onInviteEmailChange(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${inputId}-scope`} className="text-xs text-muted-foreground">
              Access
            </Label>
            <ScopeSelect
              id={`${inputId}-scope`}
              value={inviteScope}
              onValueChange={onInviteScopeChange}
            />
          </div>
          <Button
            type="submit"
            className="self-end"
            disabled={!inviteReady || busyAction === "invite"}
          >
            <Mail />
            Invite
          </Button>
          {formError ? (
            <div
              className="col-span-full rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
              role="alert"
            >
              {formError}
            </div>
          ) : null}
        </form>
      )}

      {sections.accessRequests !== false && accessProjection.accessRequestRows.length > 0 ? (
        <>
          <Separator />
          <section
            className="border-l-2 border-amber-500/60 bg-amber-500/[0.05] px-4 py-3"
            aria-label="Edit access requests"
            data-sharing-requests
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
                <SharingRow key={row.id} row={row}>
                  <SharingRowAction
                    Button={Button}
                    label={`Approve ${row.label}`}
                    disabled={busyAction === `${row.id}:approve`}
                    onClick={() => onResolveAccessRequest(row, "approve")}
                  >
                    <Check />
                  </SharingRowAction>
                  <SharingRowAction
                    Button={Button}
                    label={`Deny ${row.label}`}
                    disabled={busyAction === `${row.id}:deny`}
                    onClick={() => onResolveAccessRequest(row, "deny")}
                  >
                    <X />
                  </SharingRowAction>
                  <SharingRowAction
                    Button={Button}
                    label={`Dismiss ${row.label}`}
                    disabled={busyAction === `${row.id}:dismiss`}
                    onClick={() => onResolveAccessRequest(row, "dismiss")}
                  >
                    <Trash2 />
                  </SharingRowAction>
                </SharingRow>
              ))}
            </ul>
          </section>
        </>
      ) : null}

      <Separator />
      <section
        data-sharing-access
        className="px-4 py-3"
        aria-label={`Current ${resourceLabel} access`}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Current access</h3>
          {accessProjection.accessSummary ? (
            <span className="text-xs text-muted-foreground">{accessProjection.accessSummary}</span>
          ) : null}
        </div>
        {showInitialAccessLoading ? (
          <div className="py-2 text-xs text-muted-foreground">Loading access...</div>
        ) : accessProjection.accessRows.length === 0 ? (
          <div className="py-2 text-xs text-muted-foreground">{emptyAccessMessage}</div>
        ) : (
          <ul className="divide-y divide-border/70">
            {accessProjection.accessRows.map((row) => (
              <SharingRow key={row.id} row={row}>
                {row.removable ? (
                  <SharingRowAction
                    Button={Button}
                    label={`Remove ${row.label}`}
                    disabled={busyAction === row.id}
                    onClick={() => onRemoveAccessRow(row)}
                  >
                    <Trash2 />
                  </SharingRowAction>
                ) : null}
              </SharingRow>
            ))}
          </ul>
        )}
      </section>

      {sections.runtimeAccess !== false && accessProjection.runtimeAccessRows.length > 0 ? (
        <>
          <Separator />
          <section className="px-4 py-3" aria-label="Compute access" data-sharing-runtime>
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
                <SharingRow key={row.id} row={row} />
              ))}
            </ul>
          </section>
        </>
      ) : null}

      {message ? (
        <div data-sharing-message className="px-4 pt-3 pb-4">
          <div
            className={classes(
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
    </div>
  );
}

/**
 * Owns row geometry for every section so trailing controls line up. The action
 * column is reserved even when a row has no buttons, and is pulled right by the
 * icon button's 6px padding so glyphs — not button boxes — land on the content
 * edge, matching where plain text ends in button-less rows.
 */
function SharingRow({ row, children }: { row: SharingAccessRow; children?: ReactNode }) {
  return (
    <li
      data-sharing-row
      title={row.title}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 py-2.5 [&>svg]:size-4 [&>svg]:shrink-0"
    >
      <SharingRowIcon row={row} />
      <div data-sharing-person className="min-w-0">
        <strong className="block truncate text-sm font-medium">{row.label}</strong>
        <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>
      </div>
      <div data-sharing-badges className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{row.badge}</span>
        {row.stateLabel ? (
          <SharingStateLabel tone={row.stateTone}>{row.stateLabel}</SharingStateLabel>
        ) : null}
      </div>
      <div data-sharing-actions className="-mr-1.5 flex min-w-7 items-center justify-end">
        {children}
      </div>
    </li>
  );
}

function SharingRowAction({
  Button,
  label,
  disabled,
  onClick,
  children,
}: {
  Button: SharingPrimitives["Button"];
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

function SharingStateLabel({
  tone,
  children,
}: {
  tone: SharingAccessRow["stateTone"];
  children: ReactNode;
}) {
  return (
    <span
      className={classes(
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

function SharingRowIcon({ row }: { row: SharingAccessRow }) {
  if (row.kind === "invite") {
    return <Mail className="text-muted-foreground" />;
  }
  if (row.kind === "access_request") {
    return <UserRound className="text-muted-foreground" />;
  }
  if (row.icon === "runtime") {
    return <ServerCog className="text-muted-foreground" />;
  }
  if (row.icon === "public") {
    return <Globe2 className="text-emerald-700 dark:text-emerald-300" />;
  }
  return <UserRound className="text-muted-foreground" />;
}
