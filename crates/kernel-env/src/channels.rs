//! Shared Conda-channel resolution for Conda and Pixi environments.

use anyhow::Result;
use rattler_conda_types::{Channel, ChannelConfig, Platform};

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

pub(crate) fn parse_channels(
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
            channels.push(Channel::from_str(declared, channel_config)?);
        }
    }
    Ok(channels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
