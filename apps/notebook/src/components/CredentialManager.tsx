/**
 * CredentialManager — UI surface for adding, listing, editing, and deleting
 * machine-local credentials stored in the macOS Keychain.
 *
 * Per D-9, only humans can create credentials. This is the only place
 * credentials get created or modified in the application.
 *
 * Accessible from the global app Settings window and from the SandboxPanel
 * "Add credential" affordance.
 */
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { useNotebookHost } from "@nteract/notebook-host";

import type { CredentialMeta } from "@nteract/notebook-host";

// ── Helpers ───────────────────────────────────────────────────────────────

/** Validation: `^[a-zA-Z][a-zA-Z0-9_]*$` — must match the Rust validator. */
const CREDENTIAL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

function validateCredentialName(name: string): string | null {
  if (!name) return "Name is required.";
  if (!CREDENTIAL_NAME_RE.test(name))
    return "Name must start with a letter and contain only letters, digits, and underscores.";
  return null;
}

// ── Add / Edit dialog ─────────────────────────────────────────────────────

interface CredentialDialogProps {
  /** When set, we're editing an existing credential (cannot rename). */
  existing?: CredentialMeta;
  /** Pre-fill name (used when opened from "Add credential" in SandboxPanel). */
  initialName?: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function CredentialDialog({
  existing,
  initialName,
  open,
  onClose,
  onSaved,
}: CredentialDialogProps) {
  const host = useNotebookHost();
  const isEdit = Boolean(existing);

  const [name, setName] = React.useState(existing?.name ?? initialName ?? "");
  const [description, setDescription] = React.useState(existing?.description ?? "");
  const [value, setValue] = React.useState("");
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [valueError, setValueError] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Reset state when dialog opens
  React.useEffect(() => {
    if (open) {
      setName(existing?.name ?? initialName ?? "");
      setDescription(existing?.description ?? "");
      setValue("");
      setNameError(null);
      setValueError(null);
      setSubmitError(null);
      setSubmitting(false);
    }
  }, [open, existing, initialName]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    let valid = true;

    if (!isEdit) {
      const ne = validateCredentialName(name);
      setNameError(ne);
      if (ne) valid = false;
    }

    if (!value.trim()) {
      setValueError("Secret value is required.");
      valid = false;
    } else {
      setValueError(null);
    }

    if (!valid) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      if (isEdit) {
        await host.credentials.updateValue(name, value);
      } else {
        await host.credentials.add(name, description.trim() || null, value);
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit credential" : "Add credential"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the secret value for this credential. The name cannot be changed."
              : "Credentials are stored in your macOS Keychain and scoped to this user account."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4 py-2">
          {/* Name */}
          <div className="grid gap-1.5">
            <Label htmlFor="cred-name">Name</Label>
            <Input
              id="cred-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              disabled={isEdit}
              placeholder="my_api_key"
              autoComplete="off"
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? "cred-name-error" : undefined}
            />
            {nameError && (
              <p id="cred-name-error" className="text-destructive text-xs">
                {nameError}
              </p>
            )}
          </div>

          {/* Description */}
          <div className="grid gap-1.5">
            <Label htmlFor="cred-desc">
              Description{" "}
              <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id="cred-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="API key for the analytics service"
              autoComplete="off"
            />
          </div>

          {/* Secret value */}
          <div className="grid gap-1.5">
            <Label htmlFor="cred-value">{isEdit ? "New secret value" : "Secret value"}</Label>
            <Input
              id="cred-value"
              type="password"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setValueError(null);
              }}
              placeholder="••••••••"
              autoComplete="new-password"
              aria-invalid={Boolean(valueError)}
              aria-describedby={valueError ? "cred-value-error" : undefined}
            />
            {valueError && (
              <p id="cred-value-error" className="text-destructive text-xs">
                {valueError}
              </p>
            )}
          </div>

          {submitError && (
            <p role="alert" className="text-destructive text-sm">
              {submitError}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : isEdit ? "Save changes" : "Add credential"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Delete confirmation dialog ────────────────────────────────────────────

interface DeleteDialogProps {
  credential: CredentialMeta | null;
  onClose: () => void;
  onDeleted: () => void;
}

function DeleteDialog({ credential, onClose, onDeleted }: DeleteDialogProps) {
  const host = useNotebookHost();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!credential) {
      setError(null);
      setSubmitting(false);
    }
  }, [credential]);

  async function handleDelete() {
    if (!credential) return;
    setSubmitting(true);
    setError(null);
    try {
      await host.credentials.delete(credential.name);
      onDeleted();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={Boolean(credential)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete credential</DialogTitle>
          <DialogDescription>
            Any notebook referencing{" "}
            <code className="font-mono text-sm">{credential?.name}</code> will fail to launch a
            sandboxed kernel until a new credential with the same name is added.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={submitting}>
            {submitting ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export interface CredentialManagerProps {
  className?: string;
  /**
   * If set, the Add dialog opens immediately pre-filled with this name.
   * Used by the SandboxPanel "missing credential" affordance.
   */
  openAddWithName?: string;
  /** Called after openAddWithName flow is acknowledged (dialog closed). */
  onAddWithNameDismissed?: () => void;
}

export function CredentialManager({
  className,
  openAddWithName,
  onAddWithNameDismissed,
}: CredentialManagerProps) {
  const host = useNotebookHost();

  const [credentials, setCredentials] = React.useState<CredentialMeta[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [addOpen, setAddOpen] = React.useState(false);
  const [addInitialName, setAddInitialName] = React.useState<string | undefined>(undefined);
  const [editTarget, setEditTarget] = React.useState<CredentialMeta | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<CredentialMeta | null>(null);

  // Open add dialog when openAddWithName is provided
  React.useEffect(() => {
    if (openAddWithName) {
      setAddInitialName(openAddWithName);
      setAddOpen(true);
    }
  }, [openAddWithName]);

  async function refresh() {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await host.credentials.list();
      setCredentials(list);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleAddClose() {
    setAddOpen(false);
    setAddInitialName(undefined);
    onAddWithNameDismissed?.();
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Credentials</h2>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setAddInitialName(undefined);
            setAddOpen(true);
          }}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {loadError && (
        <p role="alert" className="text-destructive text-sm">
          {loadError}
        </p>
      )}

      {loading ? (
        <p className="text-muted-foreground text-sm">Loading credentials…</p>
      ) : credentials.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No credentials yet. Credentials are stored in your macOS Keychain and are scoped to this
          user account.
        </p>
      ) : (
        <ul className="divide-border divide-y rounded-md border" aria-label="Credentials list">
          {credentials.map((cred) => (
            <li key={cred.name} className="flex items-center justify-between px-3 py-2">
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-sm font-medium">{cred.name}</span>
                {cred.description && (
                  <span className="text-muted-foreground text-xs">{cred.description}</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Badge variant="secondary" className="text-xs">
                  keychain
                </Badge>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Edit ${cred.name}`}
                  onClick={() => setEditTarget(cred)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${cred.name}`}
                  onClick={() => setDeleteTarget(cred)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CredentialDialog
        open={addOpen}
        initialName={addInitialName}
        onClose={handleAddClose}
        onSaved={refresh}
      />

      <CredentialDialog
        open={Boolean(editTarget)}
        existing={editTarget ?? undefined}
        onClose={() => setEditTarget(null)}
        onSaved={refresh}
      />

      <DeleteDialog
        credential={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={refresh}
      />
    </div>
  );
}
