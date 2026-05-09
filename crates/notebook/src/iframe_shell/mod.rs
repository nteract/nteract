//! Bootstrap HTML for sandboxed cell-output iframes.
//!
//! The frontend mounts an iframe whose `src` is `nteract-frame://localhost/`
//! (rewritten by Tauri/wry to `http://nteract-frame.localhost/` on Windows).
//! The handler below answers every request to the scheme with the static
//! bootstrap document and a permissive Content-Security-Policy that lets
//! cell outputs run inline `<script>`, call `eval`, and load widget code
//! from the daemon and CDNs. The host iframe element keeps `sandbox` without
//! `allow-same-origin`, which forces the document to an opaque origin —
//! that is the load-bearing isolation against parent-DOM and Tauri-IPC
//! reach.
//!
//! The HTML body is byte-equal to the string returned by `generateFrameHtml()`
//! in `src/components/isolated/frame-html.ts`. `scripts/dump-frame-html.mjs`
//! regenerates `frame.html` from the TS source; the parity test in
//! `crates/notebook/tests/iframe_shell_parity.rs` enforces equality so
//! a TS edit without a regen breaks CI.

use std::borrow::Cow;

use tauri::{http, Runtime, UriSchemeContext};

/// Static bootstrap HTML served from the `nteract-frame://` URI scheme.
pub const FRAME_HTML: &str = include_str!("frame.html");

/// URI scheme name. Must be hyphen-only (Windows hostname rule); never
/// rename — packaged updates would leave WKWebView with stale storage
/// scoped to the old origin.
pub const FRAME_SCHEME: &str = "nteract-frame";

/// CSP returned with every scheme response. Mirrors the `<meta>` tag in
/// `frame.html`. Permissive `script-src` is the whole point of the custom
/// scheme — cell outputs run inline scripts. `frame-src 'none'` blocks
/// nested iframes that malicious cell output might try to spawn for
/// evasion of host-side observers.
const FRAME_CSP: &str = "default-src 'self' blob: data:; \
script-src 'unsafe-inline' 'unsafe-eval' blob: https: http://127.0.0.1:*; \
style-src 'unsafe-inline' https: http://127.0.0.1:*; \
img-src * data: blob:; \
font-src * data:; \
media-src * data: blob:; \
object-src * data: blob:; \
connect-src *; \
frame-src 'none'; \
child-src 'none'; \
worker-src 'self' blob:;";

/// Build the HTTP response for a `nteract-frame://` request. The handler
/// is path-agnostic: every request gets the same bootstrap document.
///
/// `Cache-Control: no-store` is non-negotiable. WKWebView caches custom
/// scheme responses; without this an updated bootstrap (e.g. after a CSP
/// fix ships) can be served stale on first launch post-upgrade.
pub fn build_frame_response() -> http::Response<Cow<'static, [u8]>> {
    http::Response::builder()
        .status(http::StatusCode::OK)
        .header(http::header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(http::header::CONTENT_SECURITY_POLICY, FRAME_CSP)
        .header(
            http::header::CACHE_CONTROL,
            "no-store, no-cache, must-revalidate",
        )
        .header(http::header::PRAGMA, "no-cache")
        .body(Cow::Borrowed(FRAME_HTML.as_bytes()))
        .expect("frame response is statically valid")
}

/// Tauri scheme protocol handler. Wired up in `lib.rs`.
pub fn handler<R: Runtime>(
    _ctx: UriSchemeContext<'_, R>,
    _request: http::Request<Vec<u8>>,
) -> http::Response<Cow<'static, [u8]>> {
    build_frame_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_html_is_nonempty_and_starts_with_doctype() {
        assert!(FRAME_HTML.starts_with("<!DOCTYPE html>"));
        assert!(FRAME_HTML.len() > 1000);
    }

    #[test]
    fn frame_html_keeps_event_source_validation() {
        // Source-side guard against spoofed postMessage. Critical security
        // invariant; mirror of the frame-html.test.ts JS-side assertion.
        assert!(FRAME_HTML.contains("event.source !== window.parent"));
    }

    #[test]
    fn frame_html_meta_csp_blocks_nested_iframes() {
        assert!(FRAME_HTML.contains("frame-src 'none'"));
        assert!(FRAME_HTML.contains("child-src 'none'"));
    }

    #[test]
    fn response_has_html_content_type() {
        let r = build_frame_response();
        let ct = r
            .headers()
            .get(http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert_eq!(ct, "text/html; charset=utf-8");
    }

    #[test]
    fn response_disables_caching() {
        let r = build_frame_response();
        let cc = r
            .headers()
            .get(http::header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(
            cc.contains("no-store"),
            "Cache-Control must disable caching to avoid stale CSP after app updates: {cc}"
        );
    }

    #[test]
    fn response_csp_permits_inline_and_eval() {
        let r = build_frame_response();
        let csp = r
            .headers()
            .get(http::header::CONTENT_SECURITY_POLICY)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(csp.contains("'unsafe-inline'"));
        assert!(csp.contains("'unsafe-eval'"));
        assert!(csp.contains("frame-src 'none'"));
    }
}
