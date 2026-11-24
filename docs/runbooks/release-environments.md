# Release environments and repository settings

Release signing keys and publishing tokens for nteract/nteract live in GitHub
environments, not at repository level. A job can read an environment's secrets
only when it declares that environment, and GitHub admits the job only when
the run's ref matches the environment's deployment policy and its required
reviewers approve.

The workflow `if:` guards on the release callers and publishers stop mistakes.
They do not stop someone with push access: `workflow_dispatch` runs the
workflow file from the dispatched ref, so a branch can delete its own guards.
The environment settings below are the gate. Workflows that start from
`workflow_run` always run the default branch's file, so their guards on the
upstream run's branch do hold.

## Environments

Signing builds and publishing jobs run in separate environments. The build jobs
run a large third-party dependency tree, so they never see the publishing
tokens, and the publishing jobs never see the signing keys.

| Environment | Deployment refs | Required reviewers | Used by |
|---|---|---|---|
| `release-signing` | branch `main` | none, so the 09:00 UTC schedule runs unattended | `build-notebook-*` jobs in `release-common.yml` when called from `release-nightly.yml` |
| `release-signing-stable` | branch `main`, tag `v*` | `rgbkrk`, `intentionally-left-nil`; prevent self-review | the same jobs when called from `release-stable.yml` |
| `release-nightly` | branch `main` | none | `prerelease`, `publish-plugin`, `recover-nightly-wheel` for nightly |
| `release-stable` | branch `main`, tag `v*` | `rgbkrk`, `intentionally-left-nil`; prevent self-review | `prerelease`, `publish-plugin` for stable |
| `npm-publish` | branch `main` | none | the `publish-*` jobs in `publish-npm.yml` (npm OIDC only, no secrets) |

The stable environments admit `v*` tags because a stable release promotes a
nightly tag such as `v2.10.1-nightly.202611161728`. Anyone with push access can
create a `v*` tag, so these environments need reviewers. Prevent self-review
means a stolen token of the person who dispatched the run cannot approve it; the
other reviewer must. Turn it off only if a second reviewer is not available. A
stable run asks twice: once when the signing builds start
(`release-signing-stable`), and again when `prerelease` and `publish-plugin`
start (`release-stable`).

## Windows signing by OIDC

Windows builds sign through Azure Artifact Signing with no client secret. The
Entra app `nteract_signing` (owned by NumFOCUS) holds one federated credential
per signing environment:

| Issuer | Subject |
|---|---|
| `https://token.actions.githubusercontent.com` | `repo:nteract/nteract:environment:release-signing` |
| `https://token.actions.githubusercontent.com` | `repo:nteract/nteract:environment:release-signing-stable` |

Audience `api://AzureADTokenExchange`, entity type Environment, org `nteract`,
repo `nteract`, for both. Both are required: nightly Windows signing uses the
first and stable uses the second. A missing credential fails that channel's
Windows jobs at token exchange. Confirm both exist before merging the change
that switches signing to OIDC.

`.github/actions/prepare-artifact-signing` downloads the pinned
`Microsoft.ArtifactSigning.Client` package, checks NuGet's SHA-512, and writes a
Tauri config whose `signCommand` runs `scripts/ci/windows-sign.ps1`. That
script requests a fresh GitHub OIDC token for each file and hands it to the
signing dlib through `WorkloadIdentityCredential`.

## Create the environments

Run these from any checkout with `gh` authenticated as a repository admin.
Nightly environments allow `main` only:

```bash
for env in release-signing release-nightly npm-publish; do gh api -X PUT "repos/nteract/nteract/environments/$env" -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true' && gh api -X POST "repos/nteract/nteract/environments/$env/deployment-branch-policies" -f name=main -f type=branch; done
```

Stable environments allow `main` and `v*` tags, with reviewers:

```bash
for env in release-signing-stable release-stable; do
  gh api -X PUT "repos/nteract/nteract/environments/$env" --input - <<'JSON'
{
  "prevent_self_review": true,
  "reviewers": [{"type": "User", "id": 836375}, {"type": "User", "id": 6687139}],
  "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}
}
JSON
  gh api -X POST "repos/nteract/nteract/environments/$env/deployment-branch-policies" -f name=main -f type=branch
  gh api -X POST "repos/nteract/nteract/environments/$env/deployment-branch-policies" -f name='v*' -f type=tag
done
```

