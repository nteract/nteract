use std::borrow::Cow;

use tauri::http::{header, HeaderValue, Request, Response, StatusCode};

pub const FRAME_HTML: &str = include_str!("../../../../src/components/isolated/frame.html");
pub const FRAME_SCHEME: &str = "nteract-frame";

pub const FRAME_CSP: &str = "default-src 'self' blob: data:; \
script-src 'unsafe-inline' 'unsafe-eval' blob: https: http://127.0.0.1:*; \
style-src 'unsafe-inline' https: http://127.0.0.1:*; \
img-src * data: blob:; \
font-src * data:; \
media-src * data: blob:; \
object-src * data: blob:; \
connect-src *; \
worker-src 'self' blob:; \
frame-src 'none'; \
child-src 'none';";

pub fn frame_response(_request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let mut response = Response::new(Cow::Borrowed(FRAME_HTML.as_bytes()));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(FRAME_CSP),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}
