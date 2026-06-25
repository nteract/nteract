# Curated GitHub Release Highlights

The release workflow always publishes install instructions first and keeps the
raw `git-cliff` changelog in a collapsed details block.

To add human-curated release highlights, create one of these Markdown files:

- `.github/release-notes/<base-version>.md` for an exact release, such as
  `2.6.0.md`
- `.github/release-notes/<major>.<minor>.md` for a release series, such as
  `2.6.md`
- `.github/release-notes/stable.md` or `.github/release-notes/nightly.md` for a
  channel fallback

The workflow uses the first file it finds in that order. Keep the file body to
the highlights only; the workflow supplies the surrounding release structure.
