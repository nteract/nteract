import type { Env } from "./cloudflare-types.ts";
import {
  ensureCatalogSchema,
  getNotebookAclRowsForPrincipal,
  registerWorkstation,
  setDefaultWorkstation,
} from "./storage.ts";
import { aclRowsCoverScope } from "./authorization.ts";
import { upsertWorkstationLease } from "./compute-session-index.ts";

export const MANAGED_PYTHON_WORKSTATION = "celld-preview-python";

export async function managedPythonOwnerCanExecute(env: Env, notebookId: string, owner: string) {
  return aclRowsCoverScope(await getNotebookAclRowsForPrincipal(env, notebookId, owner), "owner");
}

/** The authenticated attach job owns compute, which may differ from the notebook creator. */
export async function managedPythonSessionOwner(env: Env, notebookId: string, sessionId: string) {
  if (!env.DB) return null;
  await ensureCatalogSchema(env);
  const job = await env.DB.prepare(
    `SELECT owner_principal FROM workstation_attach_jobs
     WHERE id = ? AND notebook_id = ? AND workstation_id = ?`,
  )
    .bind(sessionId, notebookId, MANAGED_PYTHON_WORKSTATION)
    .first<{ owner_principal: string }>();
  return job?.owner_principal ?? null;
}

export function managedPythonStub(env: Env) {
  if (env.NOTEBOOK_CLOUD_PYTHON_PROVIDER !== "celld" || !env.PREVIEW_PYTHON_SESSIONS) return null;
  return env.PREVIEW_PYTHON_SESSIONS.get(
    env.PREVIEW_PYTHON_SESSIONS.idFromName("preview-python:deployment:v1"),
  );
}

/** Caller supplies the server-authenticated canonical principal. No browser credentials enter Python. */
export async function ensureManagedPythonWorkstation(env: Env, ownerPrincipal: string) {
  const provider = managedPythonStub(env);
  if (!provider || !env.DB) return null;
  const health = await provider.fetch(new Request("https://preview-python.internal/health"));
  if (!health.ok) return null;
  const status = (await health.json()) as { provider?: string; version?: number };
  if (status.provider !== "celld-pyodide" || status.version !== 1) return null;
  const workstation = await registerWorkstation(env, ownerPrincipal, {
    workstationId: MANAGED_PYTHON_WORKSTATION,
    displayName: "Python (sandboxed)",
    provider: "celld-pyodide",
    providerLabel: "Managed Python",
    defaultEnvironmentLabel: "Python · pandas · NumPy · Matplotlib",
    environmentPolicy: "Curated Pyodide environment",
    workingDirectory: "/home/pyodide",
    statusMessage: "Ready to start an isolated notebook session",
  });
  if (!workstation) return null;
  // The unique owner key makes this race-safe against simultaneous explicit
  // selection: a discovery request never overwrites an existing default.
  await setDefaultWorkstation(env, ownerPrincipal, workstation.workstation_id, {
    onlyIfAbsent: true,
  });
  await upsertWorkstationLease(env, ownerPrincipal, workstation.workstation_id, 90_000);
  return workstation;
}
