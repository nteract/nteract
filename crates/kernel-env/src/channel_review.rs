//! Inspect CEP-42 relationships before choosing the channels allowed to solve.
//!
//! Discovery reads repository metadata only. It neither grants trust nor changes
//! notebook/project intent. The owner must review the returned ordered snapshot,
//! fence it to its dependency revision, and pass that exact list to a solver
//! with automatic channel discovery disabled.

use std::collections::{BTreeSet, VecDeque};

use anyhow::{anyhow, bail, Result};
use rattler_conda_types::{Channel, ChannelUrl, Subdir};
use rattler_repodata_gateway::Gateway;
use serde::{Deserialize, Serialize};

/// Limits apply to the complete graph, including explicitly selected channels.
#[derive(Debug, Clone, Copy)]
pub struct DiscoveryLimits {
    pub max_depth: usize,
    pub max_channels: usize,
}

impl Default for DiscoveryLimits {
    fn default() -> Self {
        Self {
            max_depth: 10,
            max_channels: 32,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    Base,
    Overrides,
}

/// Provenance includes the subdir: two subdirs can declare different relations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelRelation {
    pub declaring_channel: String,
    pub subdir: String,
    pub kind: RelationKind,
    pub target_channel: String,
    /// Explicit channel order takes precedence over a conflicting relation.
    pub ignored_for_priority: bool,
}

/// A discovery result, not an authorization. URLs are canonical channel roots.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelReview {
    pub declared_channels: Vec<String>,
    /// Highest priority first; preserves the declared channels' relative order.
    pub effective_channels: Vec<String>,
    pub relations: Vec<ChannelRelation>,
    /// Metadata has not been read from these channels. Consent is required
    /// before continuing discovery; this snapshot is not ready for solving.
    pub uninspected_channels: Vec<String>,
}

impl ChannelReview {
    pub fn additional_channels(&self) -> impl Iterator<Item = &str> {
        self.effective_channels
            .iter()
            .filter(|channel| !self.declared_channels.contains(channel))
            .map(String::as_str)
    }
}

#[derive(Debug, Clone)]
struct Node {
    channel: Channel,
    depth: usize,
}

#[derive(Debug, Clone)]
struct Discovery {
    declared: Vec<String>,
    nodes: Vec<Node>,
    platforms: Vec<Subdir>,
    pending: VecDeque<(usize, usize)>,
    relations: Vec<ChannelRelation>,
    limits: DiscoveryLimits,
    approved_metadata_channels: Vec<String>,
}

/// There is exactly one outstanding metadata request. Its result is applied by
/// `transition`; network/cache effects never mutate the traversal directly.
#[derive(Debug)]
enum DiscoveryState {
    Fetching(Discovery),
    Complete(ChannelReview),
    Failed(String),
}

enum DiscoveryEvent {
    Metadata(Result<Option<rattler_conda_types::ChannelRelations>, String>),
}

impl Discovery {
    fn start(
        channels: Vec<Channel>,
        platforms: Vec<Subdir>,
        approved_metadata_channels: Vec<String>,
        limits: DiscoveryLimits,
    ) -> Result<Self> {
        if platforms.is_empty() {
            bail!("Channel review requires at least one target subdir");
        }
        let mut state = Self {
            declared: Vec::new(),
            nodes: Vec::new(),
            platforms: Vec::new(),
            pending: VecDeque::new(),
            relations: Vec::new(),
            limits,
            approved_metadata_channels,
        };
        for platform in platforms {
            if !state.platforms.contains(&platform) {
                state.platforms.push(platform);
            }
        }
        for channel in channels {
            let identity = channel.base_url.to_string();
            if !channel.base_url.url().username().is_empty()
                || channel.base_url.url().password().is_some()
            {
                bail!("Channel review requires credentials in the authentication store, not channel URLs");
            }
            if !state.declared.contains(&identity) {
                state.declared.push(identity);
                state.add_node(channel, 0)?;
            }
        }
        Ok(state)
    }

    fn add_node(&mut self, channel: Channel, depth: usize) -> Result<()> {
        if depth > self.limits.max_depth {
            bail!("Related-channel discovery exceeded its depth limit; list the required channels explicitly");
        }
        if self.nodes.len() >= self.limits.max_channels {
            bail!("Related-channel discovery exceeded its channel limit; list the required channels explicitly");
        }
        let index = self.nodes.len();
        let inspect = depth == 0
            || self
                .approved_metadata_channels
                .contains(&channel.base_url.to_string());
        self.nodes.push(Node { channel, depth });
        if !inspect {
            return Ok(());
        }
        for platform in 0..self.platforms.len() {
            self.pending.push_back((index, platform));
        }
        Ok(())
    }

