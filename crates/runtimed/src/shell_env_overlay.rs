//! Capture the user's login-shell environment once at daemon startup. The
//! daemon's own process env is never modified; the overlay is injected into
//! each `LaunchKernel`/`RestartKernel` RPC's `env_vars` field so the toggle
//! is honored per-launch without a runtime-agent respawn.

use tracing::warn;

#[derive(Debug, Default, Clone)]
pub struct ShellEnvOverlay {
    entries: Vec<(String, String)>,
}

impl ShellEnvOverlay {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn parse_null_separated(bytes: &[u8]) -> Self {
        let mut entries = Vec::new();
        for chunk in bytes.split(|&b| b == 0) {
            if chunk.is_empty() {
                continue;
            }
            let Some(eq_idx) = chunk.iter().position(|&b| b == b'=') else {
                continue;
            };
            let key_bytes = &chunk[..eq_idx];
            let value_bytes = &chunk[eq_idx + 1..];

            let Ok(key) = std::str::from_utf8(key_bytes) else {
                warn!(
                    "[shell-env-overlay] dropping entry with non-UTF-8 key ({} bytes)",
                    key_bytes.len()
                );
                continue;
            };
            let Ok(value) = std::str::from_utf8(value_bytes) else {
                warn!(
                    "[shell-env-overlay] dropping non-UTF-8 value for key {:?}",
                    key
                );
                continue;
            };
            entries.push((key.to_string(), value.to_string()));
        }
        Self { entries }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entries(&self) -> &[(String, String)] {
        &self.entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_null_separated_pairs() {
        let raw = b"FOO=bar\0BAZ=qux\0";
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        assert_eq!(
            overlay.entries(),
            &[
                ("FOO".to_string(), "bar".to_string()),
                ("BAZ".to_string(), "qux".to_string()),
            ]
        );
    }

    #[test]
    fn skips_entries_without_equals() {
        let raw = b"GOOD=value\0BARE_TOKEN\0OTHER=ok\0";
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        assert_eq!(overlay.len(), 2);
        assert_eq!(overlay.entries()[0].0, "GOOD");
        assert_eq!(overlay.entries()[1].0, "OTHER");
    }

    #[test]
    fn handles_values_containing_equals_signs() {
        let raw = b"URL=https://example.com/?a=1&b=2\0";
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        assert_eq!(overlay.len(), 1);
        assert_eq!(overlay.entries()[0].1, "https://example.com/?a=1&b=2");
    }

    #[test]
    fn empty_input_yields_empty_overlay() {
        assert!(ShellEnvOverlay::parse_null_separated(b"").is_empty());
        assert!(ShellEnvOverlay::parse_null_separated(b"\0\0\0").is_empty());
    }

    #[test]
    fn handles_multiline_values() {
        let raw = b"MULTI=line1\nline2\nline3\0NEXT=ok\0";
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        assert_eq!(overlay.len(), 2);
        assert_eq!(overlay.entries()[0].1, "line1\nline2\nline3");
    }

    #[test]
    fn drops_non_utf8_values_silently() {
        let raw: &[u8] = &[
            b'G', b'O', b'O', b'D', b'=', b'v', b'a', b'l', 0, b'B', b'A', b'D', b'=', 0xff, 0xfe,
            0, b'O', b'K', b'=', b'1', b'2', b'3', b'4', b'5', b'6', b'7', b'8', 0,
        ];
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        let keys: Vec<&str> = overlay.entries().iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["GOOD", "OK"]);
    }
}
