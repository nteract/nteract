import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PAGES_PORT || 9894);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid PAGES_PORT");
const origin = `http://localhost:${port}`;
let secret;
try {
  secret = (await readFile(path.join(app, "dist/.dev.vars"), "utf8")).match(
    /NOTEBOOK_CLOUD_APP_SESSION_SECRET=(.+)/,
  )?.[1];
} catch {}
secret ||= randomBytes(32).toString("hex");
await writeFile(
  path.join(app, "dist/.dev.vars"),
  [
    `NOTEBOOK_CLOUD_APP_SESSION_SECRET=${secret}`,
    "NOTEBOOK_CLOUD_LOCAL_OIDC=true",
    `PAGES_ASYNC_PERSISTENCE=${process.env.PAGES_ASYNC_PERSISTENCE === "true"}`,
    `PAGES_COMPACT_RECORDS=${process.env.PAGES_COMPACT_RECORDS === "true"}`,
    "NOTEBOOK_CLOUD_OIDC_FLOW=server",
    `NOTEBOOK_CLOUD_PUBLIC_ORIGIN=${origin}`,
    `NOTEBOOK_CLOUD_OIDC_ISSUER=${origin}/dev/oidc`,
    "NOTEBOOK_CLOUD_OIDC_CLIENT_ID=pages-next-local",
    "NOTEBOOK_CLOUD_OIDC_AUDIENCE=pages-next-local",
    "NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE=pages-next-local",
  ].join("\n") + "\n",
  { mode: 0o600 },
);
console.log(
  `Pages: ${origin}. Local OIDC signs in as dev@localhost. State persists under dist/.celld.`,
);
const child = spawn(
  "celld",
  ["dev", "dist", "--host", "127.0.0.1", "--port", String(port), "--no-watch", "--logs"],
  { cwd: app, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
