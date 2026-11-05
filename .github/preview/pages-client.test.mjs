import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendPagesDeployment,pagesStepSummary,PAGES_DEPLOY_TIMEOUT_MS} from './pages-client.mjs';
const sha='a'.repeat(40),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const env={PAGES_PAGE10_ENABLED:'true',GITHUB_REPOSITORY:'nteract/nteract',GITHUB_EVENT_NAME:'workflow_run',GITHUB_RUN_ID:'10',GITHUB_RUN_ATTEMPT:'1',
  GITHUB_TOKEN:'secret',ACTIONS_ID_TOKEN_REQUEST_URL:'https://actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'oidc'};
const event={workflow_run:{event:'push',head_branch:'main',head_sha:sha,id:20,run_attempt:1,status:'completed',conclusion:'success'}};
const result={operationId:id,requestedSha:sha,sha,target:'page10',status:'succeeded',build:'b'.repeat(12),
  restorePointKey:'standalone/page10-snapshots/2026-11-04-210000-auto/versions.json',counts:{total:0}};
test('client obtains audience-bound OIDC per poll and posts exact source once with release summary',async t=>{
  let time=0;const calls=[],timeouts=[];
  t.mock.method(AbortSignal,'timeout',ms=>{timeouts.push(ms);return new AbortController().signal;});
  const fetchImpl=async(url,options)=>{
    calls.push({url:String(url),options});
    if(String(url).includes('actions.githubusercontent.com')) {assert.equal(new URL(url).searchParams.get('audience'),'https://deploy.runtimed.run');return Response.json({value:'a.b.c'});}
    if(options.method==='POST') {const body=JSON.parse(options.body);assert.equal(body.sha,sha);assert.equal(body.target,'page10');return Response.json({operationId:id},{status:202});}
    return Response.json(result);
  };
  assert.deepEqual(await sendPagesDeployment(env,event,{fetchImpl,clock:{now:()=>time,sleep:async ms=>{time+=ms;}}}),result);
  assert.equal(calls.filter(c=>c.options.method==='POST').length,1);assert.equal(calls.length,4);
  assert.equal(PAGES_DEPLOY_TIMEOUT_MS,420000);
  assert.deepEqual(timeouts,[20000,PAGES_DEPLOY_TIMEOUT_MS,20000,30000]);
  assert.match(pagesStepSummary(result),/Post-deploy 5xx/);
});
test('disabled caller, failed CI and bad status never retry accepted deployment',async()=>{
  for(const change of [{PAGES_PAGE10_ENABLED:'false'},{GITHUB_REPOSITORY:'fork/repo'}])
    await assert.rejects(sendPagesDeployment({...env,...change},event,{fetchImpl:()=>assert.fail(),clock:{now:()=>0}}));
  await assert.rejects(sendPagesDeployment(env,{workflow_run:{...event.workflow_run,conclusion:'cancelled'}},{fetchImpl:()=>assert.fail(),clock:{now:()=>0}}));
  for(const status of ['failed','bad','network','expired']) {
    let posts=0,time=0;
    await assert.rejects(sendPagesDeployment(env,event,{clock:{now:()=>time,sleep:async()=>{time+=status==='expired'?49*60000:5000;}},fetchImpl:async(url,options)=>{
      if(String(url).includes('actions.githubusercontent.com')) return Response.json({value:'a.b.c'});
      if(options.method==='POST') {posts++;return Response.json({operationId:id},{status:202});}
      if(status==='network') throw new Error('private');return Response.json({...result,status});
    }}));assert.equal(posts,1,status);
  }
});
