export const ISOLATED_FRAME_SANDBOX_ATTRS = [
  "allow-scripts",
  "allow-downloads",
  "allow-forms",
  "allow-pointer-lock",
].join(" ");

export const ISOLATED_FRAME_ALLOW_ATTR = "fullscreen *";

export type IsolatedFrameDocument = { kind: "src"; url: string } | { kind: "srcdoc"; html: string };

interface IsolatedFrameThemeSeed {
  theme?: "light" | "dark" | null;
  colorTheme?: string | null;
}

const NTERACT_FRAME_URL = "nteract-frame://localhost/";
const FRAME_HTML_STUB = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      :root {
        color-scheme: light;
        --frame-bg: transparent;
        --frame-text: #18181b;
        --frame-muted: #71717a;
        --frame-border: #d4d4d8;
      }
      :root.dark {
        color-scheme: dark;
        --frame-text: #f4f4f5;
        --frame-muted: #a1a1aa;
        --frame-border: #3f3f46;
      }
      * {
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        background: var(--frame-bg);
        color: var(--frame-text);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        color: var(--frame-muted);
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      (function () {
        var root = document.getElementById("root");

        function sendLegacy(type, payload) {
          window.parent.postMessage({ type: type, payload: payload || null }, "*");
        }

        function sendRpc(method, params) {
          window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params || {} }, "*");
        }

        function height() {
          return Math.max(
            1,
            Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 1),
          );
        }

        function complete() {
          var nextHeight = height();
          sendLegacy("render_complete", { height: nextHeight });
          sendRpc("nteract/renderComplete", { height: nextHeight });
          sendRpc("ui/notifications/size-changed", { height: nextHeight });
        }

        function scheduleComplete() {
          complete();
          requestAnimationFrame(complete);
          window.setTimeout(complete, 0);
        }

        function render(payload) {
          var output = document.createElement("div");
          var mimeType = payload && payload.mimeType;
          var data = payload && payload.data;

          if (mimeType === "text/html") {
            output.innerHTML = String(data || "");
          } else if (mimeType === "application/json") {
            var pre = document.createElement("pre");
            pre.textContent = JSON.stringify(data, null, 2);
            output.appendChild(pre);
          } else {
            var fallback = document.createElement("pre");
            fallback.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
            output.appendChild(fallback);
          }

          root.replaceChildren(output);
          scheduleComplete();
        }

        function renderBatch(payload) {
          var outputs = (payload && payload.outputs) || [];
          root.replaceChildren();
          outputs.forEach(function (entry) {
            var output = document.createElement("div");
            var mimeType = entry && entry.mimeType;
            var data = entry && entry.data;

            if (mimeType === "text/html") {
              output.innerHTML = String(data || "");
            } else {
              var fallback = document.createElement("pre");
              fallback.textContent =
                typeof data === "string" ? data : JSON.stringify(data, null, 2);
              output.appendChild(fallback);
            }
            root.appendChild(output);
          });
          scheduleComplete();
        }

        function setTheme(payload) {
          var isDark = Boolean(payload && (payload.isDark || payload.theme === "dark"));
          document.documentElement.classList.toggle("dark", isDark);
        }

        window.addEventListener("message", function (event) {
          if (event.source && event.source !== window.parent) return;

          var data = event.data || {};
          var payload = data.payload || data.params || {};

          try {
            if (data.type === "eval" || data.method === "nteract/eval") {
              var code = payload.code;
              if (typeof code === "string") {
                eval.call(null, code);
                sendRpc("nteract/evalResult", { success: true });
              }
              return;
            }

            if (data.type === "render" || data.method === "nteract/renderOutput") {
              render(payload);
              return;
            }

            if (data.type === "render_batch" || data.method === "nteract/renderBatch") {
              renderBatch(payload);
              return;
            }

            if (data.type === "theme" || data.method === "nteract/theme") {
              setTheme(payload);
              return;
            }

            if (data.type === "clear" || data.method === "nteract/clearOutputs") {
              root.replaceChildren();
              complete();
            }
          } catch (error) {
            sendLegacy("error", { message: error && error.message ? error.message : String(error) });
          }
        });

        sendLegacy("ready");
      })();
    </script>
  </body>
</html>`;

export function createIsolatedFrameDocument(options?: {
  isTauriRuntime?: boolean;
  outputDocumentUrl?: string | null;
  themeSeed?: IsolatedFrameThemeSeed;
}): IsolatedFrameDocument {
  const outputDocumentUrl = options?.outputDocumentUrl?.trim();
  if (outputDocumentUrl) {
    return { kind: "src", url: withIsolatedFrameThemeSeed(outputDocumentUrl, options?.themeSeed) };
  }

  if (options?.isTauriRuntime) {
    return { kind: "src", url: NTERACT_FRAME_URL };
  }
  return { kind: "srcdoc", html: FRAME_HTML_STUB };
}

function withIsolatedFrameThemeSeed(
  outputDocumentUrl: string,
  themeSeed: IsolatedFrameThemeSeed | undefined,
): string {
  if (!themeSeed?.theme && !themeSeed?.colorTheme) return outputDocumentUrl;

  try {
    const isAbsoluteOrProtocolRelative =
      /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(outputDocumentUrl) || outputDocumentUrl.startsWith("//");
    const parsed = new URL(outputDocumentUrl, "https://nteract.invalid");
    if (themeSeed.theme === "light" || themeSeed.theme === "dark") {
      parsed.searchParams.set("nteract_theme", themeSeed.theme);
    }
    if (themeSeed.colorTheme && themeSeed.colorTheme !== "classic") {
      parsed.searchParams.set("nteract_color_theme", themeSeed.colorTheme);
    }

    if (isAbsoluteOrProtocolRelative) return parsed.href;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return outputDocumentUrl;
  }
}
