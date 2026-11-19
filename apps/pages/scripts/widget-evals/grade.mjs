// Record what a reader can see after each button click, including Plot's
// pointer-driven tip marks. Native SVG titles do not cover the latter.
import { expect } from "@playwright/test";

const allDays = [
  ["Mon", 4],
  ["Tue", 7],
  ["Wed", 2],
];

async function readBars(frame, expected) {
  const bars = frame.locator('svg [aria-label="bar"] :is(rect,path)');
  const marks = [];
  await expect(bars)
    .toHaveCount(expected.length, { timeout: 2500 })
    .catch(() => {});
  for (const bar of await bars.all()) {
    const mark = await bar.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return {
        title: el.querySelector("title")?.textContent ?? "",
        width: box.width,
        height: box.height,
      };
    });
    if (!mark.title && mark.width && mark.height) {
      await bar.hover({ timeout: 2500 });
      const tip = frame.locator('svg [aria-label="tip"] text');
      await tip
        .first()
        .waitFor({ timeout: 500 })
        .catch(() => {});
      mark.title = (await tip.allTextContents()).join(" ");
    }
    marks.push(mark);
  }
  const ordered = expected.map(([day, value]) =>
    marks.find((mark) =>
      new RegExp("\\b" + day + "\\s*:\\s*" + value + "\\b", "i").test(mark.title),
    ),
  );
  const ok =
    marks.length === expected.length &&
    ordered.every((mark) => mark && mark.width > 0 && mark.height > 0) &&
    ordered.every((mark, i) =>
      ordered.every((other, j) => expected[i][1] <= expected[j][1] || mark.height > other.height),
    );
  return { marks, ok };
}

export async function grade(page, url) {
  const state = { ready: false, initial: false, filtered: false, restored: false };
  await page.goto(url);
  try {
    const view = page.locator(".pages-anywidget-view").first();
    await view.scrollIntoViewIfNeeded({ timeout: 7000 });
    await expect(view).toHaveAttribute("data-output-state", /^(ready|failed)$/, { timeout: 12000 });
    if ((await view.getAttribute("data-output-state")) !== "ready")
      return { ...state, error: await view.innerText() };
    state.ready = true;
    const frame = view.frameLocator("iframe");
    const recent = frame.getByRole("button", { name: "Last 2 days", exact: true });
    await recent.waitFor({ timeout: 3500 });
    state.before = await readBars(frame, allDays);
    state.initial = state.before.ok;
    await recent.click({ timeout: 3500 });
    state.after = await readBars(frame, allDays.slice(1));
    state.filtered = state.after.ok;
    await frame.getByRole("button", { name: "All days", exact: true }).click({ timeout: 3500 });
    state.back = await readBars(frame, allDays);
    state.restored = state.back.ok;
  } catch (error) {
    state.error = error.message.slice(0, 350);
  }
  return state;
}
