# PR preview workflow helpers

These dependency-free Node.js helpers support automatic previews on an existing
celld deployment on EC2. They do not activate any GitHub event workflow by
themselves. The private `nteract/preview-infra` controller owns deployment policy,
credentials, domains, OAuth registration, and preview lifecycle.

The publication sequence deliberately separates three reviewed revisions:

1. Merge the helpers and tests (revision A).
2. Publish a reusable workflow whose trusted jobs check out A. Review and merge
   that workflow (revision B).
3. Install B in the controller's reusable-workflow trust policy, then publish a
   thin PR-event caller pinned to B. Never use a caller-supplied helper revision
   or `github.workflow_sha` to choose trusted code: those describe the caller.

The reusable workflow accepts no caller inputs or inherited secrets. It derives
the PR number and action from the original event and checks live GitHub metadata.
Only same-repository PRs targeting `main` from the explicitly configured maintainers are eligible
for deployment: Kyle (`836375`) and Utkarsh (`107147005`). Both the original actor
and rerun initiator must also be eligible. The controller independently enforces
its current policy before a build and again before deployment.

The source revision must equal both the event run's `head_sha` and the current
open PR head. GitHub's `run.pull_requests[].head.sha` can change after a later push,
so it is used only for PR linkage, never historical revision provenance. Closure
cleanup checks the current closed state and leaves deployed-revision lookup to
the controller; it remains available after a final undeployed push or removal of
an author from the approved list.

Closed PRs can disappear from a run's PR-link array. An unmerged closure falls
back to the exact PR ref plus its head SHA. A merged closure requires the `main`
base ref, an exact head or merge commit, and GitHub's commit-to-PR association. These
fallbacks never authorize deployment or another PR's cleanup.

PR code builds on a separate GitHub-hosted runner with only repository read
permissions. It has no OIDC token or infrastructure credentials. Trusted jobs use
GitHub OIDC plus a short-lived `GITHUB_TOKEN` to call `deploy.runtimed.run`; no
GitHub PAT or App private key is needed. The controller never executes scripts
from the uploaded application bundle. Exporter `wrangler.json` files, which can
contain generated session secrets, are excluded from the bundle.

## Dependency caching

The reusable workflow caches pnpm's package store and Cargo's downloaded and
compiled dependencies in preview-specific namespaces. pnpm's key includes the
platform, package-manager version, lockfile, workspace configuration, and npm
configuration. Installation still checks the frozen lockfile and store integrity.
Rust caching keys include the compiler, build environment, dependency manifests,
and the nested source checkout's toolchain and Cargo configuration. Cargo can
reuse unchanged dependencies after a lockfile update; workspace crates and
installed tool binaries are excluded.

Every run still installs dependencies, builds the current authorized source,
exports the application, and uploads a new revision-bound bundle. Generated
WASM packages, frontend bundles, export directories, and deployment configuration
are not cached. Caches are restored only in the unprivileged build job; trusted
authorization, deployment, cleanup, and status jobs never restore them. GitHub
scopes caches written by PR runs to that PR's merge ref, so repeated pushes to
the same PR can benefit without warming other PRs. A cache miss is a normal
cold build.

Changing this reusable workflow does not activate caching by itself. After
review and merge, install the new workflow revision in the controller's trust
policy and update the caller pin using the publication sequence above. Qualify
the rollout with a cold run and a later push to the same PR: confirm cache hits,
the new revision and visible application change, and preserved notebook state.
Also check that a lockfile change installs the new dependencies. Report measured
warm and cold timings separately; cache hits do not establish deployment success.

Run the focused tests with:

```sh
node --test .github/preview/*.test.mjs
```

Tests cover authorization, stale heads, immutable repository identity, closure,
credential destinations, controller polling, and bundle restrictions. Live
acceptance additionally requires opening a real PR, pushing a visible change,
verifying notebook state and preview isolation, then closing the PR and checking
cleanup. Ordinary `pull_request` events can be suppressed by merge conflicts or
GitHub-token-generated activity; retain the operator reconciliation/cleanup path.

