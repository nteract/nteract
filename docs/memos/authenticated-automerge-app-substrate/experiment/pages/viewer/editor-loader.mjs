// Interprets editor-load-machine.mjs: one import of the Page editor per tab.
import { filter, firstValueFrom } from "rxjs";
import { editorLoadMachine } from "./editor-load-machine.mjs";
import { Store } from "./store.mjs";

export const EDITOR_UNAVAILABLE = "The editor didn't load. Reload to try again.";

const unavailable = () => Object.assign(Error(EDITOR_UNAVAILABLE), { code: "EDITOR_UNAVAILABLE" });

export class EditorLoader {
  store = new Store(editorLoadMachine.initial);
  #module = null;
  #load;
  #checkBuild;
  /** `load` runs once, on the first `start()` or `ready()`. `checkBuild` runs
   * once if the import fails. */
  constructor({ load, checkBuild = () => {} }) {
    this.#load = load;
    this.#checkBuild = checkBuild;
  }
  /** Begin the import if nothing has yet. Later calls do nothing. */
  start() {
    this.#dispatch({ type: "start" });
  }
  /** The editor module once the state is `ready`, otherwise null. */
  get module() {
    return this.#module;
  }
  /** Starts the import if needed, then resolves with the editor module, or
   * rejects with EDITOR_UNAVAILABLE. */
  ready() {
    this.start();
    return firstValueFrom(
      this.store.state$.pipe(filter(({ name }) => name === "ready" || name === "failed")),
    ).then(({ name }) => {
      if (name !== "ready") throw unavailable();
      return this.#module;
    });
  }
  /** Waits for the editor, then hands it over only if `stillCurrent()` holds.
   * Resolves null when the caller's navigation or account moved on during the
   * wait, so nothing it would have done with the module runs. Rejects with
   * EDITOR_UNAVAILABLE like `ready()`. */
  async readyWhile(stillCurrent) {
    const module = await this.ready();
    return stillCurrent() ? module : null;
  }
  #dispatch(event) {
    const result = editorLoadMachine.step(this.store.snapshot(), event);
    if (result.rejected) return;
    this.store.update(() => result.state);
    for (const effect of result.effects) {
      if (effect.type === "import") this.#import();
      else if (effect.type === "checkBuild") {
        try {
          void Promise.resolve(this.#checkBuild()).catch(() => {});
        } catch {}
      } else throw new Error(`unknown effect ${effect.type}`);
    }
  }
  #import() {
    new Promise((resolve) => resolve(this.#load())).then(
      (module) => {
        this.#module = module;
        this.#dispatch({ type: "loaded" });
      },
      (error) => this.#dispatch({ type: "failed", message: String(error?.message ?? error) }),
    );
  }
}
