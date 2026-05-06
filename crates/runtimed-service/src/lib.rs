//! Cross-platform service management for the runtimed daemon.
//!
//! Handles installation and management of the daemon as a system service:
//! - macOS 13+: SMAppService agent registration (plist inside the app bundle)
//! - macOS <13: launchd user agent (plist in `~/Library/LaunchAgents/`)
//! - Linux: systemd user service
//! - Windows: Startup shortcut
