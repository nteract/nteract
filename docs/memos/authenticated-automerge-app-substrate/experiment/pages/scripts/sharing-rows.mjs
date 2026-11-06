// Browser assertions for rows in the shared sharing panel. Pages turns on
// `concealEmails`, so a row shows `a•••@localhost` until it is hovered or
// focused. The row's Remove action keeps the full email in its accessible
// name, which makes it the stable handle for one person's row.
import { expect } from "@playwright/test";
import { ROLE_LABELS } from "../viewer/sharing-roles.mjs";

/**
 * `alice@localhost` → `a•••@localhost`. Mirrors `concealEmail` in
 * src/components/sharing/SharingPanel.tsx; change both together.
 */
export const maskedEmail = (email) => `${email[0]}•••${email.slice(email.indexOf("@"))}`;

/**
 * Asserts a pending invite for `email` with `role` in the panel's Current
 * access list: masked at rest, full while hovered or while focus is inside
 * the row, masked again once the pointer or focus leaves. `panel` is the
 * sharing dialog Locator.
 */
export async function expectPendingInvite(panel, email, role, resource = "Page") {
  const page = panel.page();
  const access = panel.getByRole("region", { name: `Current ${resource} access`, exact: true });
  const remove = access.getByRole("button", { name: `Remove ${email}`, exact: true });
  const row = access.getByRole("listitem").filter({
    has: page.getByRole("button", { name: `Remove ${email}`, exact: true }),
  });
  const masked = row.getByText(maskedEmail(email), { exact: true });
  const full = row.getByText(email, { exact: true });
  const expectMasked = async () => {
    await expect(masked).toBeVisible();
    await expect(row).toHaveAttribute("data-concealed", "true");
    // A masked row drops its tooltip so the tooltip can't show the address.
    await expect(row).not.toHaveAttribute("title");
    await expect(access).not.toContainText(email);
  };
  const expectRevealed = async () => {
    await expect(full).toBeVisible();
    await expect(row).toHaveAttribute("data-concealed", "false");
  };

  await expect(row).toHaveCount(1);
  await expect(row.getByText(ROLE_LABELS[role], { exact: true })).toBeVisible();
  await expect(row.getByText("Pending", { exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await expectMasked();

  await row.hover();
  await expectRevealed();
  await expect(row).toHaveAttribute("title", email);
  await page.mouse.move(0, 0);
  await expectMasked();

  // A pending invite's only focusable control is Remove, so focus moves from
  // it straight out of the row.
  await remove.focus();
  await expectRevealed();
  await panel.getByLabel("Invite by email", { exact: true }).focus();
  await expectMasked();
  return row;
}
