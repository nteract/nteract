"use client";

import {
  Check,
  Globe2,
  Link2,
  Mail,
  ServerCog,
  Share2,
  Trash2,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
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
import { Eyebrow } from "@/components/surface-primitives";

/**
 * Fixture recreation of `apps/notebook-cloud/viewer/sharing-controls.tsx`.
 * The real component reads hosted ACL/invite/access-request facts through
 * `CloudSharingFactsStore`; this fixture supplies the same projection shape
 * as static per-scenario props so every reachable panel state renders without
 * a live host. Keep the JSX structure in sync with the real component when
 * either changes.
 */

type ShareRowKind = "acl" | "invite" | "access_request";
type ShareRowTone = "success" | "pending" | null;

interface ShareRowFixture {
  id: string;
  kind: ShareRowKind;
  isPublic?: boolean;
  isRuntimePeer?: boolean;
  label: string;
  detail: string;
  badge: string;
  stateLabel: string | null;
  stateTone: ShareRowTone;
  removable: boolean;
}

interface ShareScenario {
  id: string;
  title: string;
  description: string;
  publicEnabled: boolean;
  loadState: "loading" | "ready" | "error";
  accessRequestRows: ShareRowFixture[];
  notebookAccessRows: ShareRowFixture[];
  runtimeAccessRows: ShareRowFixture[];
  message?: { kind: "info" | "error"; text: string };
  formError?: string;
}

const scenarios: readonly ShareScenario[] = [
  {
    id: "default",
    title: "Owner, public link off",
    description: "Baseline owner view: link access disabled, one collaborator, no pending items.",
    publicEnabled: false,
    loadState: "ready",
    accessRequestRows: [],
    notebookAccessRows: [
      {
        id: "acl:owner",
        kind: "acl",
        label: "Kyle",
        detail: "kyle@notebook.local",
        badge: "Owner",
        stateLabel: null,
        stateTone: null,
        removable: false,
      },
      {
        id: "acl:editor",
        kind: "acl",
        label: "Morgan",
        detail: "morgan@example.com",
        badge: "Can edit",
        stateLabel: null,
        stateTone: null,
        removable: true,
      },
    ],
    runtimeAccessRows: [],
  },
  {
    id: "public-link",
    title: "Public link enabled",
    description: "Anyone with the link can view; the public row joins current access.",
    publicEnabled: true,
    loadState: "ready",
    accessRequestRows: [],
    notebookAccessRows: [
      {
        id: "acl:owner",
        kind: "acl",
        label: "Kyle",
        detail: "kyle@notebook.local",
        badge: "Owner",
        stateLabel: null,
        stateTone: null,
        removable: false,
      },
      {
        id: "acl:public",
        kind: "acl",
        isPublic: true,
        label: "Public link",
        detail: "Anyone with the link",
        badge: "Can view",
        stateLabel: "Enabled",
        stateTone: "success",
        removable: true,
      },
    ],
    runtimeAccessRows: [],
  },
  {
    id: "invites-and-requests",
    title: "Pending invite + edit request",
    description: "A pending email invite and an edit-access request both need attention.",
    publicEnabled: false,
    loadState: "ready",
    accessRequestRows: [
      {
        id: "access-request:riley",
        kind: "access_request",
        label: "riley@example.com",
        detail: "Requested edit access",
        badge: "Can edit",
        stateLabel: "Requested",
        stateTone: "pending",
        removable: false,
      },
    ],
    notebookAccessRows: [
      {
        id: "acl:owner",
        kind: "acl",
        label: "Kyle",
        detail: "kyle@notebook.local",
        badge: "Owner",
        stateLabel: null,
        stateTone: null,
        removable: false,
      },
      {
        id: "invite:jamie",
        kind: "invite",
        label: "j...e@example.com",
        detail: "Pending invite",
        badge: "Can view",
        stateLabel: "Pending",
        stateTone: "pending",
        removable: true,
      },
    ],
    runtimeAccessRows: [],
  },
  {
    id: "runtime-peers",
    title: "Compute access",
    description: "A runtime peer has compute access, shown in its own ledger below people.",
    publicEnabled: false,
    loadState: "ready",
    accessRequestRows: [],
    notebookAccessRows: [
      {
        id: "acl:owner",
        kind: "acl",
        label: "Kyle",
        detail: "kyle@notebook.local",
        badge: "Owner",
        stateLabel: null,
        stateTone: null,
        removable: false,
      },
    ],
    runtimeAccessRows: [
      {
        id: "acl:runtime-peer",
        kind: "acl",
        isRuntimePeer: true,
        label: "aurora",
        detail: "Compute access for runtime peers",
        badge: "Runtime",
        stateLabel: null,
        stateTone: null,
        removable: false,
      },
    ],
  },
  {
    id: "loading",
    title: "Loading access",
    description: "Panel just opened; the access ledger fetch is still in flight.",
    publicEnabled: false,
    loadState: "loading",
    accessRequestRows: [],
    notebookAccessRows: [],
    runtimeAccessRows: [],
  },
  {
    id: "empty",
    title: "Owner only",
    description: "No collaborators, invites, or link access yet.",
    publicEnabled: false,
    loadState: "ready",
    accessRequestRows: [],
    notebookAccessRows: [],
    runtimeAccessRows: [],
  },
  {
    id: "error",
    title: "Load error",
    description: "The access list failed to load; the panel surfaces the host error inline.",
    publicEnabled: false,
    loadState: "error",
    accessRequestRows: [],
    notebookAccessRows: [],
    runtimeAccessRows: [],
    message: { kind: "error", text: "Unable to load access list" },
  },
  {
    id: "invite-form-error",
    title: "Invalid invite email",
    description: "The invite form rejects a malformed address before it reaches the host.",
    publicEnabled: false,
    loadState: "ready",
    accessRequestRows: [],
    notebookAccessRows: [
      {
        id: "acl:owner",
        kind: "acl",
        label: "Kyle",
        detail: "kyle@notebook.local",
        badge: "Owner",
        stateLabel: null,
        stateTone: null,
        removable: false,
      },
    ],
    runtimeAccessRows: [],
    formError: "Enter a valid email address.",
  },
  {
    id: "link-copied",
    title: "Link copied",
    description: "Copy-link confirmation message after a successful clipboard write.",
    publicEnabled: true,
    loadState: "ready",
    accessRequestRows: [],
    notebookAccessRows: [
      {
        id: "acl:owner",
        kind: "acl",
        label: "Kyle",
        detail: "kyle@notebook.local",
        badge: "Owner",
        stateLabel: null,
        stateTone: null,
        removable: false,
      },
      {
        id: "acl:public",
        kind: "acl",
        isPublic: true,
        label: "Public link",
        detail: "Anyone with the link",
        badge: "Can view",
        stateLabel: "Enabled",
        stateTone: "success",
        removable: true,
      },
    ],
    runtimeAccessRows: [],
    message: { kind: "info", text: "Link copied." },
  },
] as const;

export function SharingSheetExample() {
  return (
    <div className="not-prose grid gap-6 lg:grid-cols-2" data-elements-slot="sharing-sheet">
      {scenarios.map((scenario) => (
        <SharingSheetScenarioCard key={scenario.id} scenario={scenario} />
      ))}
    </div>
  );
}

function SharingSheetScenarioCard({ scenario }: { scenario: ShareScenario }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
      <div className="border-b border-fd-border px-4 py-3">
        <Eyebrow>{scenario.id}</Eyebrow>
        <h3 className="mt-1 text-sm font-semibold">{scenario.title}</h3>
        <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">{scenario.description}</p>
      </div>
      <div className="flex min-h-[520px] items-start justify-center bg-fd-muted/30 p-6">
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
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <SharingSheetPanel scenario={scenario} />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

function SharingSheetPanel({ scenario }: { scenario: ShareScenario }) {
  const copyLabel = scenario.message?.text === "Link copied." ? "Copied link" : "Copy link";
  const compactCopyLabel = scenario.message?.text === "Link copied." ? "Copied" : "Copy";
  const showInitialAccessLoading =
    scenario.loadState === "loading" && scenario.notebookAccessRows.length === 0;

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
          aria-label={copyLabel}
        >
          <Link2 className="size-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">{copyLabel}</span>
          <span className="sm:hidden">{compactCopyLabel}</span>
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
              {scenario.publicEnabled
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
        >
          {scenario.publicEnabled ? "Disable" : "Enable"}
        </Button>
      </section>

      <form className="grid gap-2 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_9rem_auto]">
        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground">Invite by email</Label>
          <Input
            type="email"
            defaultValue={scenario.formError ? "not-an-email" : ""}
            placeholder="name@example.com"
            autoComplete="email"
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground">Access</Label>
          <Select defaultValue="viewer">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="viewer">Can view</SelectItem>
              <SelectItem value="editor">Can edit</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" className="self-end gap-1.5">
          <Mail className="size-3.5" aria-hidden="true" />
          Invite
        </Button>
        {scenario.formError ? (
          <div
            className="col-span-full rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs leading-5 text-destructive"
            role="alert"
          >
            {scenario.formError}
          </div>
        ) : null}
      </form>

      {scenario.accessRequestRows.length > 0 ? (
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
              <span className="shrink-0 text-xs text-muted-foreground">
                {scenario.accessRequestRows.length} request
                {scenario.accessRequestRows.length === 1 ? "" : "s"}
              </span>
            </div>
            <ul className="divide-y divide-border/70">
              {scenario.accessRequestRows.map((row) => (
                <li
                  key={row.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5"
                >
                  <ShareRowIcon row={row} />
                  <div className="min-w-0">
                    <strong className="block truncate text-sm font-medium">{row.label}</strong>
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.detail}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">{row.badge}</span>
                    <ShareStateLabel tone={row.stateTone}>{row.stateLabel}</ShareStateLabel>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label={`Approve ${row.label}`}
                    >
                      <Check className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label={`Deny ${row.label}`}
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label={`Dismiss ${row.label}`}
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
          {scenario.notebookAccessRows.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {scenario.notebookAccessRows.length} listed
            </span>
          ) : null}
        </div>
        {showInitialAccessLoading ? (
          <div className="py-2 text-xs text-muted-foreground">Loading access...</div>
        ) : scenario.notebookAccessRows.length === 0 ? (
          <div className="py-2 text-xs text-muted-foreground">
            Only the owner can access this notebook.
          </div>
        ) : (
          <ul className="divide-y divide-border/70">
            {scenario.notebookAccessRows.map((row) => (
              <li
                key={row.id}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5"
              >
                <ShareRowIcon row={row} />
                <div className="min-w-0">
                  <strong className="block truncate text-sm font-medium">{row.label}</strong>
                  <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{row.badge}</span>
                  {row.stateLabel ? (
                    <ShareStateLabel tone={row.stateTone}>{row.stateLabel}</ShareStateLabel>
                  ) : null}
                  {row.removable ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label={`Remove ${row.label}`}
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

      {scenario.runtimeAccessRows.length > 0 ? (
        <>
          <Separator />
          <section className="px-4 py-3.5" aria-label="Compute access">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Compute access</h3>
              <span className="text-xs text-muted-foreground">
                {scenario.runtimeAccessRows.length} runtime peer
                {scenario.runtimeAccessRows.length === 1 ? "" : "s"}
              </span>
            </div>
            <ul className="divide-y divide-border/70">
              {scenario.runtimeAccessRows.map((row) => (
                <li
                  key={row.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5"
                >
                  <ShareRowIcon row={row} />
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

      {scenario.message ? (
        <div
          className={cn(
            "mx-4 mb-3.5 rounded-md border px-2.5 py-2 text-xs leading-5",
            scenario.message.kind === "error"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
          )}
        >
          {scenario.message.text}
        </div>
      ) : null}
    </>
  );
}

function ShareStateLabel({ tone, children }: { tone: ShareRowTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "text-xs font-semibold",
        tone === "success" && "text-emerald-700 dark:text-emerald-300",
        tone === "pending" && "text-amber-700 dark:text-amber-300",
        !tone && "text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function ShareRowIcon({ row }: { row: ShareRowFixture }) {
  const Icon: LucideIcon =
    row.kind === "invite"
      ? Mail
      : row.kind === "access_request"
        ? UserRound
        : row.isRuntimePeer
          ? ServerCog
          : row.isPublic
            ? Globe2
            : UserRound;
  return (
    <Icon
      className={cn(
        "size-4",
        row.isPublic ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground",
      )}
      aria-hidden="true"
    />
  );
}