    fn receive(&mut self, metadata: Option<rattler_conda_types::ChannelRelations>) -> Result<()> {
        let (index, platform) = self
            .pending
            .pop_front()
            .ok_or_else(|| anyhow!("No pending channel metadata request"))?;
        let Some(metadata) = metadata else {
            return Ok(());
        };
        let node = self.nodes[index].clone();
        let declaring = node.channel.base_url;
        let base = metadata
            .base
            .as_deref()
            .map(|value| resolve_reference(&declaring, value))
            .transpose()?;
        let overrides = metadata
            .overrides
            .as_deref()
            .map(|value| resolve_reference(&declaring, value))
            .transpose()?;
        if base.is_some() && base == overrides {
            bail!("A channel declares the same base and override; correct its relationship metadata or list channels explicitly");
        }
        for (kind, target) in [
            (RelationKind::Base, base),
            (RelationKind::Overrides, overrides),
        ] {
            let Some(target) = target else { continue };
            if target == declaring {
                bail!("A channel declares a relationship with itself; correct its relationship metadata or list channels explicitly");
            }
            if !self
                .nodes
                .iter()
                .any(|known| known.channel.base_url == target)
            {
                // Breadth-first traversal guarantees the first path is shortest.
                self.add_node(Channel::from_url(target.clone()), node.depth + 1)?;
            }
            let declaring_channel = declaring.to_string();
            let target_channel = target.to_string();
            let (higher, lower) = match kind {
                RelationKind::Base => (&target_channel, &declaring_channel),
                RelationKind::Overrides => (&declaring_channel, &target_channel),
            };
            let ignored_for_priority = match (
                self.declared.iter().position(|channel| channel == higher),
                self.declared.iter().position(|channel| channel == lower),
            ) {
                (Some(higher), Some(lower)) => higher > lower,
                _ => false,
            };
            self.relations.push(ChannelRelation {
                declaring_channel,
                subdir: self.platforms[platform].to_string(),
                kind,
                target_channel,
                ignored_for_priority,
            });
        }
        Ok(())
    }

    fn finish(self) -> Result<ChannelReview> {
        let mut edges: BTreeSet<(String, String)> = self
            .declared
            .windows(2)
            .map(|pair| (pair[0].clone(), pair[1].clone()))
            .collect();
        for relation in &self.relations {
            if relation.ignored_for_priority {
                continue;
            }
            let (higher, lower) = match relation.kind {
                RelationKind::Base => (&relation.target_channel, &relation.declaring_channel),
                RelationKind::Overrides => (&relation.declaring_channel, &relation.target_channel),
            };
            edges.insert((higher.clone(), lower.clone()));
        }
        // Stable topological sort: explicit order, then canonical URL order for
        // otherwise unconstrained discovered channels. Never break a cycle by
        // silently choosing an unreviewed priority interpretation.
        let mut remaining = self.declared.clone();
        let mut discovered: Vec<_> = self
            .nodes
            .iter()
            .map(|node| node.channel.base_url.to_string())
            .filter(|url| !self.declared.contains(url))
            .collect();
        discovered.sort();
        remaining.extend(discovered);
        let mut order = Vec::with_capacity(remaining.len());
        while !remaining.is_empty() {
            let Some(index) = remaining
                .iter()
                .position(|candidate| !edges.iter().any(|(_, lower)| lower == candidate))
            else {
                bail!("Related channels have conflicting priority requirements; correct their relationship metadata or list the required channels explicitly");
            };
            let next = remaining.remove(index);
            edges.retain(|(higher, _)| higher != &next);
            order.push(next);
        }
        let uninspected_channels = order
            .iter()
            .filter(|url| {
                !self.declared.contains(url) && !self.approved_metadata_channels.contains(url)
            })
            .cloned()
            .collect();
        Ok(ChannelReview {
            declared_channels: self.declared,
            effective_channels: order,
            relations: self.relations,
            uninspected_channels,
        })
    }
}

