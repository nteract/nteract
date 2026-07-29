import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { NOTEBOOK_ACCOUNT_MENU_TRIGGER_CLASS, NotebookAccountMenu } from "../NotebookAccountMenu";
import type { NotebookActorIdentity } from "../capabilities";

function actor(overrides: Partial<NotebookActorIdentity> = {}): NotebookActorIdentity {
  return {
    id: "user:anaconda:leslie",
    label: "Leslie D.",
    detail: null,
    kind: "human",
    ...overrides,
  };
}

function renderMenu(props: Partial<Parameters<typeof NotebookAccountMenu>[0]> = {}) {
  return render(
    <NotebookAccountMenu actor={actor()} {...props}>
      <DropdownMenuItem>Sign out</DropdownMenuItem>
    </NotebookAccountMenu>,
  );
}

function trigger(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    '[data-slot="notebook-account-menu-trigger"]',
  );
  expect(element).not.toBeNull();
  return element!;
}

describe("NotebookAccountMenu", () => {
  it("renders the avatar as the menu trigger with no visible caret or label", () => {
    // The avatar IS the affordance: the toolbar gains a menu without gaining
    // chrome, so the trigger stays icon-only at every width.
    const { container } = renderMenu();
    const element = trigger(container);

    expect(element.querySelector('[data-slot="notebook-actor-avatar"]')).not.toBeNull();

    const clone = element.cloneNode(true) as HTMLElement;
    for (const hidden of Array.from(
      clone.querySelectorAll('.sr-only, [data-slot="avatar-fallback"]'),
    )) {
      hidden.remove();
    }
    expect(clone.textContent?.trim()).toBe("");
  });

  it("keeps the trigger quiet: borderless, shadow-free, and not a pill", () => {
    // Mirrors the NotebookConnectionIdentity quiet-chrome guardrail so the
    // account menu cannot reintroduce the raised-bubble look on either surface.
    const { container } = renderMenu();
    const element = trigger(container);

    expect(element.classList.contains("rounded-md")).toBe(true);
    expect(element.classList.contains("rounded-full")).toBe(false);
    expect(element.classList.contains("border")).toBe(false);
    expect(element.querySelector('[data-slot="notebook-actor-avatar"]')?.classList).toContain(
      "border-0",
    );
    for (const node of [element, ...Array.from(element.querySelectorAll("*"))]) {
      for (const token of Array.from(node.classList)) {
        expect(token.startsWith("shadow")).toBe(false);
      }
    }
  });

  it("exposes the actor label as accessible copy, not as avatar initials", () => {
    // Without aria-hidden a screen reader would read "LD Leslie D.".
    const { container } = renderMenu();
    const element = trigger(container);

    expect(
      element.querySelector('[data-slot="notebook-actor-avatar"]')?.closest("[aria-hidden]"),
    ).not.toBeNull();
    expect(element.querySelector(".sr-only")?.textContent).toBe("Leslie D.");
  });

  it("prefers host-composed detail copy over the bare label", () => {
    // The notebook view composes identity + connection state so the trigger
    // never asserts more than the host measures.
    const { container } = renderMenu({ detail: "Leslie D. — Connected" });
    const element = trigger(container);

    expect(element.title).toBe("Leslie D. — Connected");
    expect(element.querySelector(".sr-only")?.textContent).toBe("Leslie D. — Connected");
  });

  it("omits the status dot unless the host asks for one", () => {
    // The dot means a live notebook room; the notebook home does not measure
    // one, so it must not appear there.
    const { container: quiet } = renderMenu();
    expect(quiet.querySelector('[data-slot="avatar-badge"]')).toBeNull();

    const { container: withDot } = renderMenu({
      showStatus: true,
      statusClassName: "bg-emerald-500",
    });
    const badge = withDot.querySelector('[data-slot="avatar-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains("bg-emerald-500")).toBe(true);
  });

  it("opens the menu and renders host-owned actions with the identity header", async () => {
    // Account actions are host policy (session/dev-auth/cache clearing), so
    // the component owns the frame and the host owns the items.
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { container } = render(
      <NotebookAccountMenu actor={actor()} accountDetail="leslie@anaconda.com">
        <DropdownMenuItem onSelect={onSelect}>Sign out</DropdownMenuItem>
      </NotebookAccountMenu>,
    );

    await user.click(trigger(container));

    expect(screen.getByText("leslie@anaconda.com")).toBeTruthy();
    const item = screen.getByRole("menuitem", { name: "Sign out" });

    await user.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("shares one exported trigger treatment so the two surfaces cannot drift", () => {
    // The regression this component exists to prevent: the notebook home and
    // the notebook view previously drew self-identity from unrelated systems
    // (a hand-rolled span vs the shared Avatar). Both now render the same
    // trigger class.
    const { container } = renderMenu();
    const element = trigger(container);

    for (const token of NOTEBOOK_ACCOUNT_MENU_TRIGGER_CLASS.split(/\s+/)) {
      expect(element.classList.contains(token)).toBe(true);
    }
  });
});
