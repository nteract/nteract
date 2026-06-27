#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const API_ENDPOINT = "https://api.cloudflare.com/client/v4";
const DEFAULT_HOURS = 24;

const options = parseArgs(process.argv.slice(2));
const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
if (!accountId) {
  fail("Set CLOUDFLARE_ACCOUNT_ID or pass --account-id <id>.");
}

const token = await cloudflareToken();
if (!token) {
  fail("Set CLOUDFLARE_API_TOKEN or run `wrangler login` first.");
}

const now = new Date();
const windowMs = options.minutes * 60 * 1000;
const start = new Date(now.getTime() - windowMs);
const scripts = options.scripts.length > 0 ? options.scripts : ["nteract-notebook-cloud"];

const [namespaces, workerReports, durableObjects] = await Promise.all([
  durableObjectNamespaces(accountId, token),
  Promise.all(scripts.map((script) => workerUsage(accountId, token, script, start, now))),
  durableObjectUsage(accountId, token, start, now),
]);

console.log(
  JSON.stringify(
    {
      window: {
        start: start.toISOString(),
        end: now.toISOString(),
        hours: options.minutes / 60,
        minutes: options.minutes,
      },
      workers: workerReports,
      durable_objects: durableObjects.map((item) => ({
        ...item,
        namespace: namespaces.get(item.namespace_id) ?? null,
      })),
    },
    null,
    2,
  ),
);

let warned = false;
for (const report of workerReports) {
  if (options.requestWarn !== null && report.requests >= options.requestWarn) {
    warned = true;
    console.error(
      `warning: ${report.script} has ${report.requests} requests >= ${options.requestWarn}`,
    );
  }
}
for (const report of durableObjects) {
  if (
    options.doDurationWarnSeconds !== null &&
    report.duration_seconds >= options.doDurationWarnSeconds
  ) {
    warned = true;
    console.error(
      `warning: Durable Object ${report.name} has ${report.duration_seconds.toFixed(
        1,
      )}s duration >= ${options.doDurationWarnSeconds}s`,
    );
  }
}
if (warned && options.failOnWarn) {
  process.exitCode = 2;
}

async function workerUsage(accountTag, apiToken, scriptName, datetimeStart, datetimeEnd) {
  const data = await graphql(apiToken, {
    query: `query GetWorkersAnalytics($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          workersInvocationsAdaptive(limit: 1000, filter: {
            scriptName: $scriptName,
            datetime_geq: $datetimeStart,
            datetime_leq: $datetimeEnd
          }) {
            sum { requests subrequests errors }
            dimensions { status }
            quantiles { cpuTimeP50 cpuTimeP99 }
          }
        }
      }
    }`,
    variables: {
      accountTag,
      datetimeStart: datetimeStart.toISOString(),
      datetimeEnd: datetimeEnd.toISOString(),
      scriptName,
    },
  });
  const rows = data.viewer.accounts[0]?.workersInvocationsAdaptive ?? [];
  return {
    script: scriptName,
    requests: sum(rows, (row) => row.sum.requests),
    subrequests: sum(rows, (row) => row.sum.subrequests),
    errors: sum(rows, (row) => row.sum.errors),
    statuses: groupSum(
      rows,
      (row) => row.dimensions.status,
      (row) => row.sum.requests,
    ),
    cpu_time_p99_ms_max: max(rows, (row) => row.quantiles?.cpuTimeP99 ?? 0),
  };
}

async function durableObjectUsage(accountTag, apiToken, datetimeStart, datetimeEnd) {
  const data = await graphql(apiToken, {
    query: `query GetDurableObjectsAnalytics($accountTag: string, $datetimeStart: string, $datetimeEnd: string) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd}) {
            sum { requests errors wallTime }
            dimensions { name namespaceId status type }
          }
          durableObjectsPeriodicGroups(limit: 1000, filter: {datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd}) {
            sum {
              cpuTime
              activeTime
              duration
              inboundWebsocketMsgCount
              outboundWebsocketMsgCount
              rowsRead
              rowsWritten
            }
            dimensions { name namespaceId }
          }
        }
      }
    }`,
    variables: {
      accountTag,
      datetimeStart: datetimeStart.toISOString(),
      datetimeEnd: datetimeEnd.toISOString(),
    },
  });
  const account = data.viewer.accounts[0] ?? {};
  const invocationRows = account.durableObjectsInvocationsAdaptiveGroups ?? [];
  const periodicRows = account.durableObjectsPeriodicGroups ?? [];
  const byKey = new Map();
  for (const row of invocationRows) {
    const item = durableObjectReport(byKey, row.dimensions.namespaceId, row.dimensions.name);
    item.requests += row.sum.requests ?? 0;
    item.errors += row.sum.errors ?? 0;
    item.wall_time_ms += row.sum.wallTime ?? 0;
    incrementNested(item.statuses, row.dimensions.status, row.sum.requests ?? 0);
    incrementNested(item.types, row.dimensions.type, row.sum.requests ?? 0);
  }
  for (const row of periodicRows) {
    const key = `${row.dimensions.namespaceId}\n${row.dimensions.name}`;
    const item =
      byKey.get(key) ?? durableObjectReport(byKey, row.dimensions.namespaceId, row.dimensions.name);
    item.duration_seconds += row.sum.duration ?? 0;
    item.cpu_time_ms += row.sum.cpuTime ?? 0;
    item.active_time_ms += row.sum.activeTime ?? 0;
    item.inbound_websocket_messages += row.sum.inboundWebsocketMsgCount ?? 0;
    item.outbound_websocket_messages += row.sum.outboundWebsocketMsgCount ?? 0;
    item.rows_read += row.sum.rowsRead ?? 0;
    item.rows_written += row.sum.rowsWritten ?? 0;
  }
  return [...byKey.values()].sort((a, b) => b.duration_seconds - a.duration_seconds);
}

