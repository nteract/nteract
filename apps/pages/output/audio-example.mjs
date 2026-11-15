// AFM example: bind recording (WAV) and dmel (Parquet columns: frame,
// band, code, time_seconds). These imports run only in the output frame.
import init, {
  readParquet,
} from "https://cdn.jsdelivr.net/npm/parquet-wasm@0.9.0/esm/parquet_wasm.js";
import { tableFromIPC } from "https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm";

export default {
  async render({ model, el, signal }) {
    await init();
    signal.throwIfAborted();
    const bytes = (name) => {
      const v = model.get(name);
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    };
    const table = tableFromIPC((await readParquet(bytes("dmel"))).intoIPCStream());
    const rows = [...table].map((row) => row.toJSON());
    const frames = Math.max(...rows.map((r) => Number(r.frame))) + 1;
    const bands = Math.max(...rows.map((r) => Number(r.band))) + 1;
    const url = URL.createObjectURL(new Blob([bytes("recording")], { type: "audio/wav" }));
    const style = el.appendChild(document.createElement("style"));
    // Layout belongs to this example; typography, surfaces and controls come
    // from the shared frame stylesheet and the host's live design tokens.
    style.textContent = `audio,canvas{width:100%;display:block}canvas{height:240px;cursor:crosshair;margin-top:16px}label{margin-top:16px}output{font-variant-numeric:tabular-nums}small{display:block;margin-top:12px}`;
    const heading = el.appendChild(document.createElement("h2"));
    heading.textContent = "Listen, then look";
    const description = el.appendChild(document.createElement("p"));
    description.className = "output-muted";
    description.textContent =
      model.get("description") ??
      "Recording and linked dMel. Click the heatmap or move the playhead to inspect a frame.";
    const audio = el.appendChild(document.createElement("audio"));
    audio.controls = true;
    audio.src = url;
    const canvas = el.appendChild(document.createElement("canvas"));
    canvas.width = 1008;
    canvas.height = 320;
    canvas.setAttribute("aria-label", "dMel heatmap, time horizontally and mel band vertically");
    const label = el.appendChild(document.createElement("label"));
    label.textContent = "Playhead ";
    const readout = label.appendChild(document.createElement("output"));
    const slider = label.appendChild(document.createElement("input"));
    slider.type = "range";
    slider.min = "0";
    slider.max = String((frames - 1) * 0.05);
    slider.step = ".001";
    slider.value = "0";
    const note = el.appendChild(document.createElement("small"));
    note.textContent = `${frames} frames × ${bands} mel bands · 50 ms hop · 100 ms window · quantized codes 0–15`;
    const ctx = canvas.getContext("2d");
    const draw = (seconds) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const row of rows) {
        const code = Number(row.code);
        ctx.fillStyle = `hsl(${270 - code * 13} 75% ${12 + code * 3.4}%)`;
        ctx.fillRect(
          (Number(row.frame) * canvas.width) / frames,
          ((bands - 1 - Number(row.band)) * canvas.height) / bands,
          Math.ceil(canvas.width / frames),
          Math.ceil(canvas.height / bands),
        );
      }
      const frame = Math.min(frames - 1, Math.max(0, Math.round(seconds / 0.05)));
      ctx.strokeStyle = "white";
      ctx.lineWidth = 2;
      ctx.strokeRect((frame * canvas.width) / frames, 0, canvas.width / frames, canvas.height);
      readout.textContent = `${seconds.toFixed(3)} s · frame ${frame}`;
      slider.value = String(seconds);
    };
    const seek = (seconds) => {
      audio.currentTime = seconds;
      model.set("time", seconds);
      model.save_changes();
      draw(seconds);
    };
    audio.addEventListener("timeupdate", () => draw(audio.currentTime), { signal });
    slider.addEventListener("input", () => seek(Number(slider.value)), { signal });
    canvas.addEventListener(
      "click",
      (event) => {
        const rect = canvas.getBoundingClientRect();
        seek(
          Math.min(
            (frames - 1) * 0.05,
            Math.max(0, ((event.clientX - rect.left) / rect.width) * frames * 0.05),
          ),
        );
      },
      { signal },
    );
    draw(0);
    return () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      el.replaceChildren();
    };
  },
};
