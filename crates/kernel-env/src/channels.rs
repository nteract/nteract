//! Shared Conda-channel resolution for Conda and Pixi environments.

use anyhow::Result;
use rattler_conda_types::{Channel, ChannelConfig, MatchSpec, ParseMatchSpecOptions, Platform};

pub(crate) fn resolve_channel_alias(channel: &str) -> &str {
    match channel {
        "main" => "https://repo.anaconda.com/pkgs/main",
        "main-x" => "https://repo.anaconda.cloud/repo/main-x",
        _ => channel,
    }
}

/// Resolve package-specific channels just like the environment's channel list.
pub(crate) fn parse_match_spec(package: &str) -> Result<MatchSpec> {
    let resolved = package
        .split_once("::")
        .map(|(channel, spec)| format!("{}::{spec}", resolve_channel_alias(channel.trim())));
    Ok(MatchSpec::from_str(
        resolved.as_deref().unwrap_or(package),
        ParseMatchSpecOptions::strict(),
    )?)
}

/// The channels represented by Conda's special `defaults` multichannel.
///
/// `rattler_conda_types::Channel` resolves ordinary names against
/// `conda.anaconda.org`; it does not expand Conda's `defaults` alias. Keep the
/// expansion explicit so Conda and Pixi environments reach the official
/// Anaconda repositories rather than a nonexistent community channel.
pub(crate) const ANACONDA_DEFAULT_CHANNELS: &[&str] = &[
    "https://repo.anaconda.com/pkgs/main",
    "https://repo.anaconda.com/pkgs/r",
    "https://repo.anaconda.com/pkgs/msys2",
];

/// Resolve Anaconda aliases and ordinary channels, preserving priority order.
pub fn parse_channels(
    declared_channels: &[String],
    channel_config: &ChannelConfig,
    platform: Platform,
) -> Result<Vec<Channel>> {
    if declared_channels.is_empty() {
        return Ok(vec![Channel::from_str("conda-forge", channel_config)?]);
    }

    let mut channels = Vec::new();
    for declared in declared_channels {
        if declared == "defaults" {
            for default_channel in ANACONDA_DEFAULT_CHANNELS {
                // The msys2 repository is part of Anaconda's Windows defaults;
                // querying it for Unix platforms only produces missing repodata.
                if default_channel.ends_with("/msys2") && !platform.is_windows() {
                    continue;
                }
                channels.push(Channel::from_str(default_channel, channel_config)?);
            }
        } else {
            let channel = resolve_channel_alias(declared);
            channels.push(Channel::from_str(channel, channel_config)?);
        }
    }
    Ok(channels)
}

/// Use the same rattler/Pixi credential store for repodata and package downloads,
/// including lock-based reinstalls. Credentials stay out of channel URLs and
/// notebook metadata; RATTLER_AUTH_FILE can override the standard store.
pub fn download_client() -> Result<reqwest_middleware::ClientWithMiddleware> {
    download_client_with_auth(rattler_networking::AuthenticationMiddleware::from_env_and_defaults())
}

