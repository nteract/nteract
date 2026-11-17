# Non-publishing macOS ARM64 preview candidates

`Preview artifact candidates` collects same-source daemon, notebook UI and Node
binding outputs for independent validation before a disposable embedding build.
It does not publish a release/npm package, deploy, sign/notarize, change source
versions, or alter a consumer's authentication policy. The existing consumer
verifier must remain unchanged. A generated hash is not an authorization grant.

## Produce a candidate

The workflow must first be reviewed and available on the default branch for
GitHub's manual-dispatch UI/API. Opening this draft does not make it callable.
Do not merge, publish or change main merely to make it callable.

Once available and authorized, run `.github/workflows/preview-artifact-candidates.yml`
with the open same-repository PR number and its independently reviewed full
`expected_sha`. The resolver fails if the PR head moved. It checks out that SHA,
not the moving branch or a synthetic merge ref. The packaging tools come from
the selected workflow revision; record both revisions when reviewing the run.
Only the lightweight packager tests run on a PR; macOS builds require dispatch.

The macOS job has read-only repository permissions, no checkout credential
persistence, no signing secrets and no deployment environment. PR code still
executes in its isolated, unprivileged build VM. Do not add elevated permissions,
secrets or a `pull_request_target` trigger to this workflow.

The build uses normal runtime-artifact generation, `pnpm build`, locked Cargo
build, notebook-UI attribution/packaging and Node package build/pack commands.
It executes the daemon's `--version` and loads the exact packed Darwin ARM64
native binding through the packed wrapper. These smoke checks do not establish
Conda workflow or host application behavior.

## Evidence and independent admission

Download the `preview-candidate-<build ID>` artifact through authenticated GitHub
access. Record repository, workflow revision, resolved source SHA, run ID and
attempt, artifact ID and GitHub artifact ZIP digest. The ZIP digest is not the
inner daemon/UI digest. Retention is 14 days.

`candidate.json` records the full source commit, target, run URL and unique build
ID, plus byte sizes/SHA-256 for:

- `runtimed`: runnable ARM64 daemon, no signature assurance claimed;
- `notebook-ui.tar.gz`: normal UI archive with embedded commit/version and
  license/notices/SBOM; its version equals the candidate build ID;
- `runtimed-node-wrapper.tgz` and `runtimed-node-darwin-arm64.tgz`: same-version
  wrapper/native packages; the inner `.node` file is also hashed separately.

The preview build ID binds the PR, full SHA, run and attempt. It is a bundle
identity, not a new compiled daemon/package version. No version files are
rewritten. The full source is recorded by the producer; the daemon's existing
short Git build hash alone cannot prove full source identity.

Independently verify the GitHub run/checkout, artifact digest, `SHA256SUMS`, inner
file hashes, UI manifest and target. Review the source and run before baking the
verified expected hashes into a separate disposable consumer build. Do not let
runtime input select an arbitrary manifest/path, dynamically authorize hashes,
reuse a different source's signature, or disable authentication. If the consumer
requires signing/provenance not provided by this route, stop for its established
approval/signing process. This candidate workflow does not satisfy that policy
by itself.

The packager can also be checked offline with existing outputs using
`python3 scripts/ci/package-preview-candidate.py --help`. It never downloads or
executes input artifacts, rejects mismatched UI/Node identities and architectures,
and refuses to overwrite an existing output directory. Its manifest is producer
evidence, not independent proof that an arbitrary supplied binary came from Git.

## Checks

```sh
python3 -m unittest scripts/tests/test_preview_candidate.py scripts/tests/test_package_notebook_ui.py -v
```

Tests use synthetic Mach-O/Node fixtures and the real notebook-UI packager. A green
unit suite is not evidence that a macOS candidate was built or admitted by a host.
