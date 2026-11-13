// Records every host global, prototype member and navigator member that the
// chart Worker's code reads, for scripts/chart-smoke.mjs to compare with the
// lockdown's allowlist (viewer/chart-lockdown.mjs). Imported first, so every
// later module's reads go through it: each own property of the Worker's
// global, its prototypes and its navigator, ECMAScript's own globals aside,
// becomes an accessor that records its name and hands back the original.
// Built by the smoke; never part of the viewer build.
import { ECMASCRIPT_GLOBALS } from "../../viewer/chart-lockdown.mjs";

export const used = new Set();

function chain(target) {
  const objects = [];
  for (
    let object = target;
    object && object !== Object.prototype;
    object = Object.getPrototypeOf(object)
  )
    objects.push(object);
  return objects;
}

function record(target, prefix, skip) {
  for (const object of chain(target))
    for (const key of Object.getOwnPropertyNames(object)) {
      if (key === "constructor" || skip.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor.configurable) continue;
      const name = `${prefix}${key}`;
      let value = descriptor.value;
      Object.defineProperty(object, key, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          used.add(name);
          return "value" in descriptor ? value : descriptor.get?.call(this);
        },
        set(next) {
          used.add(name);
          if ("value" in descriptor) value = next;
          else descriptor.set?.call(this, next);
        },
      });
    }
}

const navigator = self.navigator;
if (navigator) record(navigator, "navigator.", new Set());
record(self, "", new Set(ECMASCRIPT_GLOBALS));
