import { mkdir } from "node:fs/promises";
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
