// Browser assertions for rows in the shared sharing panel. Pages turns on
// `concealEmails`, so a row shows `a•••@localhost` until it is hovered or
// focused. The row's Remove action keeps the full email in its accessible
// name, which makes it the stable handle for one person's row.
import { expect } from "@playwright/test";
import { ROLE_LABELS } from "../viewer/sharing-roles.mjs";

/** `alice@localhost` → `a•••@localhost`, matching the panel's mask. */
export const maskedEmail = (email) => `${email[0]}•••${email.slice(email.indexOf("@"))}`;

/**
 * Asserts a pending invite for `email` with `role` in the panel's Current
 * access list: masked at rest, full on hover, masked again after.
 * `scope` is a Page or a Locator holding one sharing panel.
 */
export async function expectPendingInvite(scope, email, role, resource = "Page") {
  const page = typeof scope.page === "function" ? scope.page() : scope;
  const access = scope.getByRole("region", { name: `Current ${resource} access`, exact: true });
  const row = access.getByRole("listitem").filter({
    has: page.getByRole("button", { name: `Remove ${email}`, exact: true }),
  });
  await expect(row).toHaveCount(1);
  await expect(row.getByText(maskedEmail(email), { exact: true })).toBeVisible();
  await expect(row.getByText(ROLE_LABELS[role], { exact: true })).toBeVisible();
  await expect(row.getByText("Pending", { exact: true })).toBeVisible();
  await expect(access).not.toContainText(email);
  await row.hover();
  await expect(row.getByText(email, { exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(row.getByText(maskedEmail(email), { exact: true })).toBeVisible();
  return row;
}