fn download_client_with_auth(
    auth: std::result::Result<
        rattler_networking::AuthenticationMiddleware,
        rattler_networking::authentication_storage::AuthenticationStorageError,
    >,
) -> Result<reqwest_middleware::ClientWithMiddleware> {
    let auth = auth.unwrap_or_else(|_| {
        // A corrupt optional credential store must not disable public channels.
        // Do not log its parse error: it can contain credential values.
        log::warn!("Unable to load rattler/Pixi credentials; continuing without authentication. Check RATTLER_AUTH_FILE and the rattler credential store before using private channels.");
        rattler_networking::AuthenticationMiddleware::from_auth_storage(
            rattler_networking::AuthenticationStorage::empty(),
        )
    });
    Ok(reqwest_middleware::ClientBuilder::new(
        reqwest::Client::builder()
            // Anaconda's package endpoint rejects requests without a User-Agent.
            .user_agent(concat!("nteract/", env!("CARGO_PKG_VERSION")))
            .build()?,
    )
    .with(auth)
    .build())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn downloads_identify_the_client_and_scope_credentials_to_the_host() {
        use rattler_networking::authentication_storage::backends::memory::MemoryStorage;
        use rattler_networking::{Authentication, AuthenticationMiddleware, AuthenticationStorage};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut storage = AuthenticationStorage::empty();
        storage.add_backend(std::sync::Arc::new(MemoryStorage::new()));
        storage
            .store(
                "127.0.0.1",
                &Authentication::BearerToken("test-token".into()),
            )
            .unwrap();
        let client =
            download_client_with_auth(Ok(AuthenticationMiddleware::from_auth_storage(storage)))
                .unwrap();
        let server = tokio::spawn(async move {
            for expect_auth in [true, true, false] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buf = [0; 1024];
                    let count = stream.read(&mut buf).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buf[..count]);
                    if request.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap().to_lowercase();
                assert!(request.contains("user-agent: nteract/"));
                assert_eq!(
                    request.contains("authorization: bearer test-token"),
                    expect_auth
                );
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
            }
        });
        for (host, path) in [
            ("127.0.0.1", "repo/main-x/noarch/repodata.json"),
            ("127.0.0.1", "repo/main-x/noarch/example.conda"),
            ("localhost", "public/noarch/repodata.json"),
        ] {
            client
                .get(format!("http://{host}:{port}/{path}"))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
        }
        server.await.unwrap();
    }

    #[tokio::test]
    async fn malformed_credentials_do_not_block_public_downloads() {
        use rattler_networking::authentication_storage::backends::file::FileStorage;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credentials.json");
        std::fs::write(&path, "invalid json").unwrap();
        // This is the same loader/error used for RATTLER_AUTH_FILE, without
        // mutating process-wide environment variables in a parallel test.
        let error = FileStorage::from_path(path).unwrap_err();
        let client = download_client_with_auth(Err(error.into())).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let size = stream.read(&mut request).await.unwrap();
            assert!(!String::from_utf8_lossy(&request[..size])
                .to_lowercase()
                .contains("authorization:"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        client
            .get(format!("http://{address}/public/repodata.json"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        server.await.unwrap();
    }

    #[test]
    fn package_channel_aliases_match_environment_channels() {
        let config = ChannelConfig::default_with_root_dir(PathBuf::from("/tmp"));
        for channel in ["main", "main-x", "conda-forge", "https://example.org/team"] {
            let spec = parse_match_spec(&format!("{channel}::numpy>=1.24")).unwrap();
            let channels = parse_channels(&[channel.into()], &config, Platform::OsxArm64).unwrap();
            assert_eq!(
                spec.channel.as_ref().unwrap().base_url,
                channels[0].base_url
            );
        }
    }

    #[test]
    fn anaconda_aliases_preserve_declared_priority_and_custom_channels() {
        let config = ChannelConfig::default_with_root_dir(PathBuf::from("/tmp"));
        let channels = parse_channels(
            &[
                "main".into(),
                "main-x".into(),
                "conda-forge".into(),
                "https://packages.example.org/team".into(),
            ],
            &config,
            Platform::OsxArm64,
        )
        .unwrap();
        assert_eq!(
            channels
                .iter()
                .map(|channel| channel.base_url.as_str())
                .collect::<Vec<_>>(),
            vec![
                "https://repo.anaconda.com/pkgs/main/",
                "https://repo.anaconda.cloud/repo/main-x/",
                "https://conda.anaconda.org/conda-forge/",
                "https://packages.example.org/team/",
            ]
        );
    }

    #[test]
    fn defaults_expands_to_anaconda_channels_instead_of_community_alias() {
        let config = ChannelConfig::default_with_root_dir(PathBuf::from("/tmp"));
        let declared = vec!["defaults".to_string()];

        let unix_channels = parse_channels(&declared, &config, Platform::Linux64).unwrap();
        let unix_urls = unix_channels
            .iter()
            .map(|channel| channel.base_url.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            unix_urls,
            vec![
                "https://repo.anaconda.com/pkgs/main/",
                "https://repo.anaconda.com/pkgs/r/",
            ]
        );
        assert!(unix_urls
            .iter()
            .all(|url| !url.contains("conda.anaconda.org/defaults")));

        let windows_channels = parse_channels(&declared, &config, Platform::Win64).unwrap();
        assert_eq!(
            windows_channels
                .iter()
                .map(|channel| channel.base_url.as_str())
                .collect::<Vec<_>>(),
            vec![
                "https://repo.anaconda.com/pkgs/main/",
                "https://repo.anaconda.com/pkgs/r/",
                "https://repo.anaconda.com/pkgs/msys2/",
            ]
        );
    }
}
