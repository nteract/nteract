use std::{fs, path::Path};

use serde_json::Value;

fn tauri_config() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "tauri.conf.json should be readable at {}: {err}",
            path.display()
        )
    });
    serde_json::from_str(&raw).unwrap_or_else(|err| {
        panic!(
            "tauri.conf.json should be valid JSON at {}: {err}",
            path.display()
        )
    })
}

fn security(config: &Value) -> &serde_json::Map<String, Value> {
    config
        .pointer("/app/security")
        .and_then(Value::as_object)
        .unwrap_or_else(|| panic!("app.security should be an object"))
}

fn object_field<'a>(
    object: &'a serde_json::Map<String, Value>,
    name: &str,
) -> &'a serde_json::Map<String, Value> {
    object
        .get(name)
        .and_then(Value::as_object)
        .unwrap_or_else(|| panic!("{name} should be configured as an object"))
}

fn directive<'a>(policy: &'a serde_json::Map<String, Value>, name: &str) -> &'a str {
    policy
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{name} should be an inline CSP directive string"))
}

#[test]
fn production_csp_is_enabled_and_restrictive() {
    let config = tauri_config();
    let csp = object_field(security(&config), "csp");

    let script_src = directive(csp, "script-src");
    assert_eq!(
        script_src,
        "'self' 'wasm-unsafe-eval' 'unsafe-eval' blob: https: http://127.0.0.1:* 'sha256-O/N72GCuG1dWVaY+Iz9rjgP7JT4TZuPk7omd2ijEPn4='"
    );
    assert!(!script_src.contains("'unsafe-inline'"));

    assert_eq!(directive(csp, "default-src"), "'self'");
    assert_eq!(
        directive(csp, "style-src"),
        "'self' 'unsafe-inline' https: http://127.0.0.1:*"
    );
    assert_eq!(directive(csp, "base-uri"), "'none'");
    assert_eq!(directive(csp, "form-action"), "'none'");
    assert_eq!(directive(csp, "frame-src"), "blob:");
    assert_eq!(directive(csp, "child-src"), "blob:");
    assert_eq!(directive(csp, "worker-src"), "'self' blob:");
    assert_eq!(
        directive(csp, "object-src"),
        "'self' data: blob: http://127.0.0.1:*"
    );

    let connect_src = directive(csp, "connect-src");
    assert!(connect_src.contains("ipc:"));
    assert!(connect_src.contains("http://ipc.localhost"));
    assert!(connect_src.contains("http://127.0.0.1:*"));
    assert!(!connect_src.contains("https:"));
    assert!(!connect_src.contains("ws:"));
    assert!(!connect_src.contains("wss:"));
}

#[test]
fn development_csp_is_separate_from_packaged_policy() {
    let config = tauri_config();
    let security = security(&config);
    let csp = object_field(security, "csp");
    let dev_csp = object_field(security, "devCsp");

    assert_ne!(csp, dev_csp);

    let dev_script_src = directive(dev_csp, "script-src");
    assert_eq!(
        dev_script_src,
        "'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' http://localhost:*"
    );
    assert!(!dev_script_src.contains("http://localhost:5174"));

    assert!(directive(dev_csp, "default-src").contains("http://localhost:*"));
    assert!(directive(dev_csp, "style-src").contains("http://localhost:*"));
    assert_eq!(
        directive(dev_csp, "worker-src"),
        "'self' blob: http://localhost:*"
    );

    let dev_connect_src = directive(dev_csp, "connect-src");
    assert!(dev_connect_src.contains("ws://localhost:*"));
    assert!(dev_connect_src.contains("http://localhost:*"));
}
