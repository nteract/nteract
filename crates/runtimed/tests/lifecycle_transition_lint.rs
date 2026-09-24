#![allow(clippy::unwrap_used, clippy::expect_used)]

//! CI lint: freeze the `RoomLifecycle` transition-lock discipline.
//!
//! Every dual-axis lifecycle mutation (source state, availability,
//! task claim, staged artifact, prepared projection) must happen under
//! `lock_transition`, or a torn update can publish one axis without the
//! other and mint duplicate generation leases. The generation-bump bug
//! family starts exactly there. This textual lint checks for missing
//! or late `lock_transition` calls; it does not prove lexical guard
//! lifetime or that every control-flow path holds the lock.
//!
//! Two rules over `notebook_sync_server/lifecycle.rs`:
//!
//! 1. Any function body that mutates lifecycle state (`source_tx.send*`,
//!    `availability_tx.send*`, `task_claimed.store`, writes to `staged`
//!    or `prepared_projection`) must call `lock_transition` before its
//!    first mutation. Guard clauses before the lock are fine; mutating
//!    before locking is not.
//! 2. The file must never acquire the notebook document lock. Lock
//!    order is document-before-transition everywhere else, so a doc
//!    acquisition inside lifecycle inverts the order and can deadlock.

use std::path::PathBuf;

const MUTATION_TOKENS: &[&str] = &[
    "source_tx.send",
    "availability_tx.send",
    "task_claimed.store",
    "self.staged.write",
    "self.prepared_projection.write",
];

const DOC_LOCK_TOKENS: &[&str] = &["doc.write(", "doc.read(", "with_doc(", "NotebookDoc"];

const LOCK_CALL: &str = "lock_transition(";

/// Functions allowed to mutate without the transition lock:
/// constructors build state that nothing else can observe yet, and the
/// lock implementation itself cannot take the lock.
const ALLOWLIST: &[&str] = &["new", "lock_transition"];

fn lifecycle_source() -> String {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/notebook_sync_server/lifecycle.rs");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()))
}

/// Strip line comments and the trailing `mod tests` block so tokens in
/// prose or test helpers don't count.
fn production_text(source: &str) -> String {
    let without_tests = match source.find("#[cfg(test)]\nmod tests") {
        Some(i) => &source[..i],
        None => source,
    };
    without_tests
        .lines()
        .map(|line| match line.find("//") {
            Some(i) => &line[..i],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

struct FnBody {
    name: String,
    // Whitespace-free so access chains match even when rustfmt splits them.
    body: String,
}

fn without_whitespace(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Split source into function bodies via brace matching. Names are the
/// identifier between `fn ` and `(`. Nested functions attribute their
/// text to the outermost function, which is what the lock rule wants:
/// a closure mutating state inside a method is that method's mutation.
fn function_bodies(text: &str) -> Vec<FnBody> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(rel) = text[i..].find("fn ") {
        let at = i + rel;
        // Require a boundary before `fn` so `often ` and idents don't match.
        if at > 0 && !matches!(bytes[at - 1], b' ' | b'\n' | b'\t' | b'(') {
            i = at + 3;
            continue;
        }
        let after = &text[at + 3..];
        let name: String = after
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        let Some(open_rel) = after.find('{') else {
            break;
        };
        // Reject trait/extern declarations where `;` ends the item first.
        if let Some(semi_rel) = after.find(';') {
            if semi_rel < open_rel && !after[..semi_rel].contains('{') {
                i = at + 3;
                continue;
            }
        }
        let body_start = at + 3 + open_rel;
        let mut depth = 0usize;
        let mut end = body_start;
        for (j, ch) in text[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = body_start + j;
                        break;
                    }
                }
                _ => {}
            }
        }
        out.push(FnBody {
            name,
            body: without_whitespace(&text[body_start..=end]),
        });
        i = end.max(at + 3);
    }
    out
}

fn transition_lock_violations(text: &str) -> Vec<String> {
    let mut violations = Vec::new();
    for f in function_bodies(text) {
        if ALLOWLIST.contains(&f.name.as_str()) {
            continue;
        }
        let first_mutation = MUTATION_TOKENS.iter().filter_map(|t| f.body.find(t)).min();
        let Some(mutation_at) = first_mutation else {
            continue;
        };
        match f.body.find(LOCK_CALL) {
            Some(lock_at) if lock_at < mutation_at => {}
            Some(_) => violations.push(format!(
                "fn {}: mutates lifecycle state before calling lock_transition",
                f.name
            )),
            None => violations.push(format!(
                "fn {}: mutates lifecycle state without lock_transition",
                f.name
            )),
        }
    }
    violations
}

fn doc_lock_violations(text: &str) -> Vec<String> {
    let text = without_whitespace(text);
    DOC_LOCK_TOKENS
        .iter()
        .filter(|t| text.contains(*t))
        .map(|t| format!("lifecycle.rs references document-lock token `{t}`"))
        .collect()
}

#[test]
fn lifecycle_mutations_hold_the_transition_lock() {
    let text = production_text(&lifecycle_source());

    // Vacuity guard: the rule is meaningless if the scanner stops seeing
    // the mutating transition methods (renamed fields, changed watch
    // types). Keep the floor loose but nonzero.
    let mutating_fns = function_bodies(&text)
        .into_iter()
        .filter(|f| MUTATION_TOKENS.iter().any(|t| f.body.contains(t)))
        .count();
    assert!(
        mutating_fns >= 5,
        "expected at least 5 lifecycle functions to mutate transition state; \
         found {mutating_fns}. If fields were renamed, update MUTATION_TOKENS."
    );

    let violations = transition_lock_violations(&text);
    assert!(
        violations.is_empty(),
        "lifecycle transition-lock violations:\n{}",
        violations.join("\n")
    );
}

