import { normalizeBlobResolver } from "runtimed";
import type { BlobResolverInput } from "./manifest-resolution";

function blobUrl(blobResolver: BlobResolverInput, hash: string): string {
  return normalizeBlobResolver(blobResolver).url({ blob: hash });
}

/**
 * Rewrite markdown and inline HTML asset refs to blob URLs.
 *
 * Supports:
 * - Markdown image syntax: ![alt](path), ![alt](<path>), ![alt](path "title")
 * - Reference-style markdown images: `![alt][id]` with `[id]: path`
 * - Inline HTML image tags: <img src="path">
 */
export function rewriteMarkdownAssetRefs(
  source: string,
  resolvedAssets: Record<string, string> | undefined,
  blobResolver: BlobResolverInput | null,
): string {
  if (
    !resolvedAssets ||
    blobResolver === null ||
    Object.keys(resolvedAssets).length === 0
  ) {
    return source;
  }

  let result = source;

  for (const [assetRef, hash] of Object.entries(resolvedAssets)) {
    const url = blobUrl(blobResolver, hash);
    const escapedRef = assetRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const markdownImageSuffix = `((?:[ \\t]+(?:"[^"]*"|'[^']*'|\\([^\\n)]*\\)))?[ \\t]*\\))`;

    result = result
      .replace(
        new RegExp(
          `(!\\[[^\\]]*\\]\\([ \\t]*)<?${escapedRef}>?${markdownImageSuffix}`,
          "g",
        ),
        `$1${url}$2`,
      )
      .replace(
        new RegExp(
          `(^[ \\t]{0,3}\\[[^\\]]+\\]:[ \\t]*<?)${escapedRef}(>?((?:[ \\t]+(?:"[^"]*"|'[^']*'|\\([^\\n)]*\\)))?)[ \\t]*$)`,
          "gm",
        ),
        `$1${url}$2`,
      )
      .replace(
        new RegExp(`(\\bsrc\\s*=\\s*")${escapedRef}(")`, "gi"),
        `$1${url}$2`,
      )
      .replace(
        new RegExp(`(\\bsrc\\s*=\\s*')${escapedRef}(')`, "gi"),
        `$1${url}$2`,
      )
      .replace(
        new RegExp(`(\\bsrc\\s*=\\s*)${escapedRef}(?=[\\s>])`, "gi"),
        `$1${url}`,
      );
  }

  return result;
}
