// What a reader that never runs the app learns from the app shell's HTTP
// answer. Every route the app owns answers with one shell (site-tags.mjs,
// page-shell.mjs, published-preview.mjs); this adds the same headers to all
// of them and leaves a shell's body as it was built.
//
// - `Link: </llms.txt>; rel="describedby"` mirrors the shell's own <link>, for
//   clients that read headers and never parse HTML.
// - `X-Robots-Tag: noindex` on every shell route but `/` with no query. Each
//   of them opens something a reader must sign in for, whether or not its
//   owner published a link preview, and its address names a Page or Project
//   ID or a search that an index has no use for.
// - A path that reads as a file (`/llms-full.txt`, `/sitemap.xml`,
//   `/project/<id>.md`) and found no asset is a 404, not the shell with a 200:
//   a client that asked for a file must not take the app's HTML for it. This
//   is the one answer whose body is not the shell's.
export const DESCRIBED_BY = '</llms.txt>; rel="describedby"; type="text/plain"';

/** Extensions of the files an agent or crawler asks for by name. A missing
 * one is a 404. Built assets keep their own answer: they are never the
 * shell. */
const FILE_EXTENSION = /\.(?:txt|md|markdown|xml|json|ya?ml|csv)$/i;

/** Whether `pathname` names a file by one of FILE_EXTENSION's extensions. */
export const readsAsFile = (pathname) => FILE_EXTENSION.test(pathname);

const isShell = (response) =>
  response.status === 200 && (response.headers.get("content-type") ?? "").startsWith("text/html");

/**
 * `response` with the agent-discovery headers when it is the app shell for a
 * GET or HEAD of `request`, or a 404 when the path reads as a file. Any other
 * answer (a redirect, a 304, a built file, a refusal) is returned untouched.
 */
export function agentShellResponse(request, response) {
  if (!["GET", "HEAD"].includes(request.method) || !isShell(response)) return response;
  const url = new URL(request.url);
  if (readsAsFile(url.pathname)) {
    void response.body?.cancel();
    return new Response(
      request.method === "HEAD" ? null : "Not found. The agent guide is at /llms.txt.\n",
      {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
          "x-robots-tag": "noindex",
          link: DESCRIBED_BY,
        },
      },
    );
  }
  const headers = new Headers(response.headers);
  headers.set("link", DESCRIBED_BY);
  // `/` alone is the one shell address that opens nothing private and names
  // nothing. A query makes it a Page link (`/?page=<id>`, readPageRoute) or a
  // view of someone's library.
  if (url.pathname !== "/" || url.search) headers.set("x-robots-tag", "noindex");
  return new Response(response.body, { status: response.status, headers });
}
