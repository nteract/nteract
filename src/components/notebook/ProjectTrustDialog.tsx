import { AlertTriangleIcon, FolderLockIcon, PackageIcon, ShieldAlertIcon } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import type { ProjectTrustState } from "runtimed";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RuntimeDecisionDialog } from "./RuntimeDecisionDialog";

export interface ProjectTrustDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectTrust: ProjectTrustState | null;
  onTrust: (directory: string) => void;
  onUseNotebookEnv: (directory: string, remember: boolean) => void;
  busy?: boolean;
  error?: string | null;
}

/** Dependencies shown before the list collapses into "+N more". */
export const PROJECT_TRUST_DEPENDENCY_LIMIT = 8;

const MANIFEST_LABELS: Record<string, { file: string; tool: string }> = {
  pyproject_toml: { file: "pyproject.toml", tool: "uv" },
  pixi_toml: { file: "pixi.toml", tool: "pixi" },
  environment_yml: { file: "environment.yml", tool: "conda" },
};

function manifestLabel(kind: string): { file: string; tool: string } {
  return MANIFEST_LABELS[kind] ?? { file: "project file", tool: "the package manager" };
}

type FlagTone = "warn" | "danger";

function RedFlag({
  testId,
  tone,
  title,
  items,
}: {
  testId: string;
  tone: FlagTone;
  title: string;
  items: readonly string[];
}) {
  const danger = tone === "danger";
  return (
    <div
      data-testid={testId}
      className={
        danger
          ? "rounded-md border border-destructive/40 bg-destructive/5 p-3"
          : "rounded-md border p-3"
      }
    >
      <div className="flex items-start gap-2">
        <AlertTriangleIcon
          className={
            danger
              ? "mt-0.5 size-4 shrink-0 text-destructive"
              : "mt-0.5 size-4 shrink-0 text-[var(--sev-warn)]"
          }
        />
        <div className="min-w-0 space-y-1">
          <p className={danger ? "text-sm font-medium text-destructive" : "text-sm font-medium"}>
            {title}
          </p>
          <ul className="space-y-0.5">
            {items.map((item) => (
              <li key={item} className="break-all font-mono text-xs text-muted-foreground">
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function PathRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="break-all font-mono text-xs">{children}</div>
    </div>
  );
}

function ScopeOption({
  id,
  label,
  path,
  checked,
  onSelect,
}: {
  id: string;
  label: string;
  path: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <input
        type="radio"
        id={id}
        name="project-trust-scope"
        value={path}
        checked={checked}
        onChange={onSelect}
        data-testid={id}
        className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <Label htmlFor={id} className="min-w-0 space-y-0.5">
        <span className="block">{label}</span>
        <span className="block break-all font-mono text-xs font-normal text-muted-foreground">
          {path}
        </span>
      </Label>
    </div>
  );
}

export function ProjectTrustDialog({
  open,
  onOpenChange,
  projectTrust,
  onTrust,
  onUseNotebookEnv,
  busy = false,
  error = null,
}: ProjectTrustDialogProps) {
  const projectDir = projectTrust?.project_dir ?? "";
  const repoRoot =
    projectTrust?.repo_root && projectTrust.repo_root !== projectDir
      ? projectTrust.repo_root
      : null;

  // Selection is scoped to the trust targets it was made for. A new
  // manifest, project dir, or repo root falls back to the project dir.
  const selectionScope = `${projectTrust?.manifest_path ?? ""}\0${projectDir}\0${repoRoot ?? ""}`;
  const [selection, setSelection] = useState<{ scope: string; dir: string } | null>(null);
  const selectedDir =
    selection && selection.scope === selectionScope && selection.dir ? selection.dir : projectDir;
  const [remember, setRemember] = useState(false);

  const handleTrust = useCallback(() => {
    if (!selectedDir) return;
    onTrust(selectedDir);
  }, [onTrust, selectedDir]);

  const handleUseNotebookEnv = useCallback(() => {
    if (!selectedDir) return;
    onUseNotebookEnv(selectedDir, remember);
  }, [onUseNotebookEnv, remember, selectedDir]);

  const { file, tool } = manifestLabel(projectTrust?.kind ?? "");
  const summary = projectTrust?.summary;
  const dependencies = summary?.dependencies ?? [];
  const shownDependencies = dependencies.slice(0, PROJECT_TRUST_DEPENDENCY_LIMIT);
  const hiddenDependencyCount = dependencies.length - shownDependencies.length;
  const disabled = busy || !selectedDir;

  return (
    <RuntimeDecisionDialog
      open={open}
      onOpenChange={onOpenChange}
      testId="project-trust-dialog"
      icon={<ShieldAlertIcon className="size-5 text-[var(--sev-warn)]" />}
      title="Trust this project folder?"
      description={`Project files can run code when the environment is prepared. Trusting this folder lets ${tool} use the files in it.`}
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            data-testid="project-trust-cancel-button"
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={handleUseNotebookEnv}
            disabled={disabled}
            data-testid="project-trust-notebook-env-button"
          >
            Use notebook environment
          </Button>
          <Button
            onClick={handleTrust}
            disabled={disabled}
            data-testid="project-trust-trust-button"
          >
            <FolderLockIcon className="mr-2 size-4" />
            {busy ? "Working..." : "Trust folder"}
          </Button>
        </>
      }
    >
      <div className="max-h-[360px] space-y-4 overflow-y-auto">
        {error && (
          <div
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
            role="alert"
            data-testid="project-trust-error"
          >
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="space-y-3">
          {projectTrust?.manifest_path && (
            <PathRow label={file}>
              <span data-testid="project-trust-manifest-path">{projectTrust.manifest_path}</span>
            </PathRow>
          )}
          {repoRoot ? (
            <fieldset className="space-y-1.5" disabled={busy}>
              <legend className="mb-1.5 text-xs text-muted-foreground">Folder to trust</legend>
              <ScopeOption
                id="project-trust-scope-project"
                label="Project folder"
                path={projectDir}
                checked={selectedDir === projectDir}
                onSelect={() => setSelection({ scope: selectionScope, dir: projectDir })}
              />
              <ScopeOption
                id="project-trust-scope-repo"
                label="Whole repository"
                path={repoRoot}
                checked={selectedDir === repoRoot}
                onSelect={() => setSelection({ scope: selectionScope, dir: repoRoot })}
              />
            </fieldset>
          ) : (
            projectDir && (
              <PathRow label="Folder to trust">
                <span data-testid="project-trust-folder">{projectDir}</span>
              </PathRow>
            )
          )}
        </div>

        {summary && summary.outside_directory.length > 0 && (
          <RedFlag
            testId="project-trust-flag-outside-directory"
            tone="danger"
            title="Uses files outside this folder"
            items={summary.outside_directory}
          />
        )}
        {summary?.build_backend && (
          <RedFlag
            testId="project-trust-flag-build-backend"
            tone="warn"
            title="Runs a build backend to install the project"
            items={[summary.build_backend]}
          />
        )}
        {summary && summary.non_registry_sources.length > 0 && (
          <RedFlag
            testId="project-trust-flag-non-registry-sources"
            tone="warn"
            title="Installs from git, path, or URL sources"
            items={summary.non_registry_sources}
          />
        )}
        {summary && summary.indexes_and_channels.length > 0 && (
          <RedFlag
            testId="project-trust-flag-indexes-and-channels"
            tone="warn"
            title="Uses custom package indexes or channels"
            items={summary.indexes_and_channels}
          />
        )}
        {summary && summary.activation_scripts.length > 0 && (
          <RedFlag
            testId="project-trust-flag-activation-scripts"
            tone="warn"
            title="Runs scripts on activation"
            items={summary.activation_scripts}
          />
        )}

        {shownDependencies.length > 0 && (
          <div data-testid="project-trust-dependencies">
            <h4 className="mb-2 text-sm font-medium text-muted-foreground">Dependencies</h4>
            <div className="divide-y rounded-md border">
              {shownDependencies.map((dep) => (
                <div key={dep} className="flex items-center gap-2 px-2 py-1.5">
                  <PackageIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-sm">{dep}</span>
                </div>
              ))}
              {hiddenDependencyCount > 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  +{hiddenDependencyCount} more
                </div>
              )}
            </div>
          </div>
        )}

        {summary?.environment_to_build && (
          <div className="space-y-1.5" data-testid="project-trust-environment-to-build">
            <p className="text-sm text-muted-foreground">Trusting will build this environment:</p>
            <pre className="whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
              {summary.environment_to_build}
            </pre>
          </div>
        )}

        <div className="flex items-start gap-2">
          <Checkbox
            id="project-trust-remember"
            checked={remember}
            onCheckedChange={(checked) => setRemember(checked === true)}
            disabled={busy}
            data-testid="project-trust-remember-checkbox"
            className="mt-0.5"
          />
          <Label htmlFor="project-trust-remember" className="space-y-0.5 font-normal">
            <span className="block">Remember for this folder</span>
            <span className="block text-xs text-muted-foreground">
              Applies when you use the notebook environment.
            </span>
          </Label>
        </div>
      </div>
    </RuntimeDecisionDialog>
  );
}