User ids: 836375 is `rgbkrk`, 6687139 is `intentionally-left-nil`.

Check each one in Settings → Environments. In each environment, leave
"Allow administrators to bypass configured protection rules" off.

## Put each secret in its environment

GitHub cannot read a secret back, so a secret is never moved: it is set again in
the environment and then deleted at repository level. Use the rotated values.

| Secret | Environments | Read by |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `release-signing`, `release-signing-stable` | every `build-notebook-*` job |
| `NUMFOCUS_APPLE_CERTIFICATE`, `NUMFOCUS_APPLE_CERTIFICATE_PASSWORD`, `NUMFOCUS_APPLE_SIGNING_IDENTITY`, `NUMFOCUS_APPLE_API_ISSUER`, `NUMFOCUS_APPLE_API_KEY`, `NUMFOCUS_APPLE_API_PRIVATE_KEY` | `release-signing`, `release-signing-stable` | `build-notebook-macos-arm64`, `build-notebook-macos-x64` |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` | `release-signing`, `release-signing-stable` | `build-notebook-windows-x64`, `build-notebook-windows-arm64`. Identifiers, not credentials. |
| `CLAUDE_PLUGIN_DEPLOY_TOKEN` | `release-nightly`, `release-stable` | `publish-plugin` |
| `DISCORD_WEBHOOK` | `release-nightly`, `release-stable` | `prerelease` |

`AZURE_CLIENT_SECRET` is not set anywhere. NumFOCUS deleted the client secret,
and Windows signing uses the federated credential instead.

`npm-publish` holds no secrets.

For each name, once per environment it belongs in:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY --env release-signing -R nteract/nteract
```

`gh secret set` reads the value from stdin; pipe it from 1Password with
`op read` to keep it out of shell history. For multi-line values, such as the
Tauri key or a base64 certificate, use `< file`.

Then delete the repository copies:

```bash
for name in TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD NUMFOCUS_APPLE_CERTIFICATE NUMFOCUS_APPLE_CERTIFICATE_PASSWORD NUMFOCUS_APPLE_SIGNING_IDENTITY NUMFOCUS_APPLE_API_ISSUER NUMFOCUS_APPLE_API_KEY NUMFOCUS_APPLE_API_PRIVATE_KEY AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET CLAUDE_PLUGIN_DEPLOY_TOKEN DISCORD_WEBHOOK; do gh secret delete "$name" -R nteract/nteract; done
```

No workflow reads these repository secrets. Delete them, and revoke the
credentials behind them, since they were in the same dump:

```bash
for name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_TEAM_ID APT_GPG_KEY_ID APT_GPG_PRIVATE_KEY AZURE_CERT_PROFILE_NAME AZURE_CODE_SIGNING_NAME AZURE_ENDPOINT CF_ACCOUNT_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID R2_AWS_ACCESS_KEY_ID R2_AWS_SECRET_ACCESS_KEY R2_BUCKET_NAME; do gh secret delete "$name" -R nteract/nteract; done
```

`DISCORD_WEBHOOK_WINDOWS` stays at repository level for `smoke.yml`. It is a
low-value webhook, but it was exposed too, so rotate it.

