import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Archive, Check, Copy, Loader2, Send, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSyncedTheme } from "@/hooks/useSyncedSettings";

interface PreparedDiagnosticsArchive {
  archive_id: string;
  archive_name: string;
  archive_size: number;
  files: string[];
  warning_bytes: number;
  max_upload_bytes: number;
}

interface DiagnosticsUploadResult {
  id: string;
  token: string;
  expires_at: string;
  uploaded_bytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

export default function App() {
  useSyncedTheme();

  const [prepared, setPrepared] = useState<PreparedDiagnosticsArchive | null>(null);
  const [result, setResult] = useState<DiagnosticsUploadResult | null>(null);
  const [busy, setBusy] = useState<"preparing" | "uploading" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const requiresSizeConfirmation = useMemo(
    () => prepared !== null && prepared.archive_size > prepared.warning_bytes,
    [prepared],
  );

  const cleanupPreparedArchive = useCallback((archiveId: string) => {
    void invoke("cleanup_prepared_diagnostics", { archiveId }).catch(() => {});
  }, []);

  const prepareArchive = useCallback(async () => {
    if (busy) return;
    if (prepared) {
      cleanupPreparedArchive(prepared.archive_id);
    }

    setBusy("preparing");
    setError(null);
    setResult(null);
    setCopied(false);

    try {
      const nextPrepared = await invoke<PreparedDiagnosticsArchive>("prepare_diagnostics_archive");
      setPrepared(nextPrepared);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [busy, cleanupPreparedArchive, prepared]);

  const uploadArchive = useCallback(async () => {
    if (!prepared || busy) return;

    setBusy("uploading");
    setError(null);
    setCopied(false);

    try {
      const uploadResult = await invoke<DiagnosticsUploadResult>("upload_prepared_diagnostics", {
        archiveId: prepared.archive_id,
      });
      setResult(uploadResult);
      setPrepared(null);
    } catch (err) {
      setPrepared(null);
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [busy, prepared]);

  const copyToken = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [result]);

  useEffect(() => {
    return () => {
      if (prepared) {
        cleanupPreparedArchive(prepared.archive_id);
      }
    };
  }, [cleanupPreparedArchive, prepared]);

  return (
    <div className="h-full overflow-auto bg-background text-foreground">
      <div className="mx-auto flex min-h-full max-w-xl flex-col gap-5 p-6">
        <header className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">Send Logs to Developer</h1>
            <p className="text-sm leading-5 text-muted-foreground">
              Uploads a diagnostics archive to nteract support and returns a token to share.
            </p>
          </div>
          <button
            type="button"
            onClick={() => getCurrentWindow().close()}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <section className="rounded-md border border-border bg-muted/30 p-4 text-sm leading-5 text-muted-foreground">
          Logs may include local file paths, environment names, package names, errors, and command
          output. Notebook contents are not intentionally included.
        </section>

        {error && (
          <section className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </section>
        )}

        {result ? (
          <section className="space-y-4 rounded-md border border-border p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <Check className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">Upload complete</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Uploaded {formatBytes(result.uploaded_bytes)}. Share this token with the
                  developer.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-2">
              <code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap px-1 text-sm">
                {result.token}
              </code>
              <button
                type="button"
                onClick={copyToken}
                className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </section>
        ) : (
          <section className="space-y-4 rounded-md border border-border p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md bg-sky-500/15 text-sky-600 dark:text-sky-400">
                <Archive className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">Diagnostics archive</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {prepared
                    ? `${prepared.archive_name} (${formatBytes(prepared.archive_size)})`
                    : "Prepare an archive before upload."}
                </p>
              </div>
            </div>

            {prepared && (
              <div className="space-y-3">
                {requiresSizeConfirmation && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                    This archive is larger than {formatBytes(prepared.warning_bytes)} and may take
                    longer to upload.
                  </div>
                )}

                <div className="max-h-40 overflow-auto rounded-md border border-border bg-muted/30">
                  <ul className="divide-y divide-border text-sm">
                    {prepared.files.map((file) => (
                      <li key={file} className="truncate px-3 py-2 font-mono text-xs">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={prepareArchive}
                disabled={busy !== null}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "preparing" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Archive className="h-4 w-4" />
                )}
                {prepared ? "Rebuild" : "Prepare"}
              </button>
              <button
                type="button"
                onClick={uploadArchive}
                disabled={!prepared || busy !== null}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-sky-600 px-3 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "uploading" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Send Logs
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
