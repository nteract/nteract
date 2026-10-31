// Interprets editor-load-machine.mjs: one import of the Page editor per tab.
import { filter, firstValueFrom } from "rxjs";
import { editorLoadMachine } from "./editor-load-machine.mjs";
import { Store } from "./store.mjs";

export const EDITOR_UNAVAILABLE = "Pages couldn't load the editor. Reload to try again.";

const unavailable = () => Object.assign(Error(EDITOR_UNAVAILABLE), { code: "EDITOR_UNAVAILABLE" });

export class EditorLoader {
  store = new Store(editorLoadMachine.initial);
  #module = null;
  #checkBuild;
  /** Calls `load` now. `checkBuild` runs once if the import fails. */
  constructor({ load, checkBuild = () => {} }) {
    this.#checkBuild = checkBuild;
    new Promise((resolve) => resolve(load())).then(
      (module) => {
        this.#module = module;
        this.#dispatch({ type: "loaded" });
      },
      (error) => this.#dispatch({ type: "failed", message: String(error?.message ?? error) }),
    );
  }
  /** The editor module once the state is `ready`, otherwise null. */
  get module() {
    return this.#module;
  }
  /** Resolves with the editor module, or rejects with EDITOR_UNAVAILABLE. */
  ready() {
    return firstValueFrom(this.store.state$.pipe(filter(({ name }) => name !== "loading"))).then(
      ({ name }) => {
        if (name !== "ready") throw unavailable();
        return this.#module;
      },
    );
  }
  #dispatch(event) {
    const result = editorLoadMachine.step(this.store.snapshot(), event);
    if (result.rejected) return;
    this.store.update(() => result.state);
    for (const effect of result.effects) {
      if (effect.type !== "checkBuild") throw new Error(`unknown effect ${effect.type}`);
      try {
        void Promise.resolve(this.#checkBuild()).catch(() => {});
      } catch {}
    }
  }
}
