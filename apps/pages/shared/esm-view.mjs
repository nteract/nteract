// A deliberately small AFM profile. Code is a named source, just like data.
export const ESM_VIEW_MEDIA_TYPE = "application/vnd.nteract.esm-view+json";
export const ESM_MEDIA_TYPE = "text/javascript";
export const WAV_MEDIA_TYPE = "audio/wav";
export const OUTPUT_FRAME_URL = "https://pages.kilousercontent.com/frame/v1/";
export const OUTPUT_MAX_BYTES = 5 * 1024 * 1024;
export const OUTPUT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const name = (v) =>
  typeof v === "string" &&
  /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(v) &&
  !["__proto__", "prototype", "constructor"].includes(v);

export function checkEsmSpec(spec) {
  const bad = (error) => ({ ok: false, error });
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    return bad("ESM spec must be an object.");
  if (Object.keys(spec).some((key) => !["module", "inputs", "state"].includes(key)))
    return bad("ESM spec takes module, inputs and optional state.");
  if (!name(spec.module)) return bad("module must name the ESM source binding.");
  if (!Array.isArray(spec.inputs) || spec.inputs.length > 31 || !spec.inputs.every(name))
    return bad("inputs must list at most 31 binding names.");
  const names = [spec.module, ...spec.inputs];
  if (new Set(names).size !== names.length)
    return bad("Module and input binding names must be distinct.");
  if (
    spec.state !== undefined &&
    (!spec.state ||
      typeof spec.state !== "object" ||
      Array.isArray(spec.state) ||
      Object.keys(spec.state).some((key) => !name(key) || names.includes(key)))
  )
    return bad("state must be an object with safe keys distinct from input names.");
  return { ok: true, names };
}
