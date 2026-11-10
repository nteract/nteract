// Capture has no replacement effect. A retry after an uncertain write uses
// the same immutable copy and id; the archive reconciles that id atomically.
export const RECOVERY_INITIAL = Object.freeze({ name: "idle" });

// Capture and retirement archives have independent ordering. When captures
// exist, offer every copy rather than suggesting one is the latest draft.
export function recoveryDownloadAction(records, download) {
  if (!records.length) return;
  if (records.some((record) => record.recovery_kind === "capture"))
    return {
      key: "recovery-copies",
      label: "Download recovery copies",
      run: () => download(undefined, { bundle: true }),
    };
  return {
    key: "local-draft",
    label: "Download previous local draft",
    run: () => download(records.at(-1)),
  };
}

export function recoveryCaptureStep(state, event) {
  if (event.type === "save") {
    if (state.name === "capturing" || state.name === "persisting") return state;
    if (state.name === "failed" && state.copy)
      return { name: "persisting", id: state.id, copy: state.copy };
    return { name: "capturing", id: event.id };
  }
  if (event.id !== state.id) return state;
  if (event.type === "captured" && state.name === "capturing")
    return { name: "persisting", id: state.id, copy: event.copy };
  if (event.type === "persisted" && state.name === "persisting")
    return { name: "archived", id: state.id, record: event.record };
  if (event.type === "failed" && ["capturing", "persisting"].includes(state.name))
    return { ...state, name: "failed", error: event.error };
  return state;
}

export class RecoveryCapture {
  state = RECOVERY_INITIAL;
  constructor({ capture, persist, changed = () => {} }) {
    this.capture = capture;
    this.persist = persist;
    this.changed = changed;
  }
  dispatch(event) {
    this.state = recoveryCaptureStep(this.state, event);
    this.changed();
  }
  async save() {
    if (["capturing", "persisting"].includes(this.state.name)) return;
    this.dispatch({ type: "save", id: crypto.randomUUID() });
    const { id } = this.state;
    try {
      if (this.state.name === "capturing") {
        // Synchronous: Page, comments and drafts share one JavaScript turn.
        const copy = this.capture(id);
        this.dispatch({ type: "captured", id, copy });
      }
      const record = await this.persist(this.state.copy);
      this.dispatch({ type: "persisted", id, record });
      return record;
    } catch (error) {
      this.dispatch({ type: "failed", id, error: error.message });
      throw error;
    }
  }
}