#[test]
fn lifecycle_never_touches_the_document_lock() {
    let text = production_text(&lifecycle_source());
    let violations = doc_lock_violations(&text);
    assert!(
        violations.is_empty(),
        "lifecycle.rs must not acquire the document lock (doc-before-transition order):\n{}",
        violations.join("\n")
    );
}

// The lint must be able to fail. Feed it seeded violations so a broken
// scanner (bad brace matching, wrong tokens) fails here instead of
// silently passing everything.
#[test]
fn lint_catches_seeded_violations() {
    let unlocked = r#"
        fn bad_transition(&self) {
            self.source_tx.send_replace(RoomSourceState::Ready(status));
        }
    "#;
    assert_eq!(transition_lock_violations(unlocked).len(), 1);

    let locked_too_late = r#"
        fn late_lock(&self) {
            self.task_claimed.store(true, Ordering::Release);
            let _guard = self.lock_transition();
        }
    "#;
    assert_eq!(transition_lock_violations(locked_too_late).len(), 1);

    let correct = r#"
        fn good_transition(&self) {
            if self.done { return; }
            let _guard = self.lock_transition();
            self.source_tx.send_replace(RoomSourceState::Ready(status));
        }
    "#;
    assert!(transition_lock_violations(correct).is_empty());

    let doc_touch = "fn f(&self) { let doc = room.doc.write().await; }";
    assert_eq!(doc_lock_violations(doc_touch).len(), 1);
}

fn mutation_variants() -> Vec<String> {
    let mutations = [
        "self.source_tx.send_replace(state);",
        "self.availability_tx.send_replace(availability);",
        "self.task_claimed.store(true, Ordering::Release);",
        "*self.staged.write().unwrap() = Some(artifact);",
        "*self.prepared_projection.write().unwrap() = Some(projection);",
    ];
    let mut variants = Vec::new();
    for mutation in mutations {
        for separator in [".", ".\n    ", "\n    .", " \t.\t ", "\r\n    ."] {
            variants.push(mutation.replace('.', separator));
        }
    }
    variants
}

#[test]
fn lint_rejects_unlocked_mutations_across_whitespace() {
    for mutation in mutation_variants() {
        let unlocked = format!("fn transition(&self) {{ {mutation} }}");
        assert_eq!(
            transition_lock_violations(&unlocked),
            ["fn transition: mutates lifecycle state without lock_transition"],
            "missed unlocked mutation: {mutation}"
        );
    }
}

#[test]
fn lint_rejects_late_locks_across_whitespace() {
    for mutation in mutation_variants() {
        // A later, easily recognized mutation must not hide the first one.
        let late = format!(
            "fn transition(&self) {{
                    {mutation}
                    let _guard = self.lock_transition();
                    self.source_tx.send_replace(state);
                }}"
        );
        assert_eq!(
            transition_lock_violations(&late),
            ["fn transition: mutates lifecycle state before calling lock_transition"],
            "missed mutation before lock: {mutation}"
        );
    }
}

#[test]
fn lint_accepts_guarded_mutations_across_whitespace() {
    for mutation in mutation_variants() {
        let guarded = format!(
            "fn transition(&self) {{
                    if self.done {{ return; }}
                    let _guard = self\n .lock_transition \n ();
                    {mutation}
                }}"
        );
        assert!(
            transition_lock_violations(&guarded).is_empty(),
            "rejected guarded mutation: {mutation}"
        );
    }
}

#[test]
fn lint_rejects_document_locks_across_whitespace() {
    for (expression, token) in [
        ("room.doc\n .write \n ().await", "doc.write("),
        ("room\n .doc\t.\tread\t().await", "doc.read("),
        ("with_doc\r\n (f)", "with_doc("),
        ("NotebookDoc::new()", "NotebookDoc"),
    ] {
        let text = format!(
            "fn transition(&self) {{
                let _guard = self.lock_transition();
                let doc = {expression};
            }}"
        );
        assert_eq!(
            doc_lock_violations(&text),
            [format!(
                "lifecycle.rs references document-lock token `{token}`"
            )],
            "missed document lock: {expression}"
        );
    }
}

#[test]
fn lint_preserves_exact_constructor_and_lock_allowlist() {
    for name in ["new", "lock_transition", "renew", "lock_transition_later"] {
        let text = format!("fn {name}(&self) {{ self.source_tx\n .send_replace(state); }}");
        let violations = transition_lock_violations(&text);
        if matches!(name, "new" | "lock_transition") {
            assert!(violations.is_empty(), "rejected allowlisted fn {name}");
        } else {
            assert_eq!(
                violations,
                [format!(
                    "fn {name}: mutates lifecycle state without lock_transition"
                )]
            );
        }
    }
}

#[test]
fn lint_checks_production_but_ignores_line_comments_and_test_module() {
    let text = production_text(
        r#"
        // NotebookDoc and doc.write() in prose are not lock acquisitions.
        fn transition(&self) {
            // lock_transition() in a comment does not protect this mutation.
            self.source_tx // rustfmt may split access chains
                .send_replace(state);
        }
        #[cfg(test)]
mod tests {
            fn helper() {
                self.source_tx.send_replace(state);
                room.doc.write();
            }
        }
        "#,
    );
    assert_eq!(
        transition_lock_violations(&text),
        ["fn transition: mutates lifecycle state without lock_transition"]
    );
    assert!(doc_lock_violations(&text).is_empty());
}