An organization secret named `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is visible to
this repository. Every workflow can read organization secrets, so delete it or
remove nteract/nteract from its repository list. Keep signing material out of
organization secrets.

`CLAUDE_PLUGIN_DEPLOY_TOKEN` acts as `rgbkrk`. Replace it with a fine-grained
token, or a deploy key, limited to `contents: write` on nteract/agent-plugins.

The release workflows keep `secrets: inherit`. Once the repository copies are
gone it passes nothing that matters, and environment secrets reach the called
jobs without it.

## Pin trusted publishers to the environments

A trusted publisher with no environment accepts a token from the named
workflow file on any ref, which is how a branch copy of a workflow publishes.

- npm, each package published by `publish-npm.yml`: `@runtimed/node`, the five
  `@runtimed/node-<target>` packages, `@nteract/pi`, `@runtimed/wasm`,
  `@nteract/sift` and `@nteract/sift-csv`. Package Settings → Trusted
  Publisher → Environment `npm-publish`.
- PyPI, project `runtimed`: the publisher for `release-nightly.yml` gets
  environment `release-nightly`; the one for `release-stable.yml` gets
  `release-stable`.

Set these after the pull request that adds the `environment:` lines is on
`main`, or the next release fails at the publish step.

## Rulesets

Neither ruleset is applied yet. Apply them after the environments are working.

Code owner review on `main`. `.github/CODEOWNERS` owns `.github/` and
`scripts/ci/`. A zero approval count with code owner review required means
only pull requests that touch owned paths wait for an owner. There are no
bypass actors, which removes the admin exception for these paths.

```bash
gh api -X POST repos/nteract/nteract/rulesets --input - <<'JSON'
{
  "name": "main: code owner review",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
  "bypass_actors": [],
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "require_code_owner_review": true,
        "dismiss_stale_reviews_on_push": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["squash"]
      }
    }
  ]
}
JSON
```

After applying it, open a throwaway pull request that edits a comment under
`.github/` and confirm the merge box asks for a code owner review.

The classic branch protection on `main` still requires 0 approvals, does not
apply to admins, and lets `rgbkrk` bypass pull requests. Anyone with maintain
can still merge a change outside these paths, and the next nightly builds it
with signing keys. A required review on every pull request closes that; it is
a team call, not part of this change.

Release tags: only repository admins and GitHub Actions create, move or delete
`v*` tags. `compute-version` reserves each release tag with `GITHUB_TOKEN`, so
GitHub Actions must stay on the bypass list (actor 15368 is the GitHub Actions
app; role 5 is the repository admin role):

```bash
gh api -X POST repos/nteract/nteract/rulesets --input - <<'JSON'
{
  "name": "release tags: admins and Actions only",
  "target": "tag",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
  "bypass_actors": [
    {"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"},
    {"actor_id": 15368, "actor_type": "Integration", "bypass_mode": "always"}
  ],
  "rules": [{"type": "creation"}, {"type": "update"}, {"type": "deletion"}]
}
JSON
```

After applying it, confirm the next nightly's "Reserve release tag" step still
pushes its tag. A maintain token can no longer push a `v*` tag directly.

The Actions bypass applies to any workflow run, including one dispatched on a
branch, so a pusher can still get a `v*` tag created on an unreviewed commit.
Two checks cover that: `release-signing-stable` and `release-stable` require a
reviewer, and the npm, WASM and editor-asset publishers accept a tag-started
stable release only when `main` contains its commit
(`releaseTagEvidence` in `scripts/ci/npm-release.mjs`).

## Settings checklist

The environment rules are the only gate on a dispatched run, because a branch
controls its own workflow file. None of the workflow changes protect anything
until these settings exist.

- [ ] `release-signing`, `release-nightly`, `npm-publish`: deployment branch
  `main` only, no tags, no reviewers.
- [ ] `release-signing-stable`, `release-stable`: deployment branch `main` and
  tag `v*`, required reviewers `rgbkrk` and `intentionally-left-nil`, prevent
  self-review on.
- [ ] Admin bypass off in every one of those environments.
- [ ] Both federated credentials exist on `nteract_signing`:
  `release-signing` and `release-signing-stable`.
- [ ] Every moved secret is set in its environments and deleted at repository
  level, `AZURE_CLIENT_SECRET` included. The 17 unused repository secrets are
  deleted.
- [ ] The organization secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is deleted.
  `secrets: inherit` passes organization secrets to every release job, and any
  workflow can read them directly.
- [ ] npm trusted publishers for all ten packages name environment
  `npm-publish`. PyPI `runtimed` publishers name `release-nightly`
  (`release-nightly.yml`) and `release-stable` (`release-stable.yml`).
- [ ] Code owner review ruleset and release tag ruleset applied.
- [ ] Actions settings below.

## Actions settings

Settings → Actions → General:

- Workflow permissions: set the default to read. It is write today, so a job
  without a `permissions:` block gets a write token. Every job that writes
  declares its own block, so the switch changes nothing for them.
- Turn off "Allow GitHub Actions to create and approve pull requests".