function durableObjectReport(map, namespaceId, name) {
  const key = `${namespaceId}\n${name}`;
  const existing = map.get(key);
  if (existing) return existing;
  const created = {
    namespace_id: namespaceId,
    name,
    requests: 0,
    errors: 0,
    wall_time_ms: 0,
    duration_seconds: 0,
    cpu_time_ms: 0,
    active_time_ms: 0,
    inbound_websocket_messages: 0,
    outbound_websocket_messages: 0,
    rows_read: 0,
    rows_written: 0,
    statuses: {},
    types: {},
  };
  map.set(key, created);
  return created;
}

async function durableObjectNamespaces(accountId, apiToken) {
  const response = await fetch(
    `${API_ENDPOINT}/accounts/${encodeURIComponent(accountId)}/workers/durable_objects/namespaces`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );
  if (!response.ok) {
    return new Map();
  }
  const body = await response.json();
  const namespaces = new Map();
  for (const row of body.result ?? []) {
    namespaces.set(row.id, {
      name: row.name,
      script: row.script,
      class: row.class,
    });
  }
  return namespaces;
}

async function graphql(apiToken, body) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare GraphQL request failed: HTTP ${response.status}`);
  }
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`Cloudflare GraphQL returned errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function cloudflareToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return process.env.CLOUDFLARE_API_TOKEN;
  }
  try {
    const config = await readFile(
      path.join(os.homedir(), ".config", ".wrangler", "config", "default.toml"),
      "utf8",
    );
    const match = config.match(/^oauth_token\s*=\s*"([^"]+)"/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function parseArgs(args) {
  const parsed = {
    accountId: null,
    doDurationWarnSeconds: numberEnv("CLOUDFLARE_DO_DURATION_WARN_SECONDS"),
    failOnWarn: false,
    minutes: DEFAULT_HOURS * 60,
    requestWarn: numberEnv("CLOUDFLARE_REQUEST_WARN"),
    scripts: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[index + 1];
      if (!value) fail(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--account-id") {
      parsed.accountId = next();
    } else if (arg === "--") {
      continue;
    } else if (arg === "--hours") {
      parsed.minutes = positiveNumber("--hours", next()) * 60;
    } else if (arg === "--minutes") {
      parsed.minutes = positiveNumber("--minutes", next());
    } else if (arg === "--script") {
      parsed.scripts.push(next());
    } else if (arg === "--request-warn") {
      parsed.requestWarn = positiveNumber("--request-warn", next());
    } else if (arg === "--do-duration-warn-seconds") {
      parsed.doDurationWarnSeconds = positiveNumber("--do-duration-warn-seconds", next());
    } else if (arg === "--fail-on-warn") {
      parsed.failOnWarn = true;
    } else {
      fail(`Unknown option: ${arg}`);
    }
  }
  return parsed;
}

function numberEnv(name) {
  const value = process.env[name];
  return value ? positiveNumber(name, value) : null;
}

function positiveNumber(label, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    fail(`${label} must be a positive number`);
  }
  return value;
}

function sum(rows, value) {
  return rows.reduce((total, row) => total + (value(row) ?? 0), 0);
}

function max(rows, value) {
  return rows.reduce((largest, row) => Math.max(largest, value(row) ?? 0), 0);
}

function groupSum(rows, key, value) {
  const groups = {};
  for (const row of rows) {
    incrementNested(groups, key(row), value(row) ?? 0);
  }
  return groups;
}

function incrementNested(target, key, value) {
  target[key || "unknown"] = (target[key || "unknown"] ?? 0) + value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
