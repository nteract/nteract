const check=(condition,message)=>{if(!condition) throw new Error(message);};
const sourceSha=value=>{check(typeof value==='string' && /^[a-f0-9]{40}$/.test(value),'full source SHA required');return value;};
export const PAGES_CONTROLLER='https://deploy.runtimed.run';
export async function sendPagesDeployment(env,event,{fetchImpl,clock}) {
  check(env.PAGES_PAGE10_ENABLED==='true','Pages caller is disabled');
  check(env.GITHUB_REPOSITORY==='nteract/nteract' && ['workflow_run','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME),'invalid Pages caller context');
  const automatic=env.GITHUB_EVENT_NAME==='workflow_run',run=event.workflow_run;
  if(automatic) check(run?.event==='push' && run.head_branch==='main' && run.conclusion==='success' && run.status==='completed',
    'Pages event is not a green main push');
  const sha=sourceSha(automatic?run.head_sha:env.INPUT_SHA);
  const body={action:'pages',target:'page10',sha,runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT,
    buildRunId:automatic?run.id:env.INPUT_BUILD_RUN_ID,buildRunAttempt:automatic?run.run_attempt:env.INPUT_BUILD_RUN_ATTEMPT,githubToken:env.GITHUB_TOKEN};
  for(const key of ['runId','runAttempt','buildRunId','buildRunAttempt']) check(/^[1-9][0-9]{0,19}$/.test(String(body[key])),'invalid Pages run identity');
  const oidc=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  check(oidc.protocol==='https:' && !oidc.username && !oidc.password && !oidc.port &&
    (oidc.hostname==='actions.githubusercontent.com'||oidc.hostname.endsWith('.actions.githubusercontent.com')),'invalid OIDC endpoint');
  oidc.searchParams.set('audience',PAGES_CONTROLLER);
  const deadline=clock.now()+48*60*1000;
  const request=async(path,data)=>{
    check(clock.now()<deadline,'Pages polling deadline exceeded; inspect operation, never repost');
    const response=await fetchImpl(oidc,{headers:{Authorization:`Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(20000)});
    check(response.ok,'OIDC request failed');const {value}=await response.json();check(typeof value==='string' && value.split('.').length===3,'invalid OIDC token');
    return fetchImpl(`${PAGES_CONTROLLER}${path}`,{method:data?'POST':'GET',headers:{Authorization:`Bearer ${value}`,'Content-Type':'application/json'},
      ...(data?{body:JSON.stringify(data)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});
  };
  const accepted=await request('/deploy',body);check(accepted.status===202,'Pages request not accepted');
  const {operationId}=await accepted.json();check(/^[a-f0-9-]{36}$/.test(operationId),'invalid Pages operation id');
  while(true) {
    await clock.sleep(5000);
    const response=await request(`/pages-deployments/${operationId}`);check(response.ok,'Pages poll failed');
    const result=await response.json();
    check(result.operationId===operationId && result.target==='page10' && result.requestedSha===sha,'Pages result identity mismatch');
    check(['running','failed','succeeded'].includes(result.status),'invalid Pages operation status');
    check(result.status!=='failed','Pages operation failed; inspect operation, never replay');
    if(result.status==='succeeded') {
      check(result.sha===sha && /^[a-f0-9]{12}$/.test(result.build) && typeof result.restorePointKey==='string' &&
        Number.isSafeInteger(result.counts?.total),'Pages result missing verified release evidence');return result;
    }
  }
}
export function pagesStepSummary(result) {
  sourceSha(result.sha);
  check(/^[a-f0-9]{12}$/.test(result.build) && /^standalone\/page10-snapshots\/[a-z0-9-]+\/versions.json$/.test(result.restorePointKey) &&
    Number.isSafeInteger(result.counts?.total) && result.counts.total>=0,'invalid Pages summary evidence');
  return `Page10 deployed at \`${result.sha}\`.\n\n| Build | Restore point | Post-deploy 5xx (lab1, 60s) |\n| --- | --- | --- |\n| ${result.build} | ${result.restorePointKey} | ${result.counts.total} |\n`;
}
