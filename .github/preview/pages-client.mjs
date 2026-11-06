const check=(condition,message)=>{if(!condition) throw new Error(message);};
const sourceSha=value=>{check(typeof value==='string' && /^[a-f0-9]{40}$/.test(value),'full source SHA required');return value;};
export const PAGES_CONTROLLER='https://deploy.runtimed.run';
// Covers GitHub authorization/settling and the controller's admission subprocess.
// The paired preview-infra contract test checks this against the server budgets.
export const PAGES_DEPLOY_TIMEOUT_MS=7*60*1000;
export function pagesJournalSummary(counts) {
  const bounded=value=>Number.isSafeInteger(value)&&value>=0&&value<=100000;
  check(counts&&typeof counts==='object'&&!Array.isArray(counts),'invalid journal evidence');
  if(counts.schema===undefined) {
    check(bounded(counts.total)&&counts.coverage===undefined&&counts.completeness===undefined&&
      (counts.invalidLines===undefined||counts.invalidLines===0),'invalid legacy journal evidence');
    check(counts.total===0,'legacy journal count may contain HTTP 5xx');
    return `Unknown (legacy unverified count: ${counts.total})`;
  }
  check(counts.schema===1&&counts.completeness==='unknown'&&['unknown','observed'].includes(counts.coverage),'invalid journal coverage');
  for(const field of ['invalidLines','envelopes','parseableMessages','textMessages','requestSamples']) check(bounded(counts[field]),'invalid journal aggregate');
  check(counts.invalidLines===0&&counts.requestSamples<=counts.parseableMessages&&counts.textMessages<=counts.envelopes,'invalid journal sample');
  check(counts.byStatus&&typeof counts.byStatus==='object'&&!Array.isArray(counts.byStatus),'invalid journal statuses');
  const statuses=Object.entries(counts.byStatus);check(statuses.length<=100&&statuses.every(([status,count])=>/^5\d\d$/.test(status)&&bounded(count)&&count>0),'invalid journal statuses');
  if(counts.coverage==='unknown') {
    check(counts.requestSamples===0&&counts.total===null&&statuses.length===0,'invalid unknown journal evidence');
    return 'Unknown (no verified HTTP samples)';
  }
  check(counts.requestSamples>0&&bounded(counts.total)&&counts.total<=counts.requestSamples&&
    statuses.reduce((sum,[,count])=>sum+count,0)===counts.total,'invalid observed journal evidence');
  check(counts.total===0,'verified HTTP samples contain 5xx');
  return `Unknown coverage (0 observed 5xx in ${counts.requestSamples} HTTP-tool samples)`;
}
export const PAGES_POLL_INTERVAL_MS=5000;
export const PAGES_POLL_MAX_FAILURES=5;
export const PAGES_POLL_MAX_BACKOFF_MS=60000;
// Status poll lifecycle after admission. Each poll ends as `running` (base
// interval, failure count reset) or `transient` (network error, timeout, 408,
// 429 or 5xx on the poll's OIDC or status request). Transient polls back off
// exponentially, honor Retry-After, and fail at the consecutive-failure cap or
// when the wait would cross the deadline. Terminal outcomes (other HTTP
// statuses, bad bodies, operation failure, success) never reach this function.
export function pagesPollTransition(state,event) {
  if(event.type==='running') return {state:{failures:0},effect:{type:'sleep',delayMs:PAGES_POLL_INTERVAL_MS}};
  check(event.type==='transient','unknown Pages poll event');
  const failures=state.failures+1;
  if(failures>=PAGES_POLL_MAX_FAILURES) return {state:{failures},effect:{type:'fail',reason:'failure_cap'}};
  const backoff=Math.min(PAGES_POLL_MAX_BACKOFF_MS,PAGES_POLL_INTERVAL_MS*2**(failures-1));
  const delayMs=Math.max(backoff,event.retryAfterMs??0);
  if(!(delayMs<event.remainingMs)) return {state:{failures},effect:{type:'fail',reason:'deadline'}};
  return {state:{failures},effect:{type:'sleep',delayMs,attempt:failures}};
}
const transientStatus=status=>status===408||status===429||(status>=500&&status<=599);
// Canonical delta-seconds only; HTTP dates are not used.
const retryAfterMs=response=>{
  const value=response.headers?.get?.('retry-after');
  return typeof value==='string'&&/^(0|[1-9][0-9]{0,3})$/.test(value)&&Number(value)<=3600?Number(value)*1000:undefined;
};
export const PAGES_ARTIFACT_NAME='pages-release';
export const PAGES_ARTIFACT_MAX_BYTES=64*1024*1024;
const PAGES_ARTIFACT_DIGEST=/^sha256:[0-9a-f]{64}$/;
// Artifact sending is opt-in. lab1 refuses artifact fields unless its policy
// `pages.releaseSource` is `artifact-optional` or `artifact-required`, so the
// reusable workflow sets PAGES_SEND_ARTIFACT only after that policy is live.
export function pagesSendArtifact(env) {
  const value=env.PAGES_SEND_ARTIFACT;
  check(value===undefined||value===''||value==='false'||value==='true','invalid PAGES_SEND_ARTIFACT');
  return value==='true';
}
// Picks the gate run's single `pages-release` artifact. The controller repeats
// these checks and also binds the artifact to the green attempt's release job.
export function resolvePagesArtifact(listing,{buildRunId,sha}) {
  check(listing&&Number.isSafeInteger(listing.total_count)&&listing.total_count>=0&&listing.total_count<=100&&
    Array.isArray(listing.artifacts)&&listing.total_count===listing.artifacts.length,'incomplete Pages artifact listing');
  const matches=listing.artifacts.filter(artifact=>artifact?.name===PAGES_ARTIFACT_NAME);
  check(matches.length===1,'Pages build run must publish exactly one pages-release artifact');
  const [artifact]=matches;
  check(artifact.expired===false,'Pages artifact expired');
  check(Number.isSafeInteger(artifact.size_in_bytes)&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=PAGES_ARTIFACT_MAX_BYTES,
    'Pages artifact size is outside the 64 MiB cap');
  check(String(artifact.workflow_run?.id)===String(buildRunId)&&artifact.workflow_run?.head_sha===sha,
    'Pages artifact belongs to another run or revision');
  const artifactId=String(artifact.id);
  check(/^[1-9][0-9]{0,19}$/.test(artifactId),'invalid Pages artifact id');
  check(typeof artifact.digest==='string'&&PAGES_ARTIFACT_DIGEST.test(artifact.digest),'invalid Pages artifact digest');
  return {artifactId,artifactDigest:artifact.digest};
}
const failures=new WeakMap();
const operationIdPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function pagesFailureDiagnostic(error) {
  return {...failures.get(error)??{phase:'client',code:'unexpected',elapsedMs:0,pollCount:0}};
}
export async function sendPagesDeployment(env,event,{fetchImpl,clock,onAccepted=()=>{},onStatusRetry=()=>{}}) {
  const started=clock.now();let phase='context',code='validation',operationId,pollCount=0,httpStatus;
  const signals=new WeakMap(),transient=new WeakMap();
  const retryable=(error,retryAfter)=>{transient.set(error,{retryAfterMs:retryAfter});return error;};
  const diagnostic=()=>({phase,code,elapsedMs:Math.max(0,Math.min(48*60*1000,Math.trunc(clock.now()-started)||0)),
    pollCount:Math.min(pollCount,100000),...(operationId?{operationId}:{}),
    ...(Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599?{httpStatus}:{})});
  const stage=(next,nextCode)=>{phase=next;code=nextCode;httpStatus=undefined;};
  // `poll` marks requests made by a status poll; only those classify transient failures.
  const transport=async(next,url,options,timeout,poll)=>{
    stage(next,'transport');const signal=AbortSignal.timeout(timeout);
    try {const response=await fetchImpl(url,{...options,signal});signals.set(response,signal);return response;}
    catch(error) {if(signal.aborted&&signal.reason?.name==='TimeoutError') code='timeout';throw poll?retryable(error):error;}
  };
  const json=async(next,response,poll)=>{
    stage(next,'parse');
    try {return await response.json();}
    catch(error) {
      const signal=signals.get(response);
      if(signal?.aborted&&signal.reason?.name==='TimeoutError') {code='timeout';throw poll?retryable(error):error;}
      throw error;
    }
  };
  const ok=(response,message,poll)=>{
    httpStatus=response.status;if(response.ok) return;
    const error=new Error(message);
    throw poll&&transientStatus(response.status)?retryable(error,retryAfterMs(response)):error;
  };
  try {
  check(env.PAGES_PAGE10_ENABLED==='true','Pages caller is disabled');
  const sendArtifact=pagesSendArtifact(env);
  check(env.GITHUB_REPOSITORY==='nteract/nteract' && ['workflow_run','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME),'invalid Pages caller context');
  const automatic=env.GITHUB_EVENT_NAME==='workflow_run',run=event.workflow_run;
  if(automatic) check(run?.event==='push' && run.head_branch==='main' && run.conclusion==='success' && run.status==='completed',
    'Pages event is not a green main push');
  const sha=sourceSha(automatic?run.head_sha:env.INPUT_SHA);
  const body={action:'pages',target:'page10',sha,runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT,
    buildRunId:automatic?run.id:env.INPUT_BUILD_RUN_ID,buildRunAttempt:automatic?run.run_attempt:env.INPUT_BUILD_RUN_ATTEMPT,githubToken:env.GITHUB_TOKEN};
  for(const key of ['runId','runAttempt','buildRunId','buildRunAttempt']) check(/^[1-9][0-9]{0,19}$/.test(String(body[key])),'invalid Pages run identity');
  if(sendArtifact) {
    const response=await transport('artifact',`https://api.github.com/repos/nteract/nteract/actions/runs/${body.buildRunId}/artifacts?name=${PAGES_ARTIFACT_NAME}&per_page=100`,
      {headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'error'},30000);
    stage('artifact','http');ok(response,'Pages artifact listing failed');
    const listing=await json('artifact',response);stage('artifact','provenance');
    Object.assign(body,resolvePagesArtifact(listing,{buildRunId:body.buildRunId,sha}));
  }
  stage('context','validation');
  const oidc=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  check(oidc.protocol==='https:' && !oidc.username && !oidc.password && !oidc.port &&
    (oidc.hostname==='actions.githubusercontent.com'||oidc.hostname.endsWith('.actions.githubusercontent.com')),'invalid OIDC endpoint');
  oidc.searchParams.set('audience',PAGES_CONTROLLER);
  const deadline=clock.now()+48*60*1000;
  // Admission is never retried here: its 202 carries the only operation id.
  const request=async(path,data)=>{
    const poll=!data;
    stage('polling','deadline');
    check(clock.now()<deadline,'Pages polling deadline exceeded; inspect operation, never repost');
    const response=await transport('oidc',oidc,{headers:{Authorization:`Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},redirect:'error'},20000,poll);
    stage('oidc','http');ok(response,'OIDC request failed',poll);
    const token=await json('oidc',response,poll);stage('oidc','schema');const value=token?.value;
    check(typeof value==='string' && value.split('.').length===3,'invalid OIDC token');
    return transport(data?'admission':'status',`${PAGES_CONTROLLER}${path}`,{method:data?'POST':'GET',headers:{Authorization:`Bearer ${value}`,'Content-Type':'application/json'},
      ...(data?{body:JSON.stringify(data)}:{}),redirect:'error'},path==='/deploy'?PAGES_DEPLOY_TIMEOUT_MS:30000,poll);
  };
  const accepted=await request('/deploy',body);stage('admission','http');httpStatus=accepted.status;check(accepted.status===202,'Pages request not accepted');
  const acceptance=await json('admission',accepted);stage('admission','schema');
  check(typeof acceptance?.operationId==='string'&&operationIdPattern.test(acceptance.operationId),'invalid Pages operation id');
  operationId=acceptance.operationId;
  stage('admission','accepted');onAccepted({operationId});
  let poll={failures:0},delayMs=PAGES_POLL_INTERVAL_MS;
  while(true) {
    stage('polling','wait');
    await clock.sleep(delayMs);
    pollCount++;
    let result;
    try {
      const response=await request(`/pages-deployments/${operationId}`);stage('status','http');ok(response,'Pages poll failed',true);
      result=await json('status',response,true);
    } catch(error) {
      if(!transient.has(error)) throw error;
      const step=pagesPollTransition(poll,{type:'transient',retryAfterMs:transient.get(error).retryAfterMs,remainingMs:deadline-clock.now()});
      poll=step.state;
      if(step.effect.type==='fail') throw error;
      delayMs=step.effect.delayMs;
      onStatusRetry({operationId,attempt:step.effect.attempt,phase,code,delayMs,pollCount,
        ...(Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599?{httpStatus}:{})});
      continue;
    }
    stage('status','identity');
    check(result?.operationId===operationId && result.target==='page10' && result.requestedSha===sha,'Pages result identity mismatch');
    stage('status','schema');
    check(['running','failed','succeeded'].includes(result.status),'invalid Pages operation status');
    stage('status','operation_failed');
    check(result.status!=='failed','Pages operation failed; inspect operation, never replay');
    if(result.status==='succeeded') {
      stage('status','evidence');
      check(result.sha===sha && /^[a-f0-9]{12}$/.test(result.build) && typeof result.restorePointKey==='string' &&
        result.counts,'Pages result missing verified release evidence');pagesJournalSummary(result.counts);
      // A v1 source still builds on the host, so artifact evidence may be absent.
      // When present it must name exactly the artifact this request sent.
      check(result.artifact===undefined||(sendArtifact&&result.artifact?.id===body.artifactId&&result.artifact.digest===body.artifactDigest),
        'Pages result names another release artifact');
      return result;
    }
    ({state:poll,effect:{delayMs}}=pagesPollTransition(poll,{type:'running'}));
  }
  } catch(cause) {
    const error=new Error('Pages deployment failed',{cause});
    failures.set(error,Object.freeze(diagnostic()));throw error;
  }
}
export function pagesStepSummary(result) {
  sourceSha(result.sha);
  check(/^[a-f0-9]{12}$/.test(result.build) && /^standalone\/page10-snapshots\/[a-z0-9-]+\/versions.json$/.test(result.restorePointKey) &&
    result.counts,'invalid Pages summary evidence');
  const journal=pagesJournalSummary(result.counts);
  check(result.artifact===undefined||(/^[1-9][0-9]{0,19}$/.test(String(result.artifact?.id))&&
    typeof result.artifact.digest==='string'&&PAGES_ARTIFACT_DIGEST.test(result.artifact.digest)),'invalid Pages artifact evidence');
  const source=result.artifact?`CI artifact ${result.artifact.id} (\`${result.artifact.digest}\`)`:'Host build';
  return `Page10 deployed at \`${result.sha}\`.\n\n| Build | Release source | Restore point | HTTP error observations (lab1 journal) |\n| --- | --- | --- | --- |\n| ${result.build} | ${source} | ${result.restorePointKey} | ${journal} |\n`;
}
