import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const args = parseArgs(process.argv.slice(2));
const operation = args._[0];
if (operation === "export") {
  await exportBackup();
} else if (operation === "restore") {
  await restoreBackup();
} else {
  throw new Error("usage: celld-backup.mjs <export|restore> [options]");
}

async function exportBackup() {
  const archiveDir = resolve(required(args, "archive"));
  await assertAbsent(archiveDir);
  await mkdir(resolve(archiveDir, "objects"), { recursive: true });

  const tables = await catalogTables();
  const catalog = {};
  const columns = {};
  for (const table of tables) {
    catalog[table] = await d1Rows(`SELECT * FROM ${quoteIdentifier(table)};`);
    columns[table] = await d1Rows(`PRAGMA table_info(${quoteIdentifier(table)});`);
  }
  const schema = await d1Rows(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '_litestream_%' AND name != 'd1_migrations' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name;",
  );

  const objectStore = applicationStore();
  const objects = [];
  const writtenDigests = new Set();
  let continuationToken;
  do {
    const page = await objectStore.client.send(
      new ListObjectsV2Command({
        Bucket: objectStore.bucket,
        Prefix: objectStore.prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const listed of page.Contents || []) {
      if (!listed.Key) continue;
      const response = await objectStore.client.send(
        new GetObjectCommand({ Bucket: objectStore.bucket, Key: listed.Key }),
      );
      const bytes = new Uint8Array(await response.Body.transformToByteArray());
      const digest = sha256(bytes);
      const file = `objects/${digest}`;
      if (!writtenDigests.has(digest)) {
        await writeFile(resolve(archiveDir, file), bytes, { flag: "wx", mode: 0o600 });
        writtenDigests.add(digest);
      }
      objects.push({
        key: listed.Key,
        file,
        size: bytes.byteLength,
        sha256: digest,
        etag: normalizeEtag(response.ETag),
        content_type: response.ContentType || null,
        cache_control: response.CacheControl || null,
        metadata: response.Metadata || {},
      });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  const catalogSql = catalogRestoreSql(catalog);
  const schemaBundle = { schema, columns };
  const manifest = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    database: required(args, "database"),
    catalog: {
      tables: Object.fromEntries(
        Object.entries(catalog).map(([name, rows]) => [name, rows.length]),
      ),
      json_file: "catalog.json",
      restore_sql_file: "catalog.sql",
      schema_file: "catalog-schema.json",
      sha256: sha256(Buffer.from(JSON.stringify(catalog))),
      schema_sha256: sha256(Buffer.from(JSON.stringify(schemaBundle))),
    },
    application_objects: {
      prefix: objectStore.prefix,
      count: objects.length,
      total_bytes: objects.reduce((total, object) => total + object.size, 0),
      entries: objects,
    },
  };

  await Promise.all([
    writeFile(resolve(archiveDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    }),
    writeFile(resolve(archiveDir, "catalog.sql"), catalogSql, { flag: "wx", mode: 0o600 }),
    writeFile(
      resolve(archiveDir, "catalog-schema.json"),
      `${JSON.stringify(schemaBundle, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    ),
    writeFile(resolve(archiveDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    }),
  ]);
  console.log(
    JSON.stringify({
      ok: true,
      operation: "export",
      archive: archiveDir,
      tables: manifest.catalog.tables,
      objects: objects.length,
      bytes: manifest.application_objects.total_bytes,
    }),
  );
}

async function restoreBackup() {
  const archiveDir = resolve(required(args, "archive"));
  const manifest = JSON.parse(await readFile(resolve(archiveDir, "manifest.json"), "utf8"));
  if (manifest.schema_version !== 1) {
    throw new Error(`unsupported backup schema ${manifest.schema_version}`);
  }
  const catalog = JSON.parse(
    await readFile(resolve(archiveDir, manifest.catalog.json_file), "utf8"),
  );
  const schemaBundle = JSON.parse(
    await readFile(resolve(archiveDir, manifest.catalog.schema_file), "utf8"),
  );
  assert(
    sha256(Buffer.from(JSON.stringify(catalog))) === manifest.catalog.sha256,
    "catalog checksum does not match the manifest",
  );
  assert(
    sha256(Buffer.from(JSON.stringify(schemaBundle))) === manifest.catalog.schema_sha256,
    "catalog schema checksum does not match the manifest",
  );

  await d1(["migrations", "apply", required(args, "database")]);
  await reconcileCatalogSchema(schemaBundle);
  const targetTables = await catalogTables();
  for (const table of targetTables) {
    const countRows = await d1Rows(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)};`);
    assert(Number(countRows[0]?.count || 0) === 0, `restore target table ${table} is not empty`);
  }
  await d1([
    "execute",
    required(args, "database"),
    "--file",
    resolve(archiveDir, manifest.catalog.restore_sql_file),
  ]);

  const objectStore = applicationStore();
  for (const entry of manifest.application_objects.entries) {
    const bytes = new Uint8Array(await readFile(resolve(archiveDir, entry.file)));
    assert(bytes.byteLength === entry.size, `size mismatch for ${entry.key}`);
    assert(sha256(bytes) === entry.sha256, `checksum mismatch for ${entry.key}`);
    await objectStore.client.send(
      new PutObjectCommand({
        Bucket: objectStore.bucket,
        Key: entry.key,
        Body: bytes,
        ContentType: entry.content_type || undefined,
        CacheControl: entry.cache_control || undefined,
        Metadata: entry.metadata,
      }),
    );
  }

  for (const [table, expectedRows] of Object.entries(catalog)) {
    const countRows = await d1Rows(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)};`);
    assert(
      Number(countRows[0]?.count || 0) === expectedRows.length,
      `row-count mismatch for ${table}`,
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      operation: "restore",
      archive: archiveDir,
      tables: manifest.catalog.tables,
      objects: manifest.application_objects.count,
    }),
  );
}

async function reconcileCatalogSchema({ schema, columns }) {
  const targetSchemaRows = await d1Rows(
    "SELECT type, name, tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '_litestream_%' ORDER BY name;",
  );
  const targetObjects = new Set(targetSchemaRows.map((row) => `${row.type}:${row.name}`));
  const sourceTables = schema.filter((row) => row.type === "table");
  for (const table of sourceTables) {
    if (!targetObjects.has(`table:${table.name}`)) {
      await d1(["execute", required(args, "database"), "--command", `${table.sql};`]);
      targetObjects.add(`table:${table.name}`);
    }
  }

  for (const table of sourceTables) {
    const targetColumns = new Set(
      (await d1Rows(`PRAGMA table_info(${quoteIdentifier(table.name)});`)).map(
        (column) => column.name,
      ),
    );
    for (const column of columns[table.name] || []) {
      if (targetColumns.has(column.name)) continue;
      assert(
        Number(column.pk || 0) === 0,
        `cannot add missing primary-key column ${table.name}.${column.name}`,
      );
      const definition = [
        quoteIdentifier(column.name),
        typeof column.type === "string" && column.type ? column.type : "BLOB",
      ];
      if (column.dflt_value !== null && column.dflt_value !== undefined) {
        definition.push("DEFAULT", String(column.dflt_value));
      }
      if (Number(column.notnull || 0) === 1) definition.push("NOT NULL");
      await d1([
        "execute",
        required(args, "database"),
        "--command",
        `ALTER TABLE ${quoteIdentifier(table.name)} ADD COLUMN ${definition.join(" ")};`,
      ]);
    }
  }

  for (const object of schema.filter((row) => row.type !== "table")) {
    if (targetObjects.has(`${object.type}:${object.name}`)) continue;
    await d1(["execute", required(args, "database"), "--command", `${object.sql};`]);
  }
}

async function catalogTables() {
  const rows = await d1Rows(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '_litestream_%' AND name != 'd1_migrations' ORDER BY name;",
  );
  return rows.map((row) => row.name).filter((name) => typeof name === "string");
}

async function d1Rows(sql) {
  const output = await d1(["execute", required(args, "database"), "--command", sql]);
  return parseLeadingJsonArray(output);
}

async function d1(commandArgs) {
  const celldBin = resolve(required(args, "celld-bin"));
  const project = resolve(required(args, "project"));
  const command = [
    "d1",
    ...commandArgs,
    project,
    "--bucket",
    required(args, "fleet-bucket"),
    "--endpoint",
    required(args, "fleet-endpoint"),
    "--region",
    args["fleet-region"] || process.env.AWS_REGION || "us-east-1",
  ];
  const child = spawn(celldBin, command, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolvePromise) => child.on("exit", resolvePromise));
  if (code !== 0)
    throw new Error(`celld ${commandArgs.slice(0, 2).join(" ")} failed: ${stderr}${stdout}`);
  return stdout;
}

function applicationStore() {
  const accessKeyId = process.env.NOTEBOOK_BACKUP_APPLICATION_ACCESS_KEY_ID;
  const secretAccessKey = process.env.NOTEBOOK_BACKUP_APPLICATION_SECRET_ACCESS_KEY;
  assert(
    accessKeyId && secretAccessKey,
    "application credentials require NOTEBOOK_BACKUP_APPLICATION_ACCESS_KEY_ID and NOTEBOOK_BACKUP_APPLICATION_SECRET_ACCESS_KEY",
  );
  const endpoint = required(args, "application-endpoint");
  const region = args["application-region"] || "us-east-1";
  return {
    bucket: required(args, "application-bucket"),
    prefix: normalizePrefix(args["application-prefix"] || ""),
    client: new S3Client({
      endpoint,
      region,
      forcePathStyle: args["application-force-path-style"] !== "false",
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

function catalogRestoreSql(catalog) {
  const preferredOrder = [
    "principal_profiles",
    "principal_account_links",
    "notebooks",
    "notebook_revisions",
    "notebook_blobs",
    "notebook_acl",
    "notebook_invites",
    "notebook_access_requests",
    "workstation_attach_jobs",
  ];
  const order = [
    ...preferredOrder.filter((table) => catalog[table]),
    ...Object.keys(catalog)
      .filter((table) => !preferredOrder.includes(table))
      .sort(),
  ];
  const statements = ["-- nteract notebook-cloud catalog restore; apply migrations first"];
  for (const table of order) {
    for (const row of catalog[table]) {
      const columns = Object.keys(row);
      if (columns.length === 0) continue;
      statements.push(
        `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map((column) => sqlLiteral(row[column])).join(", ")});`,
      );
    }
  }
  return `${statements.join("\n")}\n`;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("catalog contains a non-finite number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value !== "string") throw new Error(`unsupported catalog value ${typeof value}`);
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(value), `unsafe SQL identifier ${value}`);
  return `"${value}"`;
}

function parseLeadingJsonArray(output) {
  const start = output.indexOf("[");
  if (start === -1) throw new Error(`celld d1 output contained no JSON array: ${output}`);
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let index = start; index < output.length; index += 1) {
    const character = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(output.slice(start, index + 1));
    }
  }
  throw new Error("celld d1 output contained an incomplete JSON array");
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

async function assertAbsent(path) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`refusing to overwrite existing backup archive ${path}`);
}

function required(values, key) {
  const value = values[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function normalizePrefix(value) {
  const trimmed = value.replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

function normalizeEtag(value) {
  return typeof value === "string" ? value.replace(/^"|"$/g, "") : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
