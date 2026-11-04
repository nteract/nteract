// A button that opens a menu of choices, one of them checked: the library's
// Project, Sort and Group controls. The menu follows the ARIA menu-button
// pattern: it opens on click, Enter, Space or ArrowDown with focus on the
// checked choice; arrows, Home and End move between choices; Escape closes it
// and returns focus to the button; Tab or a pointer outside closes it.
//
// On a phone the menu opens as a sheet at the bottom of the screen, away from
// its button, so it shows `label` as a visible title; the menu's accessible
// name already says it, so the title is hidden from assistive tech.
//
// A choice with `disabled` stays focusable and says why in its `note`, and
// choosing it does nothing. A control that is `unavailable` stays focusable
// too, opens nothing, and names its reason as its description and tooltip.
//
// `actions` follow the choices under a separator, as plain menu items that do
// something rather than pick a value (the Group menu's Fold all and Unfold
// all). Arrows move through choices and actions alike; an action with
// `disabled` stays focusable and does nothing.
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export function ChoiceMenu({
  label,
  icon: Icon,
  choices,
  value,
  onChoose,
  unavailable = null,
  align = "end",
  actions = [],
}) {
  const [open, setOpen] = useState(false);
  const root = useRef(null),
    button = useRef(null),
    menu = useRef(null);
  const menuId = useId(),
    reasonId = useId();
  const current = choices.find((choice) => choice.value === value) ?? choices[0];
  const close = (focus) => {
    setOpen(false);
    if (focus) button.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    const frame = requestAnimationFrame(() =>
      (
        menu.current?.querySelector('[aria-checked="true"]') ??
        menu.current?.querySelector('[role="menuitemradio"]')
      )?.focus({ preventScroll: true }),
    );
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      cancelAnimationFrame(frame);
    };
  }, [open]);
  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);
  function toggle() {
    if (!unavailable) setOpen((shown) => !shown);
  }
  function buttonKeys(event) {
    // Focus moves into the menu a frame after it opens; Escape before then
    // still closes it.
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key !== "ArrowDown" || unavailable) return;
    event.preventDefault();
    setOpen(true);
  }
  function menuKeys(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.current.querySelectorAll(MENU_ITEMS)];
    const index = items.indexOf(document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  }
  function choose(choice) {
    if (choice.disabled) return;
    close(true);
    if (choice.value !== value) onChoose(choice.value);
  }
  function act(action) {
    if (action.disabled) return;
    close(true);
    action.onSelect();
  }
  return (
    <div className="library-menu-root" ref={root}>
      <button
        ref={button}
        type="button"
        className="subtle-button library-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${label}: ${current.label}`}
        aria-disabled={unavailable ? true : undefined}
        aria-describedby={unavailable ? reasonId : undefined}
        title={unavailable ?? undefined}
        onClick={toggle}
        onKeyDown={buttonKeys}
      >
        {Icon && <Icon size={16} aria-hidden="true" />}
        <span className="library-menu-value">{current.short ?? current.label}</span>
        <ChevronDown className="library-menu-chevron" size={14} aria-hidden="true" />
      </button>
      {unavailable && (
        <span id={reasonId} className="sr-only">
          {unavailable}
        </span>
      )}
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={label}
          className={`library-menu library-menu-${align}`}
          onKeyDown={menuKeys}
        >
          <p className="library-menu-title" aria-hidden="true">
            {label}
          </p>
          {choices.map((choice) => (
            <button
              key={choice.value ?? "none"}
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              aria-checked={choice.value === value}
              aria-disabled={choice.disabled ? true : undefined}
              className="library-menu-item"
              onClick={() => choose(choice)}
            >
              <Check className="library-menu-check" size={16} aria-hidden="true" />
              <span className="library-menu-text">
                <span className="library-menu-label">{choice.label}</span>
                {choice.note && <span className="library-menu-note">{choice.note}</span>}
              </span>
            </button>
          ))}
          {actions.length > 0 && <div role="separator" className="library-menu-separator" />}
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-disabled={action.disabled ? true : undefined}
              className="library-menu-item library-menu-action"
              onClick={() => act(action)}
            >
              {action.icon ? (
                <action.icon className="library-menu-check" size={16} aria-hidden="true" />
              ) : (
                <span className="library-menu-check" aria-hidden="true" />
              )}
              <span className="library-menu-text">
                <span className="library-menu-label">{action.label}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const MENU_ITEMS = '[role="menuitemradio"], [role="menuitem"]';
