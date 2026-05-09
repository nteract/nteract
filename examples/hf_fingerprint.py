"""HF parquet rich-type fingerprinting.

Two-tier detection:
1. Prefer the `huggingface` KV metadata key written by `datasets.Dataset.to_parquet()`
   and HF Hub's parquet exports. Walks `info.features.{name}` recursively into
   `Sequence`/`List`/`LargeList` / `feature`.
2. Fall back to Arrow struct-shape heuristics for non-HF parquets that happen
   to encode images/audio the same way.

Returns a flat map: column path -> {semantic_type, dtype, hint, names}.

Coverage (verified against real HF parquets, May 2026):
- Image:        struct<bytes: binary, path: string>     -> render thumbnail
- Audio:        struct<bytes: binary, path: string>     -> audio player
- Video:        same struct shape                       -> video player
- Pdf/Nifti:    same struct shape                       -> doc preview / scan
- ClassLabel:   int + names list in feature schema      -> categorical chip
- Translation:  struct<lang: string, lang: string, ...> -> language pair label
- Value:        primitive (uses dtype directly)
- List/Sequence/LargeList: recurse into .feature
- Array2D-5D:   shape-annotated arrays                  -> heatmap / volume
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

HF_KV_KEY = "huggingface"

# Semantic types the viewer can render specially.
SEMANTIC_IMAGE = "image"
SEMANTIC_AUDIO = "audio"
SEMANTIC_VIDEO = "video"
SEMANTIC_PDF = "pdf"
SEMANTIC_NIFTI = "nifti"
SEMANTIC_CLASS_LABEL = "class_label"
SEMANTIC_TRANSLATION = "translation"
SEMANTIC_ARRAY_ND = "array_nd"
SEMANTIC_VALUE = "value"
SEMANTIC_LIST = "list"
SEMANTIC_UNKNOWN = "unknown"

# Map HF _type to semantic type. List/Sequence/LargeList recurse separately.
HF_TYPE_TO_SEMANTIC = {
    "Image": SEMANTIC_IMAGE,
    "Audio": SEMANTIC_AUDIO,
    "Video": SEMANTIC_VIDEO,
    "Pdf": SEMANTIC_PDF,
    "Nifti": SEMANTIC_NIFTI,
    "ClassLabel": SEMANTIC_CLASS_LABEL,
    "Translation": SEMANTIC_TRANSLATION,
    "TranslationVariableLanguages": SEMANTIC_TRANSLATION,
    "Array2D": SEMANTIC_ARRAY_ND,
    "Array3D": SEMANTIC_ARRAY_ND,
    "Array4D": SEMANTIC_ARRAY_ND,
    "Array5D": SEMANTIC_ARRAY_ND,
    "Value": SEMANTIC_VALUE,
}


@dataclass
class FieldFingerprint:
    """One column's semantic fingerprint."""

    path: str
    semantic_type: str
    dtype: str | None = None
    hint: str | None = None
    names: list[str] | None = None
    list_depth: int = 0
    inner: FieldFingerprint | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"path": self.path, "semantic_type": self.semantic_type}
        if self.dtype is not None:
            d["dtype"] = self.dtype
        if self.hint is not None:
            d["hint"] = self.hint
        if self.names is not None:
            d["names"] = self.names
        if self.list_depth:
            d["list_depth"] = self.list_depth
        if self.inner is not None:
            d["inner"] = self.inner.to_dict()
        if self.extra:
            d["extra"] = self.extra
        return d


