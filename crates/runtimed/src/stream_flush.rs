//! Coalescing policy for noisy stdout/stderr IOPub streams.
//!
//! The Jupyter IOPub reader must stay responsive enough to observe status
//! messages such as `idle` after an interrupt. Writing every tiny stream chunk
//! through blob storage and Automerge makes that reader do too much work per
//! frame, so stream writes are flushed early once, then coalesced within bounded
//! byte/time thresholds.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// One coalescing entry per terminal segment: (execution_id, stream_name, segment).
type StreamKey = (String, String, u64);

pub(crate) const STREAM_FLUSH_MAX_DELAY: Duration = Duration::from_millis(75);
pub(crate) const STREAM_FLUSH_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingStreamFlush {
    pub execution_id: String,
    pub stream_name: String,
    /// Terminal segment this flush renders. Segments split a stream where the
    /// other stream interleaved; each maps to one output in the document.
    pub segment: u64,
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
        segment: u64,
        chunk_bytes: usize,
        now: Instant,
    ) -> Option<PendingStreamFlush> {
        let key = (execution_id.to_string(), stream_name.to_string(), segment);
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

    /// Take every segment of an execution for a boundary flush.
    ///
    /// Clean segments are included on purpose: a periodic flush may still be
    /// queued behind this boundary, and re-rendering the live segment here is
    /// what makes its latest text durable before the boundary's signal. Sealed
    /// segments have been retired by their own ordered flush by the time this
    /// runs, so the committer skips them instead of appending a second copy.
    /// Segments are returned in creation order so earlier text commits first.
    pub(crate) fn flush_execution(
        &mut self,
        execution_id: &str,
        now: Instant,
    ) -> Vec<PendingStreamFlush> {
        let mut keys: Vec<_> = self
            .entries
            .keys()
            .filter(|(eid, _, _)| eid == execution_id)
            .cloned()
            .collect();
        keys.sort_by_key(|(_, _, segment)| *segment);
        keys.into_iter()
            .filter_map(|key| self.take_key(&key, now))
            .collect()
    }

    /// Take one segment's flush.
    ///
    /// Used when the other stream interleaves: the sealed segment must reach
    /// the document before the next stream's output is appended, and its
    /// terminal is retired after that commit, so it is flushed even when clean.
    pub(crate) fn take_segment(
        &mut self,
        execution_id: &str,
        stream_name: &str,
        segment: u64,
        now: Instant,
    ) -> Option<PendingStreamFlush> {
        let key = (execution_id.to_string(), stream_name.to_string(), segment);
        self.take_key(&key, now)
    }

    pub(crate) fn clear_execution(&mut self, execution_id: &str) {
        self.entries.retain(|(eid, _, _), _| eid != execution_id);
    }

    fn take_key(&mut self, key: &StreamKey, now: Instant) -> Option<PendingStreamFlush> {
        let entry = self.entries.get_mut(key)?;
        entry.pending_bytes = 0;
        entry.has_flushed = true;
        entry.last_flush = now;
        Some(PendingStreamFlush {
            execution_id: key.0.clone(),
            stream_name: key.1.clone(),
            segment: key.2,
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
            .record_chunk("e1", "stdout", 0, 5, now)
            .expect("first chunk should flush");

        assert_eq!(flush.execution_id, "e1");
        assert_eq!(flush.stream_name, "stdout");
    }

    #[test]
    fn subsequent_small_chunks_are_coalesced_until_delay() {
        let now = Instant::now();
        let mut buffer = buffer();
        assert!(buffer.record_chunk("e1", "stdout", 0, 1, now).is_some());
        assert!(buffer
            .record_chunk("e1", "stdout", 0, 1, now + Duration::from_millis(10))
            .is_none());

        buffer
            .record_chunk("e1", "stdout", 0, 1, now + Duration::from_millis(100))
            .expect("delay should flush");
    }

    #[test]
    fn byte_threshold_flushes() {
        let now = Instant::now();
        let mut buffer = buffer();
        assert!(buffer.record_chunk("e1", "stdout", 0, 1, now).is_some());
        assert!(buffer.record_chunk("e1", "stdout", 0, 6, now).is_none());

        buffer
            .record_chunk("e1", "stdout", 0, 4, now)
            .expect("byte threshold should flush");
    }

    #[test]
    fn flush_execution_returns_all_dirty_streams_for_execution() {
        let now = Instant::now();
        let mut buffer = buffer();
        assert!(buffer.record_chunk("e1", "stdout", 0, 3, now).is_some());
        assert!(buffer.record_chunk("e1", "stdout", 0, 4, now).is_none());
        assert!(buffer.record_chunk("e1", "stderr", 0, 3, now).is_some());
        assert!(buffer.record_chunk("e1", "stderr", 0, 4, now).is_none());
        assert!(buffer.record_chunk("e2", "stdout", 0, 5, now).is_some());
        assert!(buffer.record_chunk("e2", "stdout", 0, 6, now).is_none());

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
    fn flush_execution_orders_segments_by_creation() {
        let now = Instant::now();
        let mut buffer = buffer();
        for segment in [2_u64, 0, 1] {
            assert!(buffer
                .record_chunk("e1", "stdout", segment, 3, now)
                .is_some());
            assert!(buffer
                .record_chunk("e1", "stdout", segment, 2, now)
                .is_none());
        }

        let flushes = buffer.flush_execution("e1", now);
        let segments: Vec<u64> = flushes.iter().map(|flush| flush.segment).collect();
        assert_eq!(segments, vec![0, 1, 2]);
    }

    #[test]
    fn take_segment_flushes_a_clean_segment() {
        let now = Instant::now();
        let mut buffer = buffer();
        assert!(buffer.record_chunk("e1", "stdout", 0, 3, now).is_some());

        let flush = buffer
            .take_segment("e1", "stdout", 0, now)
            .expect("sealed segment flushes even when clean");
        assert_eq!(flush.segment, 0);
        assert!(buffer.take_segment("e1", "stdout", 7, now).is_none());
    }

    #[test]
    fn clear_execution_discards_dirty_streams() {
        let now = Instant::now();
        let mut buffer = buffer();
        assert!(buffer.record_chunk("e1", "stdout", 0, 3, now).is_some());
        assert!(buffer.record_chunk("e1", "stdout", 0, 4, now).is_none());

        buffer.clear_execution("e1");

        assert!(buffer.flush_execution("e1", now).is_empty());
    }
}
