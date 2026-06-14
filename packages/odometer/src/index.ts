export type OdometerOptions = {
  /** Force reduced-motion behavior. Defaults to prefers-reduced-motion. */
  reducedMotion?: boolean;
};

export type Odometer = {
  update(text: string): void;
  destroy(): void;
};

type Slot = {
  el: HTMLSpanElement;
  sizer: HTMLSpanElement;
  face: HTMLSpanElement | null;
  strip: HTMLSpanElement | null;
  current: string;
  pos: number;
  pendingSnapPos: number | null;
  cleanupTransition: (() => void) | null;
};

const STRIP_DIGITS = [9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function canonicalPos(digit: number): number {
  return digit + 1;
}

function createDigitStrip(): HTMLSpanElement {
  const strip = document.createElement("span");
  strip.className = "nteract-odo-strip";
  for (const d of STRIP_DIGITS) {
    const digit = document.createElement("span");
    digit.className = "nteract-odo-num";
    digit.textContent = String(d);
    strip.appendChild(digit);
  }
  return strip;
}

function createFace(text: string): HTMLSpanElement {
  const face = document.createElement("span");
  face.className = "nteract-odo-face";
  face.textContent = text;
  return face;
}

function createSlot(ch: string): Slot {
  const el = document.createElement("span");
  el.className = "nteract-odo-slot";
  el.setAttribute("aria-hidden", "true");
  el.dataset.odometerSlot = "";
  el.dataset.char = ch;

  const sizer = document.createElement("span");
  sizer.className = "nteract-odo-sizer";
  sizer.textContent = ch;
  el.appendChild(sizer);

  return {
    el,
    sizer,
    face: null,
    strip: null,
    current: "",
    pos: -1,
    pendingSnapPos: null,
    cleanupTransition: null,
  };
}

function numericValue(text: string): number {
  const numStr = text.replace(/[^0-9]/g, "");
  return numStr ? Number.parseInt(numStr, 10) : 0;
}

export function createOdometer(host: HTMLElement, options: OdometerOptions = {}): Odometer {
  host.textContent = "";
  host.classList.add("nteract-odometer");
  const slots: Slot[] = [];
  let previousNumericValue = 0;
  let currentText = "";
  let plainTextMode = false;

  function setValue(text: string): void {
    host.dataset.value = text;
    host.setAttribute("aria-label", text);
    currentText = text;
  }

  function removeSlot(slot: Slot): void {
    slot.cleanupTransition?.();
    slot.cleanupTransition = null;
    slot.el.remove();
  }

  function clearSlots(): void {
    for (const slot of slots) {
      removeSlot(slot);
    }
    slots.splice(0, slots.length);
  }

  function setPlainText(text: string): void {
    clearSlots();
    host.textContent = text;
    plainTextMode = true;
    setValue(text);
  }

  function reconcileSlots(text: string): void {
    if (plainTextMode) {
      host.textContent = "";
      plainTextMode = false;
      currentText = "";
    }

    if (text.length === currentText.length) return;

    let prefix = 0;
    while (
      prefix < currentText.length &&
      prefix < text.length &&
      currentText[prefix] === text[prefix]
    ) {
      prefix++;
    }

    let suffix = 0;
    while (
      suffix < currentText.length - prefix &&
      suffix < text.length - prefix &&
      currentText[currentText.length - 1 - suffix] === text[text.length - 1 - suffix]
    ) {
      suffix++;
    }

    const oldMiddle = currentText.length - prefix - suffix;
    const newMiddle = text.length - prefix - suffix;

    for (let i = 0; i < oldMiddle; i++) {
      const removed = slots.splice(prefix, 1)[0];
      if (removed) removeSlot(removed);
    }

    const before = slots[prefix]?.el ?? null;
    for (let i = 0; i < newMiddle; i++) {
      const slot = createSlot("");
      slots.splice(prefix + i, 0, slot);
      host.insertBefore(slot.el, before);
    }
  }

  function snapSlot(slot: Slot): void {
    if (!slot.strip || slot.pendingSnapPos === null) return;
    slot.cleanupTransition?.();
    slot.cleanupTransition = null;
    const canonical = slot.pendingSnapPos;
    slot.pendingSnapPos = null;
    slot.strip.style.transition = "none";
    slot.strip.style.transform = `translateY(${-canonical * 1.2}em)`;
    slot.pos = canonical;
    void slot.strip.offsetHeight;
    slot.strip.style.transition = "";
  }

  function apply(text: string): void {
    if (options.reducedMotion ?? prefersReducedMotion()) {
      setPlainText(text);
      return;
    }

    const increasing = numericValue(text) >= previousNumericValue;
    previousNumericValue = numericValue(text);
    reconcileSlots(text);

    for (let i = 0; i < text.length; i++) {
      const ch = text[i] ?? "";
      const slot = slots[i];
      if (!slot) continue;
      if (ch === slot.current) continue;
      snapSlot(slot);
      slot.el.dataset.char = ch;
      slot.sizer.textContent = ch;

      if (isDigit(ch)) {
        if (slot.face) {
          slot.el.removeChild(slot.face);
          slot.face = null;
        }
        if (!slot.strip) {
          slot.strip = createDigitStrip();
          slot.el.appendChild(slot.strip);
        }
        const target = Number.parseInt(ch, 10);
        const prev = isDigit(slot.current) ? Number.parseInt(slot.current, 10) : -1;
        let targetPos: number;
        if (prev === -1 || slot.pos === -1) targetPos = canonicalPos(target);
        else if (increasing && prev === 9 && target === 0) targetPos = 11;
        else if (!increasing && prev === 0 && target === 9) targetPos = 0;
        else targetPos = canonicalPos(target);

        const strip = slot.strip;
        strip.style.transform = `translateY(${-targetPos * 1.2}em)`;
        slot.pos = targetPos;
        slot.pendingSnapPos = null;

        slot.cleanupTransition?.();
        slot.cleanupTransition = null;
        if (targetPos === 0 || targetPos === 11) {
          slot.pendingSnapPos = canonicalPos(target);
          const onEnd = (event: Event) => {
            if (event.target !== strip) return;
            if (
              "propertyName" in event &&
              typeof event.propertyName === "string" &&
              event.propertyName !== "" &&
              event.propertyName !== "transform"
            ) {
              return;
            }
            strip.removeEventListener("transitionend", onEnd);
            if (slot.strip === strip) {
              snapSlot(slot);
            }
          };
          strip.addEventListener("transitionend", onEnd);
          slot.cleanupTransition = () => strip.removeEventListener("transitionend", onEnd);
        }
      } else {
        slot.cleanupTransition?.();
        slot.cleanupTransition = null;
        slot.pendingSnapPos = null;
        if (slot.strip) {
          slot.el.removeChild(slot.strip);
          slot.strip = null;
          slot.pos = -1;
        }
        if (!slot.face) {
          slot.face = createFace(ch);
          slot.el.appendChild(slot.face);
        } else {
          slot.face.textContent = ch;
        }
      }
      slot.current = ch;
    }

    setValue(text);
  }

  function update(text: string): void {
    apply(text);
  }

  function destroy(): void {
    clearSlots();
    host.textContent = "";
    host.classList.remove("nteract-odometer");
    delete host.dataset.value;
    host.removeAttribute("aria-label");
    currentText = "";
    plainTextMode = false;
  }

  return { update, destroy };
}
