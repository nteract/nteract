import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { localClient } from "../widget-catalog/local-client.mjs";
import { chromium } from "@playwright/test";

export const dir = path.dirname(fileURLToPath(import.meta.url));
export const pages = path.resolve(dir, "../..");
export const outputDir = path.resolve(pages, ".context/widget-evals");
export const requirePages = createRequire(import.meta.url);
export const origin = process.env.EVAL_PAGES_ORIGIN ?? "http://localhost:9938";
if (new URL(origin).hostname !== "localhost" || new URL(origin).protocol !== "http:")
  throw Error("Use the loopback eval host.");
export async function session() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return { browser, page, ...(await localClient(page, origin)) };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
