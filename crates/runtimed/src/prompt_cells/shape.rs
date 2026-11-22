//! Splitting a model reply into answer cells.
//!
//! Prose becomes markdown cells. Only fences marked with the MyST cell
//! directive (```` ```{code-cell} python ````, or a bare ```` ```{code-cell} ````
//! for the notebook language) become code cells; every other fence stays in
//! the markdown. The system prompt (`context::EXPLORE_SYSTEM_PROMPT`) teaches
//! the marker.

/// One cell of a shaped answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AnswerPart {
    /// `"markdown"` or `"code"`.
    pub cell_type: &'static str,
    pub source: String,
}

/// An opening or closing fence line: `(fence char, run length, rest of line)`.
fn parse_fence(line: &str) -> Option<(char, usize, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let trimmed = &line[indent..];
    let fence_char = trimmed.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let run = trimmed.chars().take_while(|c| *c == fence_char).count();
    if run < 3 {
        return None;
    }
    let rest = &trimmed[run..];
    // A backtick fence's info string may not contain backticks (inline code).
    if fence_char == '`' && rest.contains('`') {
        return None;
    }
    Some((fence_char, run, rest))
}

fn is_runtime_language(runtime: Option<&str>, language: &str) -> bool {
    let language = language.to_ascii_lowercase();
    let accepted: &[&str] = match runtime.map(str::to_ascii_lowercase).as_deref() {
        None | Some("python") | Some("python3") => {
            &["py", "python", "python3", "ipython", "ipython3"]
        }
        Some("deno") | Some("typescript") | Some("javascript") => {
            &["ts", "typescript", "js", "javascript", "tsx"]
        }
        Some(_) => &[],
    };
    accepted.contains(&language.as_str())
}

/// True for a `{code-cell}` fence (any case) whose language, if given, is the
/// notebook's. Without a language the cell is in the notebook language.
fn is_cell_fence(runtime: Option<&str>, info: &str) -> bool {
    let mut words = info.split_whitespace();
    if !words
        .next()
        .is_some_and(|word| word.eq_ignore_ascii_case("{code-cell}"))
    {
        return false;
    }
    words
        .next()
        .is_none_or(|language| is_runtime_language(runtime, language))
}

fn push_markdown(parts: &mut Vec<AnswerPart>, prose: &mut Vec<&str>) {
    let text = prose.join("\n");
    prose.clear();
    let text = text.trim();
    if !text.is_empty() {
        parts.push(AnswerPart {
            cell_type: "markdown",
            source: text.to_string(),
        });
    }
}