fn transition(state: DiscoveryState, event: DiscoveryEvent) -> DiscoveryState {
    let DiscoveryState::Fetching(mut discovery) = state else {
        return state;
    };
    let DiscoveryEvent::Metadata(metadata) = event;
    match metadata
        .map_err(anyhow::Error::msg)
        .and_then(|value| discovery.receive(value))
    {
        Err(error) => DiscoveryState::Failed(error.to_string()),
        Ok(()) if discovery.pending.is_empty() => match discovery.finish() {
            Ok(review) => DiscoveryState::Complete(review),
            Err(error) => DiscoveryState::Failed(error.to_string()),
        },
        Ok(()) => DiscoveryState::Fetching(discovery),
    }
}

fn resolve_reference(declaring: &ChannelUrl, reference: &str) -> Result<ChannelUrl> {
    let reference = reference.trim();
    if !(reference == ".." || reference.starts_with("../"))
        || reference.contains(['?', '#', '\\'])
        || reference.contains("://")
        || reference
            .trim_end_matches('/')
            .split('/')
            .any(str::is_empty)
        || reference.ends_with("//")
    {
        bail!(
            "Invalid relative channel relationship; expected a ../ path without query or fragment"
        );
    }
    Ok(ChannelUrl::from(declaring.url().join(reference)?))
}

