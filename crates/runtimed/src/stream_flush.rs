//! Coalescing policy for noisy stdout/stderr IOPub streams.
//!
//! The Jupyter IOPub reader must stay responsive enough to observe status
//! messages such as `idle` after an interrupt. Writing every tiny stream chunk
//! through blob storage and Automerge makes that reader do too much work per
//! frame, so stream writes are flushed early once, then coalesced within bounded
//! byte/time thresholds.

use std::collections::HashMap;
use std::time::{Duration, Instant};

type StreamKey = (String, String);

pub(crate) const STREAM_FLUSH_MAX_DELAY: Duration = Duration::from_millis(75);
pub(crate) const STREAM_FLUSH_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingStreamFlush {
    pub execution_id: String,
    pub stream_name: String,
}

#[derive(Debug, Clone)]
struct StreamFlushEntry {
    pending_bytes: usize,
    has_flushed: bool,
    last_flush: Instant,
}

#[derive(Debug)]
pub(crate) struct StreamFlushBuffer {
    max_delay: Duration,
    max_bytes: usize,
    entries: HashMap<StreamKey, StreamFlushEntry>,
}

impl Default for StreamFlushBuffer {
    fn default() -> Self {
        Self::new(STREAM_FLUSH_MAX_DELAY, STREAM_FLUSH_MAX_BYTES)
    }
}

impl StreamFlushBuffer {
    pub(crate) fn new(max_delay: Duration, max_bytes: usize) -> Self {
        Self {
            max_delay,
            max_bytes,
            entries: HashMap::new(),
        }
    }

    pub(crate) fn record_chunk(
        &mut self,
        execution_id: &str,
        stream_name: &str,
        chunk_bytes: usize,
        now: Instant,
    ) -> Option<PendingStreamFlush> {
        let key = (execution_id.to_string(), stream_name.to_string());
        let entry = self.entries.entry(key.clone()).or_insert(StreamFlushEntry {
            pending_bytes: 0,
            has_flushed: false,
            last_flush: now,
        });
        entry.pending_bytes = entry.pending_bytes.saturating_add(chunk_bytes);

        let delay_elapsed =
            entry.has_flushed && now.duration_since(entry.last_flush) >= self.max_delay;
        let bytes_exceeded = entry.pending_bytes >= self.max_bytes;
        if !entry.has_flushed || delay_elapsed || bytes_exceeded {
            return self.take_key(&key, now);
        }

        None
    }

    pub(crate) fn flush_execution(
        &mut self,
        execution_id: &str,
        now: Instant,
    ) -> Vec<PendingStreamFlush> {
        let keys: Vec<_> = self
            .entries
            .keys()
            .filter(|(eid, _)| eid == execution_id)
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|key| self.take_key(&key, now))
            .collect()
    }

    pub(crate) fn clear_execution(&mut self, execution_id: &str) {
        self.entries.retain(|(eid, _), _| eid != execution_id);
    }

    fn take_key(&mut self, key: &StreamKey, now: Instant) -> Option<PendingStreamFlush> {
        let entry = self.entries.get_mut(key)?;
        entry.pending_bytes = 0;
        entry.has_flushed = true;
        entry.last_flush = now;
        Some(PendingStreamFlush {
            execution_id: key.0.clone(),
            stream_name: key.1.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buffer() -> StreamFlushBuffer {
        StreamFlushBuffer::new(Duration::from_millis(100), 10)
    }

    #[test]
    fn first_chunk_flushes_immediately() {
        let now = Instant::now();
        let mut buffer = buffer();

        let flush = buffer
            .record_chunk("e1", "stdout", 5, now)
            .expect("first chunk should flush");

        assert_eq!(flush.execution_id, "e1");
        assert_eq!(flush.stream_name, "stdout");
    }

    #[test]
    fn subsequent_small_chunks_are_coalesced_until_delay() {
        let now = Instant::now();
        let mut buffer = buffer();
        assert!(buffer.record_chunk("e1", "stdout", 1, now).is_some());
        assert!(buffer
            .record_chunk("e1", "stdout", 1, now + Duration::from_millis(10))
            .is_none());

        buffer
            .record_chunk("e1", "stdout", 1, now + Duration::from_millis(100))
            .expect("delay should flush");
    }

    #[test]
    fn byte_threshold_flushes() {
        let now = Instant::now();
        let mut buffer = buffer();
        assert!(buffer.record_chunk("e1", "stdout", 1, now).is_some());
        assert!(buffer.record_chunk("e1", "stdout", 6, now).is_none());

        buffer
            .record_chunk("e1", "stdout", 4, now)
            .expect("byte threshold should flush");
    }

    #[test]
    fn flush_execution_returns_all_dirty_streams_for_execution() {
        let now = Instant::now();
        let mut buffer = buffer();
        assert!(buffer.record_chunk("e1", "stdout", 3, now).is_some());
        assert!(buffer.record_chunk("e1", "stdout", 4, now).is_none());
        assert!(buffer.record_chunk("e1", "stderr", 3, now).is_some());
        assert!(buffer.record_chunk("e1", "stderr", 4, now).is_none());
        assert!(buffer.record_chunk("e2", "stdout", 5, now).is_some());
        assert!(buffer.record_chunk("e2", "stdout", 6, now).is_none());

        let mut flushes = buffer.flush_execution("e1", now);
        flushes.sort_by(|a, b| a.stream_name.cmp(&b.stream_name));

        assert_eq!(flushes.len(), 2);
        assert_eq!(flushes[0].stream_name, "stderr");
        assert_eq!(flushes[1].stream_name, "stdout");

        let remaining = buffer.flush_execution("e2", now);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].execution_id, "e2");
        assert_eq!(remaining[0].stream_name, "stdout");
    }

    #[test]
    fn clear_execution_discards_dirty_streams() {
        let now = Instant::now();
        let mut buffer = buffer();
        assert!(buffer.record_chunk("e1", "stdout", 3, now).is_some());
        assert!(buffer.record_chunk("e1", "stdout", 4, now).is_none());

        buffer.clear_execution("e1");

        assert!(buffer.flush_execution("e1", now).is_empty());
    }
}