/// Split a model reply into notebook cells. Prose becomes markdown parts
/// (trimmed, empty ones dropped). Only a `{code-cell}` fence in the notebook
/// language becomes a code part. Every other fence (examples, other
/// languages, unclosed fences) stays inside the markdown, so a forgotten
/// marker never turns an example into a cell. `runtime` is `"python"` (also
/// the default for `None`) or `"deno"`; an unknown runtime only accepts a
/// bare `{code-cell}`.
pub(crate) fn shape_answer(text: &str, runtime: Option<&str>) -> Vec<AnswerPart> {
    let mut parts = Vec::new();
    let mut prose: Vec<&str> = Vec::new();
    let lines: Vec<&str> = text.lines().collect();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let Some((fence_char, run, info)) = parse_fence(line) else {
            prose.push(line);
            index += 1;
            continue;
        };
        let close = (index + 1..lines.len()).find(|&end| {
            parse_fence(lines[end])
                .is_some_and(|(c, n, rest)| c == fence_char && n >= run && rest.trim().is_empty())
        });
        let Some(close) = close else {
            // Unterminated fence: keep the rest as prose.
            prose.extend(&lines[index..]);
            break;
        };
        if is_cell_fence(runtime, info) {
            let code = lines[index + 1..close].join("\n");
            if !code.trim().is_empty() {
                push_markdown(&mut parts, &mut prose);
                parts.push(AnswerPart {
                    cell_type: "code",
                    source: code,
                });
            }
        } else {
            prose.extend(&lines[index..=close]);
        }
        index = close + 1;
    }
    push_markdown(&mut parts, &mut prose);
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shaped(text: &str, runtime: Option<&str>) -> Vec<(&'static str, String)> {
        shape_answer(text, runtime)
            .into_iter()
            .map(|part| (part.cell_type, part.source))
            .collect()
    }

    fn md(source: &str) -> (&'static str, String) {
        ("markdown", source.to_string())
    }

    fn code(source: &str) -> (&'static str, String) {
        ("code", source.to_string())
    }

    #[test]
    fn empty_and_whitespace_text_yield_nothing() {
        assert!(shape_answer("", Some("python")).is_empty());
        assert!(shape_answer("  \n\n ", None).is_empty());
    }

    #[test]
    fn prose_only_is_one_trimmed_markdown_part() {
        assert_eq!(
            shaped("\n  Hello **world**.\n\nSecond paragraph.\n\n", None),
            vec![md("Hello **world**.\n\nSecond paragraph.")]
        );
    }

    #[test]
    fn a_marked_block_is_one_code_part() {
        assert_eq!(
            shaped(
                "```{code-cell} python\nprint(1)\nprint(2)\n```",
                Some("python")
            ),
            vec![code("print(1)\nprint(2)")]
        );
        assert_eq!(
            shaped("```{code-cell} python\nprint(1)\n```\n", Some("python")),
            vec![code("print(1)")]
        );
    }

    #[test]
    fn runnable_code_becomes_a_cell_and_examples_stay_in_the_text() {
        let text =
            "Here's how to load it:\n\n```{code-cell} python\ndf = pd.read_csv(\"data.csv\")\n```\n\n\
            `head` returns the first rows, for example:\n\n```python\ndf.head(3)\n```\n\n\
            Install pandas first:\n\n```bash\npip install pandas\n```";
        assert_eq!(
            shaped(text, Some("python")),
            vec![
                md("Here's how to load it:"),
                code("df = pd.read_csv(\"data.csv\")"),
                md(
                    "`head` returns the first rows, for example:\n\n```python\ndf.head(3)\n```\n\n\
                    Install pandas first:\n\n```bash\npip install pandas\n```"
                ),
            ]
        );
    }

    #[test]
    fn mixed_prose_and_marked_code_alternate() {
        let text = "Here is the plan.\n\n```{code-cell} py\nx = 1\n```\n\nThen print it:\n\n```{code-cell} python3\nprint(x)\n```\nDone.";
        assert_eq!(
            shaped(text, Some("python")),
            vec![
                md("Here is the plan."),
                code("x = 1"),
                md("Then print it:"),
                code("print(x)"),
                md("Done."),
            ]
        );
    }

    #[test]
    fn plain_and_foreign_fences_stay_in_markdown() {
        for fence in [
            "```python\nx = 1\n```",
            "```\nx = 1\n```",
            "```json\n{}\n```",
            // The old `python cell` marker is not a cell any more.
            "```python cell\nx = 1\n```",
            "```cell\nx = 1\n```",
            // Other MyST directives are not cells.
            "```{code} python\nx = 1\n```",
            "```{note}\nx = 1\n```",
        ] {
            assert_eq!(shaped(fence, Some("python")), vec![md(fence)], "{fence:?}");
        }
        // The marker does not make another language runnable.
        assert_eq!(
            shaped("```{code-cell} bash\nls\n```", Some("python")),
            vec![md("```{code-cell} bash\nls\n```")]
        );
    }

    #[test]
    fn the_marker_is_case_insensitive() {
        for fence in [
            "```{CODE-CELL} Python\nx\n```",
            "```{Code-Cell} PYTHON\nx\n```",
            "```{code-cell} ipython3\nx\n```",
        ] {
            assert_eq!(shaped(fence, Some("python")), vec![code("x")], "{fence:?}");
        }
    }

    #[test]
    fn a_bare_marker_means_the_notebook_language() {
        for runtime in [Some("python"), Some("deno"), Some("other"), None] {
            assert_eq!(
                shaped("```{code-cell}\nx = 1\n```", runtime),
                vec![code("x = 1")],
                "{runtime:?}"
            );
        }
    }

    #[test]
    fn python_and_deno_runtimes_accept_their_own_languages() {
        for language in ["py", "python", "python3", "PYTHON"] {
            assert_eq!(
                shaped(
                    &format!("```{{code-cell}} {language}\nx\n```"),
                    Some("python")
                ),
                vec![code("x")],
                "python accepts {language:?}"
            );
        }
        for language in ["ts", "typescript", "js", "javascript", "tsx"] {
            let fence = format!("```{{code-cell}} {language}\nx\n```");
            assert_eq!(
                shaped(&fence, Some("deno")),
                vec![code("x")],
                "deno accepts {language:?}"
            );
            assert_eq!(
                shaped(&fence, Some("python")),
                vec![md(&fence)],
                "python rejects {language:?}"
            );
        }
        assert_eq!(
            shaped("```{code-cell} typescript\nx\n```", Some("typescript")),
            vec![code("x")]
        );
        assert_eq!(
            shaped("```{code-cell} python\nx\n```", Some("julia")),
            vec![md("```{code-cell} python\nx\n```")]
        );
    }

    #[test]
    fn info_string_extras_and_tilde_fences() {
        assert_eq!(
            shaped(
                "```{code-cell} python title=\"a.py\"\nx\n```",
                Some("python")
            ),
            vec![code("x")]
        );
        assert_eq!(
            shaped("~~~{code-cell} python\nx\n~~~", Some("python")),
            vec![code("x")]
        );
    }

    #[test]
    fn longer_outer_fence_can_contain_a_shorter_fence() {
        let text = "````{code-cell} python\nprint(\"```\")\n````";
        assert_eq!(shaped(text, Some("python")), vec![code("print(\"```\")")]);
        // A different fence char does not close the block.
        let text = "```{code-cell} python\nx\n~~~\n```";
        assert_eq!(shaped(text, Some("python")), vec![code("x\n~~~")]);
    }

    #[test]
    fn unterminated_fence_stays_in_markdown() {
        assert_eq!(
            shaped("Before\n\n```{code-cell} python\nx = 1", Some("python")),
            vec![md("Before\n\n```{code-cell} python\nx = 1")]
        );
    }

    #[test]
    fn empty_code_block_is_dropped() {
        assert_eq!(
            shaped("A\n\n```{code-cell} python\n```\n\nB", Some("python")),
            vec![md("A\n\n\nB")]
        );
    }

    #[test]
    fn code_keeps_internal_indentation_and_blank_lines() {
        assert_eq!(
            shaped(
                "```{code-cell} python\ndef f():\n\n    return 1\n```",
                Some("python")
            ),
            vec![code("def f():\n\n    return 1")]
        );
    }

    #[test]
    fn inline_triple_backticks_are_not_a_fence() {
        assert_eq!(
            shaped("Use ```x``` inline.", Some("python")),
            vec![md("Use ```x``` inline.")]
        );
    }
}
