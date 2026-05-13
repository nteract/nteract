use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

const ECHO_TTL: Duration = Duration::from_secs(30);
const MAX_ENTRIES_PER_COMM: usize = 64;

#[derive(Debug, Clone)]
struct EchoEntry {
    content_hash: String,
    recorded_at: Instant,
}

#[derive(Debug, Default)]
pub(super) struct EchoSuppressor {
    buckets: HashMap<String, VecDeque<EchoEntry>>,
}

impl EchoSuppressor {
    pub(super) fn record_outgoing(&mut self, comm_id: &str, content_hash: &str) {
        let now = Instant::now();
        let bucket = self.buckets.entry(comm_id.to_string()).or_default();
        evict_expired(bucket, now);
        while bucket.len() >= MAX_ENTRIES_PER_COMM {
            bucket.pop_front();
        }
        bucket.push_back(EchoEntry {
            content_hash: content_hash.to_string(),
            recorded_at: now,
        });
    }

    pub(super) fn is_recent_echo(&mut self, comm_id: &str, content_hash: &str) -> bool {
        let Some(bucket) = self.buckets.get_mut(comm_id) else {
            return false;
        };
        evict_expired(bucket, Instant::now());
        bucket
            .iter()
            .any(|entry| entry.content_hash == content_hash)
    }
}

fn evict_expired(bucket: &mut VecDeque<EchoEntry>, now: Instant) {
    while bucket
        .front()
        .is_some_and(|entry| now.duration_since(entry.recorded_at) > ECHO_TTL)
    {
        bucket.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn age_first(suppressor: &mut EchoSuppressor, comm_id: &str, age: Duration) {
        let entry = suppressor
            .buckets
            .get_mut(comm_id)
            .and_then(|bucket| bucket.front_mut())
            .expect("entry should exist");
        entry.recorded_at = entry.recorded_at.checked_sub(age).unwrap();
    }

    #[test]
    fn immediate_echo_is_recent() {
        let mut suppressor = EchoSuppressor::default();
        suppressor.record_outgoing("comm-a", "hash-a");

        assert!(suppressor.is_recent_echo("comm-a", "hash-a"));
    }

    #[test]
    fn echo_expires_after_ttl() {
        let mut suppressor = EchoSuppressor::default();
        suppressor.record_outgoing("comm-a", "hash-a");
        age_first(&mut suppressor, "comm-a", Duration::from_secs(31));

        assert!(!suppressor.is_recent_echo("comm-a", "hash-a"));
    }

    #[test]
    fn hashes_are_scoped_per_comm() {
        let mut suppressor = EchoSuppressor::default();
        suppressor.record_outgoing("comm-a", "hash-a");

        assert!(!suppressor.is_recent_echo("comm-b", "hash-a"));
    }

    #[test]
    fn cap_evicts_oldest_entry() {
        let mut suppressor = EchoSuppressor::default();
        for index in 0..65 {
            suppressor.record_outgoing("comm-a", &format!("hash-{index}"));
        }

        assert!(!suppressor.is_recent_echo("comm-a", "hash-0"));
        assert!(suppressor.is_recent_echo("comm-a", "hash-1"));
        assert!(suppressor.is_recent_echo("comm-a", "hash-64"));
    }

    #[test]
    fn recorded_outgoing_hash_suppresses_roundtrip_delta() {
        let mut suppressor = EchoSuppressor::default();
        suppressor.record_outgoing("comm-a", "hash-a");

        assert!(suppressor.is_recent_echo("comm-a", "hash-a"));
    }
}
