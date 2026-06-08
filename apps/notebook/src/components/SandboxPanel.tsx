/**
 * SandboxPanel — per-notebook sandbox profile editor.
 *
 * Shown as a dropdown sheet from the notebook toolbar. Lets the user:
 * - Enable/disable the sandbox
 * - Manage CredentialRef entries (add, configure routes, remove)
 * - Manage allowed_domains
 *
 * Changes are written via `setSandboxProfile` which routes through
 * `setMetadataSnapshot` → WASM Automerge → daemon relay. All collaborators
 * editing the same notebook see updates live.
 *
 * Per D-10, there are no real-time accept/reject prompts. The profile is
 * pre-declared and the daemon picks it up on next kernel launch.
 */
import { AlertCircle, CheckCircle2, Plus, Shield, Trash2, X } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { CredentialMeta } from "@nteract/notebook-host";
import { useNotebookHost } from "@nteract/notebook-host";

import { setSandboxProfile, useSandboxProfile } from "~/lib/notebook-metadata";
import type { CredentialRef, InjectionKind, RouteRule, SandboxProfile } from "@/sandbox/types";
import { emptySandboxProfile, validateSandboxProfile } from "@/sandbox/types";
import { CredentialManager } from "./CredentialManager";

// ── Route rule dialog ──────────────────────────────────────────────────────

const INJECTION_LABELS: Record<InjectionKind, string> = {
  header: "Header",
  basic_auth: "Basic Auth",
  query: "Query parameter",
};

interface RouteDialogProps {
  /** When set, editing an existing route. */
  existing?: RouteRule;
  open: boolean;
  onClose: () => void;
  onSaved: (route: RouteRule) => void;
}

