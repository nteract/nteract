import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function smokeOutputPath(value, env = process.env) {
  if (!value) return undefined;
  if (path.isAbsolute(value)) return value;
  return path.resolve(env.INIT_CWD || process.cwd(), value);
}

export async function saveSmokeScreenshot(page, screenshotPath) {
  if (!screenshotPath) return false;
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return true;
}

export function smokeJsonReportPath(name, env = process.env, date = new Date()) {
  const explicitPath = env.NOTEBOOK_CLOUD_SMOKE_REPORT;
  if (explicitPath) {
    return smokeOutputPath(explicitPath, env);
  }
  if (env.NOTEBOOK_CLOUD_WRITE_SMOKE_REPORT !== "1") {
    return undefined;
  }
  const timestamp = date.toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15);
  return smokeOutputPath(
    path.join(".context", "smokes", "reports", `${name}-${timestamp}.json`),
    env,
  );
}

export async function writeSmokeJsonReport(report, reportPath) {
  if (!reportPath) return false;
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return true;
}