def _walk_hf_feature(name: str, feature: dict[str, Any]) -> FieldFingerprint:
    """Walk a single feature node from HF's feature schema."""
    ftype = feature.get("_type")

    if ftype in {"List", "Sequence", "LargeList"}:
        # Sequence/List/LargeList wrap a single sub-feature in `feature` (modern)
        # or a dict-of-features (legacy Sequence-of-dict). Modern is the common case.
        sub = feature.get("feature", {})
        if isinstance(sub, dict) and "_type" in sub:
            inner = _walk_hf_feature(name, sub)
            return FieldFingerprint(
                path=name,
                semantic_type=SEMANTIC_LIST,
                list_depth=inner.list_depth + 1,
                inner=inner,
            )
        # legacy Sequence-of-dict: each key is a sub-feature; flag as list-of-struct.
        return FieldFingerprint(
            path=name,
            semantic_type=SEMANTIC_LIST,
            list_depth=1,
            inner=None,
            extra={"sequence_of_struct": True},
        )

    semantic = HF_TYPE_TO_SEMANTIC.get(ftype, SEMANTIC_UNKNOWN)
    fp = FieldFingerprint(path=name, semantic_type=semantic)
    if ftype == "Value":
        fp.dtype = feature.get("dtype")
    if ftype == "ClassLabel":
        fp.names = feature.get("names")
    if ftype in {"Array2D", "Array3D", "Array4D", "Array5D"}:
        fp.extra = {"shape": feature.get("shape"), "dtype": feature.get("dtype")}
    if ftype == "Audio":
        fp.extra = {"sampling_rate": feature.get("sampling_rate")}
    if ftype in {"Translation", "TranslationVariableLanguages"}:
        fp.extra = {"languages": feature.get("languages")}
    if semantic == SEMANTIC_UNKNOWN and ftype is not None:
        fp.extra = {"_type": ftype, "raw": feature}
    return fp


def _looks_like_image_struct(arrow_type: pa.DataType) -> bool:
    """Heuristic: Arrow struct<bytes: binary, path: string> matches HF Image shape."""
    if not pa.types.is_struct(arrow_type):
        return False
    fields = {f.name: f.type for f in arrow_type}
    if set(fields) != {"bytes", "path"}:
        return False
    if not (pa.types.is_binary(fields["bytes"]) or pa.types.is_large_binary(fields["bytes"])):
        return False
    if not pa.types.is_string(fields["path"]):
        return False
    return True


def _walk_arrow_field(field_obj: pa.Field) -> FieldFingerprint:
    """Fall back to pure-Arrow inspection when no HF KV is present."""
    name = field_obj.name
    t = field_obj.type
    if pa.types.is_list(t) or pa.types.is_large_list(t):
        inner = _walk_arrow_field(pa.field(name, t.value_type))
        return FieldFingerprint(
            path=name,
            semantic_type=SEMANTIC_LIST,
            list_depth=inner.list_depth + 1,
            inner=inner,
        )
    if _looks_like_image_struct(t):
        return FieldFingerprint(
            path=name,
            semantic_type=SEMANTIC_IMAGE,
            hint="struct_shape",
        )
    return FieldFingerprint(path=name, semantic_type=SEMANTIC_VALUE, dtype=str(t))


def fingerprint_parquet(path: str) -> dict[str, FieldFingerprint]:
    """Read a parquet file and return per-column semantic fingerprints."""
    md = pq.read_metadata(path)
    kv = {k.decode(): v.decode() for k, v in (md.metadata or {}).items()}

    if HF_KV_KEY in kv:
        hf = json.loads(kv[HF_KV_KEY])
        features = hf.get("info", {}).get("features", {})
        return {name: _walk_hf_feature(name, feat) for name, feat in features.items()}

    # No HF metadata: walk the Arrow schema directly.
    schema = pq.read_schema(path)
    return {f.name: _walk_arrow_field(f) for f in schema}


def summary(fingerprints: dict[str, FieldFingerprint]) -> str:
    """Human-readable one-line-per-column summary."""
    lines = []
    for name, fp in fingerprints.items():
        d = fp.to_dict()
        if fp.semantic_type == SEMANTIC_LIST and fp.inner:
            inner_t = fp.inner.semantic_type
            lines.append(
                f"  {name}: list[{inner_t}]"
                + (f" (depth={fp.list_depth})" if fp.list_depth > 1 else "")
            )
        elif fp.semantic_type == SEMANTIC_VALUE:
            lines.append(f"  {name}: {fp.dtype or 'value'}")
        elif fp.semantic_type == SEMANTIC_CLASS_LABEL:
            n = len(fp.names or [])
            lines.append(f"  {name}: class_label ({n} classes)")
        elif fp.semantic_type == SEMANTIC_TRANSLATION:
            langs = (fp.extra or {}).get("languages") or "?"
            lines.append(f"  {name}: translation {langs}")
        elif fp.semantic_type == SEMANTIC_AUDIO:
            sr = (fp.extra or {}).get("sampling_rate")
            lines.append(f"  {name}: audio (sr={sr})")
        else:
            lines.append(f"  {name}: {fp.semantic_type}")
    return "\n".join(lines)