function RouteDialog({ existing, open, onClose, onSaved }: RouteDialogProps) {
  const [host, setHost] = React.useState(existing?.host ?? "");
  const [injectAs, setInjectAs] = React.useState<InjectionKind>(existing?.inject_as ?? "header");
  const [header, setHeader] = React.useState(existing?.header ?? "");
  const [template, setTemplate] = React.useState(
    existing?.template ?? "Bearer {credential}",
  );
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (open) {
      setHost(existing?.host ?? "");
      setInjectAs(existing?.inject_as ?? "header");
      setHeader(existing?.header ?? "");
      setTemplate(existing?.template ?? "Bearer {credential}");
      setErrors({});
    }
  }, [open, existing]);

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!host.trim()) errs.host = "Host is required.";
    if (injectAs === "header" && !header.trim()) errs.header = "Header name is required.";
    if (!template.includes("{credential}"))
      errs.template = "Template must contain `{credential}`.";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSave() {
    if (!validate()) return;
    const route: RouteRule = {
      host: host.trim(),
      inject_as: injectAs,
      template,
      ...(injectAs === "header" ? { header: header.trim() } : {}),
    };
    onSaved(route);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit route" : "Add route"}</DialogTitle>
          <DialogDescription>
            Configure how this credential is injected for a specific upstream host.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="route-host">Host</Label>
            <Input
              id="route-host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="api.example.com"
            />
            {errors.host && <p className="text-destructive text-xs">{errors.host}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="route-inject">Injection type</Label>
            <Select
              value={injectAs}
              onValueChange={(v) => setInjectAs(v as InjectionKind)}
            >
              <SelectTrigger id="route-inject">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(INJECTION_LABELS) as InjectionKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {INJECTION_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {injectAs === "header" && (
            <div className="grid gap-1.5">
              <Label htmlFor="route-header">Header name</Label>
              <Input
                id="route-header"
                value={header}
                onChange={(e) => setHeader(e.target.value)}
                placeholder="Authorization"
              />
              {errors.header && <p className="text-destructive text-xs">{errors.header}</p>}
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="route-template">Template</Label>
            <Input
              id="route-template"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder="Bearer {credential}"
            />
            <p className="text-muted-foreground text-xs">
              Must contain <code>{"{credential}"}</code> — replaced with the secret at runtime.
            </p>
            {errors.template && <p className="text-destructive text-xs">{errors.template}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave}>Save route</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Add credential reference dialog ───────────────────────────────────────

interface AddCredRefDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: (ref: CredentialRef) => void;
  /** Available credentials from the keychain (for autocomplete). */
  available: CredentialMeta[];
  /** Names already referenced in the profile. */
  existingNames: Set<string>;
}

function AddCredRefDialog({
  open,
  onClose,
  onAdded,
  available,
  existingNames,
}: AddCredRefDialogProps) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [nameError, setNameError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setNameError(null);
    }
  }, [open]);

  // Auto-fill description when name matches a known credential
  React.useEffect(() => {
    const match = available.find((c) => c.name === name);
    if (match?.description) setDescription(match.description);
  }, [name, available]);

  function handleAdd() {
    if (!name.trim()) {
      setNameError("Name is required.");
      return;
    }
    if (existingNames.has(name.trim())) {
      setNameError("This credential is already referenced by this notebook.");
      return;
    }
    onAdded({ name: name.trim(), description: description.trim() || undefined, routes: [] });
    onClose();
  }

  const suggestions = available.filter(
    (c) => !existingNames.has(c.name) && c.name.toLowerCase().includes(name.toLowerCase()),
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add credential reference</DialogTitle>
          <DialogDescription>
            Reference a credential by name. The credential must exist on every machine that runs
            this notebook with the sandbox enabled.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="cref-name">Credential name</Label>
            <Input
              id="cref-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              placeholder="my_api_key"
              list="cred-suggestions"
              autoComplete="off"
            />
            <datalist id="cred-suggestions">
              {suggestions.map((c) => (
                <option key={c.name} value={c.name} />
              ))}
            </datalist>
            {nameError && <p className="text-destructive text-xs">{nameError}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cref-desc">
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id="cref-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="API key for the analytics service"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleAdd}>Add reference</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export interface SandboxPanelProps {
  className?: string;
}

export function SandboxPanel({ className }: SandboxPanelProps) {
  const host = useNotebookHost();
  const savedProfile = useSandboxProfile();

  // Local draft — only written back on explicit Save.
  const [draft, setDraft] = React.useState<SandboxProfile>(
    () => savedProfile ?? emptySandboxProfile(),
  );
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  // Keychain credentials for presence indicators and autocomplete
  const [keychainCreds, setKeychainCreds] = React.useState<CredentialMeta[]>([]);
  React.useEffect(() => {
    host.credentials.list().then(setKeychainCreds).catch(() => {});
  }, [host]);

  // Keep draft in sync when external writes arrive (e.g. from another peer)
  React.useEffect(() => {
    setDraft(savedProfile ?? emptySandboxProfile());
  }, [savedProfile]);

  // Dialogs
  const [addCredRefOpen, setAddCredRefOpen] = React.useState(false);
  const [routeDialogState, setRouteDialogState] = React.useState<{
    credName: string;
    routeIndex: number | null;
  } | null>(null);
  const [credManagerOpen, setCredManagerOpen] = React.useState(false);
  const [missingCredForAdd, setMissingCredForAdd] = React.useState<string | undefined>();

  const validationErrors = validateSandboxProfile(draft);
  const isValid = validationErrors.length === 0;
  const existingCredNames = new Set(draft.credentials.map((c) => c.name));

  function patchDraft(patch: Partial<SandboxProfile>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function updateCred(index: number, patch: Partial<CredentialRef>) {
    const updated = draft.credentials.map((c, i) => (i === index ? { ...c, ...patch } : c));
    patchDraft({ credentials: updated });
  }

  function removeCred(index: number) {
    patchDraft({ credentials: draft.credentials.filter((_, i) => i !== index) });
  }

  function addRoute(credName: string, route: RouteRule) {
    const ci = draft.credentials.findIndex((c) => c.name === credName);
    if (ci === -1) return;
    const updated = [...draft.credentials];
    updated[ci] = { ...updated[ci], routes: [...updated[ci].routes, route] };
    patchDraft({ credentials: updated });
  }

  function updateRoute(credName: string, routeIndex: number, route: RouteRule) {
    const ci = draft.credentials.findIndex((c) => c.name === credName);
    if (ci === -1) return;
    const updated = [...draft.credentials];
    const newRoutes = updated[ci].routes.map((r, i) => (i === routeIndex ? route : r));
    updated[ci] = { ...updated[ci], routes: newRoutes };
    patchDraft({ credentials: updated });
  }

  function removeRoute(credName: string, routeIndex: number) {
    const ci = draft.credentials.findIndex((c) => c.name === credName);
    if (ci === -1) return;
    const updated = [...draft.credentials];
    updated[ci] = {
      ...updated[ci],
      routes: updated[ci].routes.filter((_, i) => i !== routeIndex),
    };
    patchDraft({ credentials: updated });
  }

  async function handleSave() {
    if (!isValid) return;
    setSaving(true);
    setSaveError(null);
    try {
      await setSandboxProfile(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function credPresent(name: string): boolean {
    return keychainCreds.some((c) => c.name === name);
  }

  const routeDialogCred = routeDialogState
    ? draft.credentials.find((c) => c.name === routeDialogState.credName)
    : undefined;
  const routeDialogRoute =
    routeDialogState?.routeIndex != null
      ? routeDialogCred?.routes[routeDialogState.routeIndex]
      : undefined;

  return (
    <div className={cn("flex flex-col gap-6 p-4", className)}>
      {/* Header */}
      <div className="flex items-center gap-2">
        <Shield className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Network sandbox</h2>
        <Badge variant={draft.enabled ? "default" : "secondary"} className="text-xs">
          {draft.enabled ? "Enabled" : "Off"}
        </Badge>
      </div>

      {/* Enable toggle */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Enable sandbox</p>
          <p className="text-muted-foreground text-xs">
            Routes credential injection through nono at kernel launch.
          </p>
        </div>
        <Switch
          checked={draft.enabled}
          onCheckedChange={(checked) => patchDraft({ enabled: checked })}
          aria-label="Enable sandbox"
        />
      </div>

      {/* Credentials in use */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">Credentials in use</h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddCredRefOpen(true)}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add reference
          </Button>
        </div>

        {draft.credentials.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No credentials referenced. Add a reference to inject a credential into kernel network
            calls.
          </p>
        ) : (
          <ul className="divide-border divide-y rounded-md border" aria-label="Credential references">
            {draft.credentials.map((cred, ci) => {
              const present = credPresent(cred.name);
              return (
                <li key={cred.name} className="flex flex-col gap-2 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {present ? (
                        <CheckCircle2
                          className="h-4 w-4 text-green-500"
                          aria-label="Credential present on this machine"
                        />
                      ) : (
                        <AlertCircle
                          className="h-4 w-4 text-destructive"
                          aria-label="Credential missing on this machine"
                        />
                      )}
                      <span className="font-mono text-sm font-medium">{cred.name}</span>
                      {cred.description && (
                        <span className="text-muted-foreground text-xs">{cred.description}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {!present && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive border-destructive hover:text-destructive text-xs"
                          onClick={() => {
                            setMissingCredForAdd(cred.name);
                            setCredManagerOpen(true);
                          }}
                        >
                          Add credential
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove reference to ${cred.name}`}
                        onClick={() => removeCred(ci)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* Routes */}
                  {cred.routes.length > 0 && (
                    <ul className="ml-6 space-y-1">
                      {cred.routes.map((route, ri) => (
                        <li key={ri} className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">
                            <code className="text-foreground">{route.host}</code>
                            {" → "}
                            {INJECTION_LABELS[route.inject_as]}
                            {route.header && (
                              <span>
                                {" "}
                                (<code>{route.header}</code>)
                              </span>
                            )}
                          </span>
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 text-xs"
                              onClick={() =>
                                setRouteDialogState({ credName: cred.name, routeIndex: ri })
                              }
                            >
                              Edit
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              aria-label="Remove route"
                              onClick={() => removeRoute(cred.name, ri)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground ml-6 h-6 w-fit text-xs"
                    onClick={() =>
                      setRouteDialogState({ credName: cred.name, routeIndex: null })
                    }
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    Add route
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Allowed domains */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">Allowed domains</h3>
        </div>
        <AllowedDomainsEditor
          domains={draft.allowed_domains}
          onChange={(domains) => patchDraft({ allowed_domains: domains })}
        />
      </section>

      {/* Validation errors */}
      {validationErrors.length > 0 && (
        <ul
          role="alert"
          aria-label="Validation errors"
          className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {validationErrors.map((e) => (
            <li key={e.field}>
              <span className="font-mono">{e.field}:</span> {e.message}
            </li>
          ))}
        </ul>
      )}

      {/* Save */}
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving || !isValid || saved}>
          {saving ? "Saving…" : saved ? "Saved" : "Save profile"}
        </Button>
        {saveError && <p className="text-destructive text-sm">{saveError}</p>}
      </div>

      {/* Dialogs */}
      <AddCredRefDialog
        open={addCredRefOpen}
        onClose={() => setAddCredRefOpen(false)}
        onAdded={(ref) => patchDraft({ credentials: [...draft.credentials, ref] })}
        available={keychainCreds}
        existingNames={existingCredNames}
      />

      {routeDialogState && (
        <RouteDialog
          open={true}
          existing={routeDialogRoute}
          onClose={() => setRouteDialogState(null)}
          onSaved={(route) => {
            if (routeDialogState.routeIndex != null) {
              updateRoute(routeDialogState.credName, routeDialogState.routeIndex, route);
            } else {
              addRoute(routeDialogState.credName, route);
            }
            updateCred(
              draft.credentials.findIndex((c) => c.name === routeDialogState.credName),
              {},
            );
          }}
        />
      )}

      {/* Credential manager sheet (for missing credential affordance) */}
      <Dialog open={credManagerOpen} onOpenChange={(v) => !v && setCredManagerOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Credential manager</DialogTitle>
          </DialogHeader>
          <CredentialManager
            openAddWithName={missingCredForAdd}
            onAddWithNameDismissed={() => {
              setMissingCredForAdd(undefined);
              // Refresh keychain list after adding
              host.credentials.list().then(setKeychainCreds).catch(() => {});
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Allowed domains editor ─────────────────────────────────────────────────

interface AllowedDomainsEditorProps {
  domains: string[];
  onChange: (domains: string[]) => void;
}

function AllowedDomainsEditor({ domains, onChange }: AllowedDomainsEditorProps) {
  const [input, setInput] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  function addDomain() {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (domains.includes(trimmed)) {
      setError("Domain already in the list.");
      return;
    }
    onChange([...domains, trimmed]);
    setInput("");
    setError(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
          }}
          placeholder="api.example.com"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addDomain();
            }
          }}
        />
        <Button variant="outline" onClick={addDomain}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
      {domains.length === 0 ? (
        <p className="text-muted-foreground text-sm">No domains allowed yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Allowed domains">
          {domains.map((domain) => (
            <li key={domain}>
              <Badge variant="secondary" className="flex items-center gap-1 pr-1">
                {domain}
                <button
                  type="button"
                  aria-label={`Remove ${domain}`}
                  onClick={() => onChange(domains.filter((d) => d !== domain))}
                  className="hover:text-destructive ml-0.5 rounded-sm"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
