use notebook::iframe_shell::{frame_response, FRAME_CSP, FRAME_HTML, FRAME_SCHEME};
use tauri::http::{header, Request, StatusCode};

fn request_for(path: &str) -> Request<Vec<u8>> {
    Request::builder()
        .uri(format!("nteract-frame://localhost{path}"))
        .body(Vec::new())
        .expect("test request should be valid")
}

#[test]
fn handler_returns_200_with_html_content_type() {
    let response = frame_response(&request_for("/"));

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/html; charset=utf-8"
    );
    assert_eq!(response.body().as_ref(), FRAME_HTML.as_bytes());
}

#[test]
fn handler_emits_no_store_cache_control() {
    let response = frame_response(&request_for("/"));

    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-store, no-cache, must-revalidate"
    );
    assert_eq!(response.headers().get(header::PRAGMA).unwrap(), "no-cache");
}

#[test]
fn handler_emits_csp_with_frame_src_none() {
    let response = frame_response(&request_for("/"));
    let csp = response
        .headers()
        .get(header::CONTENT_SECURITY_POLICY)
        .unwrap()
        .to_str()
        .unwrap();

    assert!(csp.contains("frame-src 'none'"));
    assert!(csp.contains("child-src 'none'"));
}

#[test]
fn handler_csp_matches_html_meta_csp() {
    let response = frame_response(&request_for("/"));
    let response_csp = response
        .headers()
        .get(header::CONTENT_SECURITY_POLICY)
        .unwrap()
        .to_str()
        .unwrap();
    let meta_prefix = "<meta http-equiv=\"Content-Security-Policy\" content=\"";
    let meta_start = FRAME_HTML.find(meta_prefix).unwrap() + meta_prefix.len();
    let meta_end = FRAME_HTML[meta_start..].find("\">").unwrap() + meta_start;

    assert_eq!(response_csp, &FRAME_HTML[meta_start..meta_end]);
    assert_eq!(response_csp, FRAME_CSP);
}

#[test]
fn handler_serves_same_response_for_any_path() {
    let root = frame_response(&request_for("/"));
    let nested = frame_response(&request_for("/nested/path?cache-bust=1"));

    assert_eq!(root.status(), nested.status());
    assert_eq!(root.headers(), nested.headers());
    assert_eq!(root.body().as_ref(), nested.body().as_ref());
}

#[test]
fn html_contains_event_source_validation() {
    assert!(FRAME_HTML.contains("event.source !== window.parent"));
}

#[test]
fn html_starts_with_doctype() {
    assert!(FRAME_HTML.starts_with("<!DOCTYPE html>"));
}

#[test]
fn scheme_name_is_windows_hostname_safe() {
    assert!(FRAME_SCHEME
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-'));
}