/// Discover relationships with a caller-configured cache-only gateway and an
/// optional network fallback. Passing `None` enforces offline-only discovery:
/// missing metadata is an error, never an empty (apparently complete) review.
///
/// Metadata from newly discovered channels is read only when their canonical
/// URL is in `approved_metadata_channels`. Otherwise the review returns those
/// URLs in `uninspected_channels`; callers must obtain consent and repeat
/// discovery before solving. Package records are never solved or installed. Callers own approval and revision
/// checks; this function grants no authority to use any returned channel.
pub async fn discover_channel_review(
    channels: Vec<Channel>,
    platforms: Vec<Subdir>,
    approved_metadata_channels: Vec<String>,
    cache: &Gateway,
    network: Option<&Gateway>,
    limits: DiscoveryLimits,
) -> Result<ChannelReview> {
    let discovery = Discovery::start(channels, platforms, approved_metadata_channels, limits)?;
    if discovery.pending.is_empty() {
        return discovery.finish();
    }
    let mut state = DiscoveryState::Fetching(discovery);
    loop {
        let DiscoveryState::Fetching(discovery) = &state else {
            return match state {
                DiscoveryState::Complete(review) => Ok(review),
                DiscoveryState::Failed(error) => Err(anyhow!(error)),
                DiscoveryState::Fetching(_) => unreachable!(),
            };
        };
        let &(channel, platform) = discovery
            .pending
            .front()
            .ok_or_else(|| anyhow!("No pending channel metadata request"))?;
        let channel = &discovery.nodes[channel].channel;
        let platform = discovery.platforms[platform];
        let result = match cache.channel_relations(channel, platform).await {
            Ok(metadata) => Ok(metadata),
            Err(error) => match network {
                Some(network) => network.channel_relations(channel, platform).await,
                None => Err(error),
            },
        };
        state = transition(
            state,
            DiscoveryEvent::Metadata(
                result.map_err(|error| format!("Cannot review related channels: {error}")),
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rattler_conda_types::{ChannelConfig, ChannelRelations};

    fn channel(name: &str) -> Channel {
        Channel::from_str(
            format!("https://example.test/{name}"),
            &ChannelConfig::default_with_root_dir(std::env::current_dir().unwrap()),
        )
        .unwrap()
    }

    fn machine(declared: &[&str], approved: &[&str]) -> DiscoveryState {
        let discovery = Discovery::start(
            declared.iter().map(|name| channel(name)).collect(),
            vec![Subdir::Linux64, Subdir::NoArch],
            approved
                .iter()
                .map(|name| channel(name).base_url.to_string())
                .collect(),
            DiscoveryLimits::default(),
        )
        .unwrap();
        if discovery.pending.is_empty() {
            DiscoveryState::Complete(discovery.finish().unwrap())
        } else {
            DiscoveryState::Fetching(discovery)
        }
    }

    fn metadata(
        state: DiscoveryState,
        base: Option<&str>,
        overrides: Option<&str>,
    ) -> DiscoveryState {
        transition(
            state,
            DiscoveryEvent::Metadata(Ok(Some(ChannelRelations {
                base: base.map(str::to_owned),
                overrides: overrides.map(str::to_owned),
            }))),
        )
    }

    fn complete(mut state: DiscoveryState) -> ChannelReview {
        while matches!(state, DiscoveryState::Fetching(_)) {
            state = transition(state, DiscoveryEvent::Metadata(Ok(None)));
        }
        match state {
            DiscoveryState::Complete(review) => review,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn stops_at_unapproved_frontier_and_preserves_subdir_provenance() {
        let state = metadata(machine(&["a"], &[]), Some("../b"), None);
        let state = metadata(state, None, Some("../c"));
        let review = complete(state);
        assert_eq!(
            review.effective_channels,
            ["b", "a", "c"].map(|name| channel(name).base_url.to_string())
        );
        assert_eq!(
            review.uninspected_channels,
            ["b", "c"].map(|name| channel(name).base_url.to_string())
        );
        assert_eq!(review.relations[0].subdir, "linux-64");
        assert_eq!(review.relations[1].subdir, "noarch");
    }

    #[test]
    fn approved_frontier_discovers_transitive_sources_then_stops_again() {
        let state = metadata(machine(&["a"], &["b"]), Some("../b"), None);
        let state = metadata(state, None, None);
        let state = metadata(state, Some("../c"), None);
        let review = complete(state);
        assert_eq!(
            review.effective_channels,
            ["c", "b", "a"].map(|name| channel(name).base_url.to_string())
        );
        assert_eq!(
            review.uninspected_channels,
            [channel("c").base_url.to_string()]
        );
    }

    #[test]
    fn explicit_order_wins_and_conflict_is_visible() {
        let state = metadata(machine(&["a", "b"], &[]), Some("../b"), None);
        let review = complete(state);
        assert_eq!(review.effective_channels, review.declared_channels);
        assert!(review.relations[0].ignored_for_priority);
        assert!(review.uninspected_channels.is_empty());
    }

    #[test]
    fn priority_cycle_fails_instead_of_silently_dropping_a_relationship() {
        let state = metadata(machine(&["a"], &["b"]), Some("../b"), None);
        let state = metadata(state, None, None);
        let state = metadata(state, Some("../a"), None);
        let state = metadata(state, None, None);
        assert!(
            matches!(state, DiscoveryState::Failed(ref error) if error.contains("conflicting priority"))
        );
    }

    #[test]
    fn reciprocal_consistent_declarations_are_not_a_priority_cycle() {
        let state = metadata(machine(&["a"], &["b"]), Some("../b"), None);
        let state = metadata(state, None, None);
        let state = metadata(state, None, Some("../a"));
        let review = complete(state);
        assert_eq!(
            review.effective_channels,
            ["b", "a"].map(|name| channel(name).base_url.to_string())
        );
    }

    #[test]
    fn malformed_relationships_fail_closed() {
        for (base, overrides) in [
            ("../a", None),
            ("../b", Some("../b/")),
            ("https://other.test/b", None),
            ("../b?token=secret", None),
            ("../b#fragment", None),
            ("../b\\c", None),
            ("..//b", None),
        ] {
            assert!(
                matches!(
                    metadata(machine(&["a"], &[]), Some(base), overrides),
                    DiscoveryState::Failed(_)
                ),
                "{base}"
            );
        }
    }

    #[test]
    fn canonical_urls_deduplicate_declared_channels() {
        let state = machine(&["a", "a/", "a/../a"], &[]);
        let review = complete(state);
        assert_eq!(
            review.declared_channels,
            [channel("a").base_url.to_string()]
        );
    }

    #[test]
    fn limits_fail_without_returning_an_incomplete_success() {
        for limits in [
            DiscoveryLimits {
                max_depth: 0,
                max_channels: 32,
            },
            DiscoveryLimits {
                max_depth: 10,
                max_channels: 1,
            },
        ] {
            let state = DiscoveryState::Fetching(
                Discovery::start(vec![channel("a")], vec![Subdir::NoArch], vec![], limits).unwrap(),
            );
            assert!(matches!(
                metadata(state, Some("../b"), None),
                DiscoveryState::Failed(_)
            ));
        }
    }

    #[test]
    fn metadata_failure_and_terminal_states_never_advance() {
        let state = transition(
            machine(&["a"], &[]),
            DiscoveryEvent::Metadata(Err("offline cache miss".into())),
        );
        assert!(matches!(&state, DiscoveryState::Failed(error) if error == "offline cache miss"));
        assert!(matches!(
            metadata(state, None, None),
            DiscoveryState::Failed(_)
        ));
        let review = complete(machine(&[], &[]));
        let state = metadata(
            DiscoveryState::Complete(review.clone()),
            Some("../surprise"),
            None,
        );
        assert!(matches!(state, DiscoveryState::Complete(actual) if actual == review));
    }
}