Keep per-PR workflow cancellation disabled until controller operations support
explicit cancellation. Once the controller accepts an operation, the sender polls
that operation and never repeats its POST after an uncertain response.
Use **Re-run all jobs** after resolving a failed run so the build and deployment
belong to the same attempt. If capacity is exhausted, close an unused preview PR
or ask an operator to free a slot before rerunning.

## Using a preview

For an eligible PR targeting `main`, opening or reopening the PR starts the
**PR preview** workflow. Its authorization job runs before the application build.
One automatically maintained PR comment links to `https://pr-N.runtimed.run`,
where `N` is the PR number, and shows building, deploying, ready, failed, or closed
status with a workflow link. It distinguishes the requested commit from the
revision currently live, so a failed update does not claim the new code deployed.
The job summary and GitHub deployment environment also link to the preview.
Sign in normally to use it.

Pushing to the same PR updates the existing preview at the same URL. An older
run cannot deploy after its source head becomes stale. Closing or merging the PR
withdraws the preview and its login registration; notebook data is retained for
an operator or a later reopen. Other PR previews remain separate.

If the workflow fails, check the failed job and its summary to distinguish
authorization, build, capacity, and deployment failures. After fixing the cause,
use **Re-run all jobs**. A failed or skipped deployment does not mean the latest
source revision is live, even if the URL still serves an earlier successful build.

## Maintained PR comment

Comment reporting uses the controller's `/status` endpoint. Trusted helpers call
it before authorization, before deployment or cleanup, and after a successful
operation. A separate trusted finalizer runs after failures or skipped jobs so a
failed build can be reflected without giving the application build PR-write
permissions. The controller derives the comment from live GitHub jobs and its
deployment registry; helpers send only run and PR identity, never a requested
status or application logs.

Progress reports are best-effort: a comment failure emits a warning and cannot
block deployment or cleanup, or turn a successful deployment into a failure.
The separate finalizer fails visibly if its comment update fails, so reporting
problems stay visible without changing the deployment result.

The comment distinguishes the requested revision from the confirmed deployed
revision. A failed update can leave an earlier deployment live. Obsolete runs
are ignored so they cannot replace a newer status. The status-only resolver may
report an outdated run for that decision; it must never replace the strict
deployment authorization resolver.

The caller pins the reviewed reusable workflow; `pull-requests: write` is granted
only to its trusted jobs. The application build keeps `contents: read` only.
Future updates follow the same publication sequence: reviewed helpers, reviewed
reusable workflow, controller trust installation, then the caller pin. If the
comment is missing or stale, inspect the **Update preview comment** job; a comment
outage does not change whether the preview deployment itself succeeded.

## Main deployment preparation

The `Build shared UI artifacts` job exports a cloud `preview-bundle` on every
push to `main`, reusing the runtime, sift, and renderer artifacts it already
builds. It does not package this additional bundle for PR, scheduled, or manual
Build runs. The build keeps repository-read permission and has no deployment
identity token or infrastructure credentials. Exported runtime configuration is
excluded by the same bundle format used for PR previews.

The separate `send-main-deployment.mjs` helper is intended for a future pinned
`main-preview-reusable.yml`, called without inputs by `main-preview.yml` on
successful `Build` completion. This patch does not install either workflow or
activate main deployment. Publish them through the same reviewed helper,
reusable workflow, controller trust, and pinned caller sequence described above.

Main authorization is separate from PR authorization. The helper requires a
successful completed push-to-main Build, an active deployment workflow, eligible
original and rerun actors for both runs, immutable repository IDs, the exact
current main revision, and a unique artifact from the successful build job.
The request keeps `buildRunId` and `buildRunAttempt` separate from the active
deployment's `runId` and `runAttempt`; it has the fixed `main` target and no PR
number. The controller independently checks these facts, the artifact archive
digest and bundle manifest, and current main before publication. The helper
never downloads or executes application artifacts. Existing PR previews and
their authorization rules are unchanged.

Main deployment will reuse its own persistent notebook storage and session
secret at `https://main.runtimed.run`; it is not tied to a PR's closure. A failed
or stale Build must leave the current deployment untouched. GitHub's dedicated
deployment environment and the job summary identify the requested revision and
link to the site; PR comment reporting is not used for this target.
