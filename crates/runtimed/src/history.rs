//! Kernel input history normalization.
//!
//! IPython is one provider of raw history rows. The daemon owns the contract
//! exposed to clients: stable source identity, newest-first ordering, optional
//! deduplication, and a rank callers can preserve through client-side filters.

use crate::protocol::HistoryEntry;

const CURRENT_SESSION_RANK: i64 = i64::MAX;
const HISTORY_DEDUPE_OVERFETCH_FACTOR: i32 = 3;
const MAX_PROVIDER_HISTORY_LIMIT: i32 = 1_000;

fn session_recency_rank(session: i32) -> i64 {
    // IPython uses session 0 for entries from the current interactive session.
    // Rank it above persisted session ids if it appears in a mixed result set.
    if session == 0 {
        CURRENT_SESSION_RANK
    } else {
        session as i64
    }
}

fn compare_history_entries_by_recency(a: &HistoryEntry, b: &HistoryEntry) -> std::cmp::Ordering {
    session_recency_rank(b.session)
        .cmp(&session_recency_rank(a.session))
        .then_with(|| b.line.cmp(&a.line))
}

pub(crate) fn history_source_key(source: &str) -> String {
    source
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_string()
}

pub(crate) fn raw_history_entry(session: i32, line: i32, source: String) -> HistoryEntry {
    let source_key = history_source_key(&source);
    HistoryEntry {
        session,
        line,
        source,
        source_key,
        recency_rank: 0,
    }
}

pub(crate) fn provider_history_limit(limit: i32, dedupe: bool) -> i32 {
    if !dedupe || limit <= 0 {
        return limit;
    }

    limit
        .saturating_mul(HISTORY_DEDUPE_OVERFETCH_FACTOR)
        .clamp(limit, MAX_PROVIDER_HISTORY_LIMIT)
}

pub(crate) fn normalize_history_entries(
    entries: Vec<HistoryEntry>,
    limit: i32,
    dedupe: bool,
) -> Vec<HistoryEntry> {
    let mut entries: Vec<HistoryEntry> = if dedupe {
        let mut latest_by_source = std::collections::HashMap::<String, HistoryEntry>::new();

        for mut entry in entries {
            entry.source_key = history_source_key(&entry.source);
            if entry.source_key.is_empty() {
                continue;
            }

            latest_by_source
                .entry(entry.source_key.clone())
                .and_modify(|existing| {
                    if compare_history_entries_by_recency(&entry, existing).is_lt() {
                        *existing = entry.clone();
                    }
                })
                .or_insert(entry);
        }

        latest_by_source.into_values().collect()
    } else {
        entries
            .into_iter()
            .filter_map(|mut entry| {
                entry.source_key = history_source_key(&entry.source);
                (!entry.source_key.is_empty()).then_some(entry)
            })
            .collect()
    };

    entries.sort_by(compare_history_entries_by_recency);

    let limit = limit.max(0) as usize;
    if limit < entries.len() {
        entries.truncate(limit);
    }

    for (idx, entry) in entries.iter_mut().enumerate() {
        entry.recency_rank = idx as u32;
    }

    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_history_to_newest_unique_sources() {
        let entries = normalize_history_entries(
            vec![
                raw_history_entry(12, 4, "x = 1".to_string()),
                raw_history_entry(12, 9, "print(x)".to_string()),
                raw_history_entry(13, 1, "x = 1".to_string()),
                raw_history_entry(11, 20, "print(x)".to_string()),
            ],
            100,
            true,
        );

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].source, "x = 1");
        assert_eq!(entries[0].session, 13);
        assert_eq!(entries[0].recency_rank, 0);
        assert_eq!(entries[1].source, "print(x)");
        assert_eq!(entries[1].session, 12);
        assert_eq!(entries[1].line, 9);
        assert_eq!(entries[1].recency_rank, 1);
    }

    #[test]
    fn preserves_duplicates_when_requested() {
        let entries = normalize_history_entries(
            vec![
                raw_history_entry(1, 1, "x = 1".to_string()),
                raw_history_entry(1, 2, "x = 1".to_string()),
            ],
            100,
            false,
        );

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].line, 2);
        assert_eq!(entries[1].line, 1);
    }

    #[test]
    fn ranks_current_session_first_and_applies_limit() {
        let entries = normalize_history_entries(
            vec![
                raw_history_entry(999, 1, "persisted".to_string()),
                raw_history_entry(0, 2, "current".to_string()),
            ],
            1,
            true,
        );

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].source, "current");
        assert_eq!(entries[0].recency_rank, 0);
    }

    #[test]
    fn canonicalizes_source_keys_and_drops_empty_sources() {
        let entries = normalize_history_entries(
            vec![
                raw_history_entry(1, 1, "print('hi')\r\n".to_string()),
                raw_history_entry(1, 2, "print('hi')".to_string()),
                raw_history_entry(1, 3, "   ".to_string()),
            ],
            100,
            true,
        );

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].source_key, "print('hi')");
        assert_eq!(entries[0].line, 2);
    }

    #[test]
    fn overfetches_bounded_raw_history_for_deduped_results() {
        assert_eq!(provider_history_limit(100, true), 300);
        assert_eq!(provider_history_limit(100, false), 100);
        assert_eq!(provider_history_limit(500, true), 1_000);
        assert_eq!(provider_history_limit(0, true), 0);
    }
}
