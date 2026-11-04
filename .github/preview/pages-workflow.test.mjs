import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";

test("page10 caller is disabled unless its separate manual or automatic variable is enabled", async () => {
  const workflow = await readFile(new URL("../workflows/pages-page10.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflows: \[Pages experiment\]/);
  assert.match(workflow, /types: \[completed\]/);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /vars.PAGES_PAGE10_AUTODEPLOY == 'true'/);
  assert.match(workflow, /vars.PAGES_PAGE10_MANUAL == 'true'/);
  assert.match(workflow, /github.event.workflow_run.event == 'push'/);
  assert.match(workflow, /github.event.workflow_run.conclusion == 'success'/);
  assert.doesNotMatch(workflow, /secrets: inherit|pull_request_target:|^\s*(?:run|runs-on):/m);
  const refs = [...workflow.matchAll(/uses: nteract\/preview-infra\/\.github\/workflows\/pages-page10-reusable.yml@([^\s]+)/g)];
  assert.equal(refs.length, 2);
  assert.equal(refs[0][1], refs[1][1]);
  assert.match(refs[0][1], /^[a-f0-9]{40}$/);
});
