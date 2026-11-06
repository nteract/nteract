import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sendPagesDeployment,pagesStepSummary,pagesJournalSummary,pagesFailureDiagnostic,pagesPollTransition,PAGES_DEPLOY_TIMEOUT_MS,
  resolvePagesArtifact,pagesSendArtifact,PAGES_ARTIFACT_MAX_BYTES,
  PAGES_POLL_INTERVAL_MS,PAGES_POLL_MAX_FAILURES,PAGES_POLL_MAX_BACKOFF_MS} from './pages-client.mjs';
const sha='a'.repeat(40),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const env={PAGES_PAGE10_ENABLED:'true',GITHUB_REPOSITORY:'nteract/nteract',GITHUB_EVENT_NAME:'workflow_run',GITHUB_RUN_ID:'10',GITHUB_RUN_ATTEMPT:'1',
  GITHUB_TOKEN:'secret',ACTIONS_ID_TOKEN_REQUEST_URL:'https://actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'oidc'};
const event={workflow_run:{event:'push',head_branch:'main',head_sha:sha,id:20,run_attempt:1,status:'completed',conclusion:'success'}};
const result={operationId:id,requestedSha:sha,sha,target:'page10',status:'succeeded',build:'b'.repeat(12),
  restorePointKey:'standalone/page10-snapshots/2026-11-04-210000-auto/versions.json',counts:{total:0}};
test('journal summary renders legacy and absent coverage as Unknown, refusing qualified failures',()=>{
  const unknown={schema:1,coverage:'unknown',completeness:'unknown',total:null,byStatus:{},invalidLines:0,envelopes:741,
    parseableMessages:14,textMessages:727,requestSamples:0};
  assert.match(pagesStepSummary({...result,counts:unknown}),/Unknown \(no verified HTTP samples\)/);
  assert.equal(pagesJournalSummary({total:0}),'Unknown (legacy unverified count: 0)');
  for(const total of [1,3,-1,0.5,'0',null]) assert.throws(()=>pagesJournalSummary({total}));
  const observed={...unknown,coverage:'observed',total:0,requestSamples:2};
  assert.match(pagesJournalSummary(observed),/Unknown coverage \(0 observed 5xx in 2 HTTP-tool samples\)/);
  for(const counts of [{...unknown,total:0},{...unknown,invalidLines:1},{...unknown,completeness:'complete'},
    {...unknown,schema:2},{...observed,total:1,byStatus:{503:1}},{...observed,byStatus:{'secret':1}},
    {...unknown,envelopes:100001},{...unknown,total:null,requestSamples:1},{total:0,coverage:'complete'},
    {total:0,invalidLines:1}]) assert.throws(()=>pagesJournalSummary(counts));
});
test('successful operation accepts unknown coverage but rejects malformed evidence and observed 5xx',async()=>{
  const unknown={schema:1,coverage:'unknown',completeness:'unknown',total:null,byStatus:{},invalidLines:0,envelopes:1,
    parseableMessages:0,textMessages:1,requestSamples:0};
  for(const counts of [unknown,{...unknown,coverage:'observed',total:1,byStatus:{503:1},requestSamples:1,parseableMessages:1},
    {...unknown,invalidLines:1},{total:1},{total:-1}]) {
    let posts=0,time=0;
    const promise=sendPagesDeployment(env,event,{clock:{now:()=>time,sleep:async ms=>time+=ms},fetchImpl:async(url,options)=>{
      if(String(url).includes('actions.githubusercontent.com')) return Response.json({value:'a.b.c'});
      if(options.method==='POST') {posts++;return Response.json({operationId:id},{status:202});}
      return Response.json({...result,counts});
    }});
    if(counts===unknown) assert.deepEqual((await promise).counts,unknown);
    else await assert.rejects(promise,error=>pagesFailureDiagnostic(error).code==='evidence');
    assert.equal(posts,1);
  }
});
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
  assert.match(pagesStepSummary(result),/Unknown \(legacy unverified count: 0\)/);
});
test('diagnostics distinguish bounded request failures and never disclose untrusted values',async t=>{
  const secret='private-token-and-response-content',controllers=[];
  t.mock.method(AbortSignal,'timeout',()=>{const controller=new AbortController();controllers.push(controller);return controller.signal;});
  const cases=[
    ['oidc-http','oidc','http',401],['oidc-parse','oidc','parse'],['oidc-schema','oidc','schema'],
    ['oidc-transport','oidc','transport'],['oidc-timeout','oidc','timeout'],
    ['admission-http','admission','http',503],['admission-parse','admission','parse'],['admission-schema','admission','schema'],
    ['admission-transport','admission','transport'],['admission-timeout','admission','timeout'],
    ['status-http','status','http',404],['status-retried-http','status','http',503],['status-parse','status','parse'],['status-identity','status','identity'],
    ['status-schema','status','schema'],['status-failed','status','operation_failed'],['status-evidence','status','evidence'],
    ['status-transport','status','transport'],['status-timeout','status','timeout'],['status-body-timeout','status','timeout'],
  ];
  for(const [fault,phase,code,httpStatus] of cases) {
    let posts=0,time=0,accepted=[];
    const fetchImpl=async(url,options)=>{
      const current=String(url).includes('actions.githubusercontent.com')?'oidc':options.method==='POST'?'admission':'status';
      if(current==='admission') posts++;
      if(fault===`${current}-transport`) throw new Error(secret);
      if(fault===`${current}-timeout`) {controllers.at(-1).abort(new DOMException(secret,'TimeoutError'));throw new Error(secret);}
      if(fault===`${current}-http`||(fault==='status-retried-http'&&current==='status')) return new Response(secret,{status:httpStatus});
      if(fault===`${current}-parse`) return new Response(secret,{status:current==='admission'?202:200});
      if(fault===`${current}-schema`) return Response.json(current==='admission'?{operationId:'-'.repeat(36)}:current==='status'?{...result,status:secret}:{value:secret},
        {status:current==='admission'?202:200});
      if(current==='oidc') return Response.json({value:'synthetic.token.only'});
      if(current==='admission') return Response.json({operationId:id},{status:202});
      if(fault==='status-identity') return Response.json({...result,operationId:secret});
      if(fault==='status-failed') return Response.json({...result,status:'failed',error:secret,errorCode:secret});
      if(fault==='status-evidence') return Response.json({...result,build:secret});
      if(fault==='status-body-timeout') {
        const signal=controllers.at(-1);return {ok:true,status:200,json:async()=>{signal.abort(new DOMException(secret,'TimeoutError'));throw new Error(secret);}};
      }
      return Response.json(result);
    };
    let caught;
    await assert.rejects(sendPagesDeployment({...env,GITHUB_TOKEN:secret},event,{fetchImpl,
      clock:{now:()=>time,sleep:async ms=>time+=ms},onAccepted:value=>accepted.push(value)}),error=>{caught=error;return true;});
    const diagnostic=pagesFailureDiagnostic(caught),afterAdmission=phase==='status';
    // Transient status failures retry to the cap: sleeps of 5+5+10+20+40 seconds.
    const retried=['status-retried-http','status-transport','status-timeout','status-body-timeout'].includes(fault);
    assert.deepEqual(diagnostic,{phase,code,elapsedMs:retried?80000:afterAdmission?5000:0,pollCount:retried?5:afterAdmission?1:0,
      ...(afterAdmission?{operationId:id}:{}),...(httpStatus?{httpStatus}:{})},fault);
    assert.equal(posts,phase==='oidc'?0:1,fault);
    assert.deepEqual(accepted,afterAdmission?[{operationId:id}]:[],fault);
    assert.ok(!JSON.stringify(diagnostic).includes(secret));assert.ok(!JSON.stringify(diagnostic).includes('stack'));
    assert.ok(caught.cause,'cause retained internally');
  }
  const forged=Object.assign(new Error(secret),{phase:secret,code:secret,operationId:secret,diagnostic:{code:secret}});
  assert.deepEqual(pagesFailureDiagnostic(forged),{phase:'client',code:'unexpected',elapsedMs:0,pollCount:0});
});

test('poll diagnostics retain accepted identity after repeated running responses and fresh OIDC failure',async()=>{
  let time=0,posts=0,oidc=0,polls=0;
  await assert.rejects(sendPagesDeployment(env,event,{clock:{now:()=>time,sleep:async ms=>time+=ms},fetchImpl:async(url,options)=>{
    if(String(url).includes('actions.githubusercontent.com')) return ++oidc===4?new Response(null,{status:401}):Response.json({value:'a.b.c'});
    if(options.method==='POST') {posts++;return Response.json({operationId:id},{status:202});}
    polls++;return Response.json({...result,status:'running'});
  }}),error=>{
    assert.deepEqual(pagesFailureDiagnostic(error),{phase:'oidc',code:'http',elapsedMs:15000,pollCount:3,operationId:id,httpStatus:401});return true;
  });
  assert.equal(posts,1);assert.equal(polls,2);
});
test('untrusted status and timeout names cannot manufacture diagnostic fields',async()=>{
  for(const status of ['503',999,'private-token']) {
    await assert.rejects(sendPagesDeployment(env,event,{clock:{now:()=>0},fetchImpl:async()=>({ok:false,status})}),error=>{
      assert.deepEqual(pagesFailureDiagnostic(error),{phase:'oidc',code:'http',elapsedMs:0,pollCount:0});return true;
    });
  }
  await assert.rejects(sendPagesDeployment(env,event,{clock:{now:()=>0},fetchImpl:async()=>{
    throw Object.assign(new Error('private-token'),{name:'TimeoutError'});
  }}),error=>{assert.equal(pagesFailureDiagnostic(error).code,'transport');return true;});
});

test('final receipt after running succeeds once without weakening evidence validation',async()=>{
  let polls=0,posts=0,time=0;
  const actual=await sendPagesDeployment(env,event,{clock:{now:()=>time,sleep:async ms=>time+=ms},fetchImpl:async(url,options)=>{
    if(String(url).includes('actions.githubusercontent.com')) return Response.json({value:'a.b.c'});
    if(options.method==='POST') {posts++;return Response.json({operationId:id},{status:202});}
    return Response.json(++polls===1?{...result,status:'running'}:result);
  }});
  assert.deepEqual(actual,result);assert.equal(posts,1);assert.equal(polls,2);
});

test('CLI prints only accepted identity and safe diagnostics, never cause or response text',async()=>{
  const source=await readFile(new URL('./send-pages-deployment.mjs',import.meta.url),'utf8');
  const client=new URL('./pages-client.mjs',import.meta.url).href;
  const cli=source.replace(/^#![^\n]*\n/,'').replace("import {readFile,appendFile} from 'node:fs/promises';",'const readFile=async()=>"{}",appendFile=async()=>{};')
    .replace("import {setTimeout as sleep} from 'node:timers/promises';",'const sleep=async()=>{};')
    .replace("'./pages-client.mjs'",JSON.stringify(client));
  const lines=[],secret='unsafe-stack-token-response';let posts=0;
  const context={env:{...env,GITHUB_EVENT_NAME:'workflow_dispatch',INPUT_SHA:sha,INPUT_BUILD_RUN_ID:'20',INPUT_BUILD_RUN_ATTEMPT:'1',GITHUB_EVENT_PATH:'synthetic'},exitCode:0};
  const fetch=async(url,options)=>{
    if(String(url).includes('actions.githubusercontent.com')) return Response.json({value:'a.b.c'});
    if(options.method==='POST') {posts++;return Response.json({operationId:id},{status:202});}
    throw new Error(secret);
  };
  // Execute the CLI body with imports resolved locally and injected I/O, not a
  // real Actions environment or network. Only the CLI's console output is read.
  const executable=cli.replace(/^import .*from (.*);$/m,'const {sendPagesDeployment,pagesStepSummary,pagesFailureDiagnostic}=await import($1);');
  await new (Object.getPrototypeOf(async function(){}).constructor)('process','fetch','console',executable)(context,fetch,
    {log:value=>lines.push(value),error:value=>lines.push(value)});
  assert.equal(context.exitCode,1);assert.equal(posts,1);
  assert.deepEqual(JSON.parse(lines[0]),{event:'pages_deployment_accepted',operationId:id});
  const failure=JSON.parse(lines[5]);assert.equal(failure.phase,'status');assert.equal(failure.code,'transport');assert.equal(failure.operationId,id);
  assert.ok(!lines.join('\n').includes(secret));assert.equal(lines.length,7);
  assert.deepEqual(lines.slice(1,5).map(line=>JSON.parse(line)),[1,2,3,4].map(attempt=>({event:'pages_deployment_status_retry',
    operationId:id,attempt,phase:'status',code:'transport',delayMs:5000*2**(attempt-1),pollCount:attempt})));
});
test('CLI summary failure preserves completed deployment and never recommends redispatch',async()=>{
  const source=await readFile(new URL('./send-pages-deployment.mjs',import.meta.url),'utf8');
  for(const fault of ['validation','write']) {
    const secret='private-summary-path-and-error',lines=[];let posts=0,writes=0;
    const cli=source.replace(/^#![^\n]*\n/,'')
      .replace("import {readFile,appendFile} from 'node:fs/promises';",'const readFile=async()=>"{}";')
      .replace("import {setTimeout as sleep} from 'node:timers/promises';",'const sleep=async()=>{};')
      .replace("'./pages-client.mjs'",JSON.stringify(new URL('./pages-client.mjs',import.meta.url).href))
      .replace(/^import .*from (.*);$/m,'const {sendPagesDeployment,pagesStepSummary,pagesFailureDiagnostic}=await import($1);');
    const context={env:{...env,GITHUB_EVENT_NAME:'workflow_dispatch',INPUT_SHA:sha,INPUT_BUILD_RUN_ID:'20',INPUT_BUILD_RUN_ATTEMPT:'1',
      GITHUB_EVENT_PATH:'synthetic',GITHUB_STEP_SUMMARY:secret},exitCode:0};
    await new (Object.getPrototypeOf(async function(){}).constructor)('process','fetch','console','appendFile',cli)(context,async(url,options)=>{
      if(String(url).includes('actions.githubusercontent.com')) return Response.json({value:'a.b.c'});
      if(options.method==='POST') {posts++;return Response.json({operationId:id},{status:202});}
      return Response.json({...result,...(fault==='validation'?{restorePointKey:secret}:{})});
    },{log:value=>lines.push(value),error:value=>lines.push(value)},async()=>{writes++;throw new Error(secret);});
    assert.equal(context.exitCode,1);assert.equal(posts,1);assert.equal(writes,fault==='write'?1:0);
    const diagnostic=lines.filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).at(-1);
    assert.deepEqual(diagnostic,{event:'pages_deployment_report_failed',status:'succeeded',operationId:id,phase:'summary',code:fault});
    assert.match(lines.at(-1),/Deployment completed; summary report failed\. Do not redispatch/);
    assert.ok(!lines.join('\n').includes(secret));assert.ok(!lines.join('\n').includes('deployment did not complete'));
  }
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

// Status-poll retry harness: `statuses` scripts each status poll as a Response,
// an Error to throw, or the string 'oidc-503' for a transient OIDC failure.
const pollHarness=(statuses,{sleep}={})=>{
  let time=0,posts=0,polls=0,oidcPolls=0;const sleeps=[],retries=[],queue=[...statuses];let pending;
  const run=sendPagesDeployment(env,event,{onStatusRetry:value=>retries.push(value),
    clock:{now:()=>time,sleep:async ms=>{sleeps.push(ms);time+=sleep?.(ms)??ms;}},fetchImpl:async(url,options)=>{
      if(String(url).includes('actions.githubusercontent.com')) {
        if(posts===0) return Response.json({value:'a.b.c'});
        oidcPolls++;pending=queue.shift()??Response.json(result);
        if(pending==='oidc-503') return new Response(null,{status:503});
        return Response.json({value:'a.b.c'});
      }
      if(options.method==='POST') {posts++;return Response.json({operationId:id},{status:202});}
      polls++;if(pending instanceof Error) throw pending;return typeof pending==='function'?pending():pending;
    }});
  return {run,stats:()=>({posts,polls,oidcPolls,sleeps,retries,time})};
};
const running=()=>Response.json({...result,status:'running'});
test('poll transition backs off, resets on running, honors Retry-After, caps failures and respects the deadline',()=>{
  let state={failures:0};const delays=[];
  for(let i=1;i<PAGES_POLL_MAX_FAILURES;i++) {
    const step=pagesPollTransition(state,{type:'transient',remainingMs:Infinity});state=step.state;
    assert.equal(step.effect.type,'sleep');assert.equal(step.effect.attempt,i);delays.push(step.effect.delayMs);
  }
  assert.deepEqual(delays,[5000,10000,20000,40000]);
  assert.deepEqual(pagesPollTransition(state,{type:'transient',remainingMs:Infinity}),{state:{failures:5},effect:{type:'fail',reason:'failure_cap'}});
  assert.deepEqual(pagesPollTransition(state,{type:'running'}),{state:{failures:0},effect:{type:'sleep',delayMs:PAGES_POLL_INTERVAL_MS}});
  assert.equal(pagesPollTransition({failures:9},{type:'running'}).state.failures,0);
  assert.equal(pagesPollTransition({failures:20},{type:'running'}).effect.delayMs,PAGES_POLL_INTERVAL_MS);
  assert.ok(Math.max(...delays)<=PAGES_POLL_MAX_BACKOFF_MS);
  assert.equal(pagesPollTransition({failures:0},{type:'transient',retryAfterMs:30000,remainingMs:Infinity}).effect.delayMs,30000);
  assert.equal(pagesPollTransition({failures:2},{type:'transient',retryAfterMs:1000,remainingMs:Infinity}).effect.delayMs,20000);
  assert.deepEqual(pagesPollTransition({failures:0},{type:'transient',remainingMs:5000}).effect,{type:'fail',reason:'deadline'});
  assert.deepEqual(pagesPollTransition({failures:0},{type:'transient',retryAfterMs:3600000,remainingMs:600000}).effect,{type:'fail',reason:'deadline'});
  assert.throws(()=>pagesPollTransition({failures:0},{type:'other'}));
});
test('one transport error on a status poll retries, logs the retry, and succeeds without reposting',async()=>{
  const {run,stats}=pollHarness([new Error('socket hang up'),running(),result].map(v=>v===result?Response.json(result):v));
  assert.deepEqual(await run,result);
  const {posts,polls,sleeps,retries}=stats();
  assert.equal(posts,1);assert.equal(polls,3);assert.deepEqual(sleeps,[5000,5000,5000]);
  assert.deepEqual(retries,[{operationId:id,attempt:1,phase:'status',code:'transport',delayMs:5000,pollCount:1}]);
});
test('failures reset after a running poll, so only consecutive errors count toward the cap',async()=>{
  const net=()=>new Error('reset');
  const {run,stats}=pollHarness([net(),net(),net(),net(),running(),net(),net(),net(),net(),Response.json(result)]);
  assert.deepEqual(await run,result);
  const {posts,retries}=stats();assert.equal(posts,1);assert.deepEqual(retries.map(r=>r.attempt),[1,2,3,4,1,2,3,4]);
});
test('consecutive status transport errors fail with code transport at the cap',async()=>{
  const {run,stats}=pollHarness(Array.from({length:10},()=>new Error('private')));
  await assert.rejects(run,error=>{
    assert.deepEqual(pagesFailureDiagnostic(error),{phase:'status',code:'transport',elapsedMs:80000,pollCount:PAGES_POLL_MAX_FAILURES,operationId:id});return true;
  });
  const {posts,polls,retries}=stats();assert.equal(posts,1);assert.equal(polls,PAGES_POLL_MAX_FAILURES);assert.equal(retries.length,PAGES_POLL_MAX_FAILURES-1);
});
test('503, 502, 408 and 429 status responses retry; 429 Retry-After lengthens the wait',async()=>{
  for(const status of [503,502,408,429]) {
    const headers=status===429?{'retry-after':'30'}:{};
    const {run,stats}=pollHarness([new Response('busy',{status,headers}),Response.json(result)]);
    assert.deepEqual(await run,result,String(status));
    const {posts,sleeps,retries}=stats();assert.equal(posts,1);
    assert.deepEqual(retries,[{operationId:id,attempt:1,phase:'status',code:'http',httpStatus:status,delayMs:status===429?30000:5000,pollCount:1}]);
    assert.deepEqual(sleeps,[5000,status===429?30000:5000]);
  }
  for(const value of ['Wed, 21 Oct 2026 07:28:00 GMT','-1','3601','01','1.5']) {
    const {run,stats}=pollHarness([new Response(null,{status:429,headers:{'retry-after':value}}),Response.json(result)]);
    await run;assert.equal(stats().retries[0].delayMs,5000,value);
  }
});
test('transient OIDC failure during polling retries without reposting',async()=>{
  const {run,stats}=pollHarness(['oidc-503',Response.json(result)]);
  assert.deepEqual(await run,result);
  const {posts,polls,retries}=stats();assert.equal(posts,1);assert.equal(polls,1);
  assert.deepEqual(retries,[{operationId:id,attempt:1,phase:'oidc',code:'http',httpStatus:503,delayMs:5000,pollCount:1}]);
});
test('401, 403, 404 and operation_failed stay terminal on the first poll',async()=>{
  for(const status of [401,403,404]) {
    const {run,stats}=pollHarness([new Response(null,{status}),Response.json(result)]);
    await assert.rejects(run,error=>{
      assert.deepEqual(pagesFailureDiagnostic(error),{phase:'status',code:'http',httpStatus:status,elapsedMs:5000,pollCount:1,operationId:id});return true;
    });
    assert.equal(stats().retries.length,0);assert.equal(stats().polls,1);
  }
  const {run,stats}=pollHarness([Response.json({...result,status:'failed'})]);
  await assert.rejects(run,error=>pagesFailureDiagnostic(error).code==='operation_failed');
  assert.equal(stats().retries.length,0);assert.equal(stats().posts,1);
  // Admission-time OIDC and admission failures keep their single-attempt behavior.
  let posts=0;
  await assert.rejects(sendPagesDeployment(env,event,{clock:{now:()=>0,sleep:async()=>{}},fetchImpl:async(url,options)=>{
    if(String(url).includes('actions.githubusercontent.com')) return Response.json({value:'a.b.c'});
    posts++;return new Response(null,{status:503});
  }}),error=>{assert.deepEqual(pagesFailureDiagnostic(error),{phase:'admission',code:'http',httpStatus:503,elapsedMs:0,pollCount:0});return true;});
  assert.equal(posts,1);
});
test('retries stop at the overall deadline instead of waiting past it',async()=>{
  // Three running polls consume 45 minutes; the next 429 asks for an hour.
  let n=0;
  const {run,stats}=pollHarness([running(),running(),running(),new Response(null,{status:429,headers:{'retry-after':'3600'}})],
    {sleep:ms=>++n<=3?15*60*1000:ms});
  await assert.rejects(run,error=>{
    const d=pagesFailureDiagnostic(error);assert.equal(d.phase,'status');assert.equal(d.code,'http');assert.equal(d.httpStatus,429);return true;
  });
  assert.equal(stats().retries.length,0);assert.equal(stats().posts,1);
  // Persistent errors near the deadline end on the deadline guard, never a repost.
  let m=0;
  const late=pollHarness(Array.from({length:10},()=>new Error('x')),{sleep:ms=>++m===1?47*60*1000+50000:ms});
  await assert.rejects(late.run,error=>{assert.equal(pagesFailureDiagnostic(error).phase,'status');return true;});
  assert.ok(late.stats().time<48*60*1000);assert.equal(late.stats().posts,1);
});

// Release artifact: resolution and opt-in request fields.
const digest=`sha256:${'c'.repeat(64)}`;
const artifact={id:30,name:'pages-release',expired:false,size_in_bytes:24*1024*1024,digest,workflow_run:{id:20,head_sha:sha}};
const listing=(...artifacts)=>({total_count:artifacts.length,artifacts});
test('artifact resolution returns the single unexpired pages-release of the build run',()=>{
  assert.deepEqual(resolvePagesArtifact(listing(artifact),{buildRunId:20,sha}),{artifactId:'30',artifactDigest:digest});
  assert.deepEqual(resolvePagesArtifact(listing({...artifact,id:31,name:'other'},artifact),{buildRunId:'20',sha}),{artifactId:'30',artifactDigest:digest});
});
test('artifact resolution fails closed on zero, duplicate, expired, oversized or incomplete listings',()=>{
  assert.throws(()=>resolvePagesArtifact(listing(),{buildRunId:20,sha}),/exactly one/);
  assert.throws(()=>resolvePagesArtifact(listing({...artifact,name:'pages-release-x'}),{buildRunId:20,sha}),/exactly one/);
  assert.throws(()=>resolvePagesArtifact(listing(artifact,{...artifact,id:31}),{buildRunId:20,sha}),/exactly one/);
  assert.throws(()=>resolvePagesArtifact(listing({...artifact,expired:true}),{buildRunId:20,sha}),/expired/);
  for(const expired of [undefined,'false',null]) assert.throws(()=>resolvePagesArtifact(listing({...artifact,expired}),{buildRunId:20,sha}),/expired/);
  for(const size_in_bytes of [0,PAGES_ARTIFACT_MAX_BYTES+1,'1',undefined]) assert.throws(()=>resolvePagesArtifact(listing({...artifact,size_in_bytes}),{buildRunId:20,sha}),/64 MiB/);
  for(const bad of [undefined,{},{total_count:2,artifacts:[artifact]},{total_count:101,artifacts:Array(101).fill(artifact)},{total_count:1,artifacts:{}}])
    assert.throws(()=>resolvePagesArtifact(bad,{buildRunId:20,sha}),/incomplete/);
});
test('artifact resolution refuses another run or revision, bad ids and malformed digests',()=>{
  for(const workflow_run of [{id:21,head_sha:sha},{id:20,head_sha:'b'.repeat(40)},undefined,{id:20}])
    assert.throws(()=>resolvePagesArtifact(listing({...artifact,workflow_run}),{buildRunId:20,sha}),/another run or revision/);
  for(const id of [0,-1,'01',undefined,1.5]) assert.throws(()=>resolvePagesArtifact(listing({...artifact,id}),{buildRunId:20,sha}),/artifact id/);
  for(const bad of ['c'.repeat(64),`sha256:${'C'.repeat(64)}`,`sha256:${'c'.repeat(63)}`,`sha512:${'c'.repeat(64)}`,`sha256:${'c'.repeat(64)}\n`,undefined,null])
    assert.throws(()=>resolvePagesArtifact(listing({...artifact,digest:bad}),{buildRunId:20,sha}),/artifact digest/);
});
test('artifact sending is off unless PAGES_SEND_ARTIFACT is exactly true',()=>{
  for(const value of [undefined,'','false']) assert.equal(pagesSendArtifact({PAGES_SEND_ARTIFACT:value}),false);
  assert.equal(pagesSendArtifact({}),false);assert.equal(pagesSendArtifact({PAGES_SEND_ARTIFACT:'true'}),true);
  for(const value of ['TRUE','1','yes',' true']) assert.throws(()=>pagesSendArtifact({PAGES_SEND_ARTIFACT:value}),/PAGES_SEND_ARTIFACT/);
});
const artifactHarness=(sendEnv,{artifacts=listing(artifact),status=result,listStatus=200}={})=>{
  let time=0;const posts=[],lists=[];
  const run=sendPagesDeployment({...env,...sendEnv},event,{clock:{now:()=>time,sleep:async ms=>time+=ms},fetchImpl:async(url,options)=>{
    const target=new URL(url);
    if(target.hostname==='api.github.com') {lists.push({url:target,options});return Response.json(artifacts,{status:listStatus});}
    if(target.hostname.endsWith('actions.githubusercontent.com')) return Response.json({value:'a.b.c'});
    if(options.method==='POST') {posts.push(JSON.parse(options.body));return Response.json({operationId:id},{status:202});}
    return Response.json(status);
  }});
  return {run,posts,lists};
};
test('admission body carries artifact fields only when enabled',async()=>{
  for(const sendEnv of [{},{PAGES_SEND_ARTIFACT:'false'}]) {
    const {run,posts,lists}=artifactHarness(sendEnv);await run;
    assert.equal(lists.length,0);assert.equal(posts.length,1);
    assert.ok(!('artifactId' in posts[0])&&!('artifactDigest' in posts[0]));
  }
  const {run,posts,lists}=artifactHarness({PAGES_SEND_ARTIFACT:'true'});await run;
  assert.equal(lists.length,1);
  assert.equal(lists[0].url.href,'https://api.github.com/repos/nteract/nteract/actions/runs/20/artifacts?name=pages-release&per_page=100');
  assert.equal(lists[0].options.headers.Authorization,'Bearer secret');assert.equal(lists[0].options.redirect,'error');
  assert.equal(posts.length,1);assert.equal(posts[0].artifactId,'30');assert.equal(posts[0].artifactDigest,digest);
  assert.equal(posts[0].buildRunId,20);assert.equal(posts[0].sha,sha);
  // Manual dispatch resolves against the input build run.
  const manual=artifactHarness({PAGES_SEND_ARTIFACT:'true',GITHUB_EVENT_NAME:'workflow_dispatch',INPUT_SHA:sha,INPUT_BUILD_RUN_ID:'20',INPUT_BUILD_RUN_ATTEMPT:'2'});
  await manual.run;assert.match(manual.lists[0].url.pathname,/\/runs\/20\/artifacts$/);assert.equal(manual.posts[0].artifactId,'30');
});
test('unresolvable artifact fails before admission with safe diagnostics',async()=>{
  for(const [options,code,httpStatus] of [[{artifacts:listing()},'provenance'],[{artifacts:listing(artifact,{...artifact,id:31})},'provenance'],
    [{artifacts:listing({...artifact,expired:true})},'provenance'],[{artifacts:listing({...artifact,workflow_run:{id:20,head_sha:'b'.repeat(40)}})},'provenance'],
    [{listStatus:404},'http',404]]) {
    const {run,posts}=artifactHarness({PAGES_SEND_ARTIFACT:'true'},options);
    await assert.rejects(run,error=>{
      assert.deepEqual(pagesFailureDiagnostic(error),{phase:'artifact',code,elapsedMs:0,pollCount:0,...(httpStatus?{httpStatus}:{})});return true;
    });
    assert.equal(posts.length,0);
  }
  const {run,posts}=artifactHarness({PAGES_SEND_ARTIFACT:'yes'});
  await assert.rejects(run,error=>pagesFailureDiagnostic(error).phase==='context');assert.equal(posts.length,0);
});
test('result artifact evidence must match the sent artifact and appears in the summary',async()=>{
  const evidence={id:'30',digest};
  assert.equal((await artifactHarness({PAGES_SEND_ARTIFACT:'true'},{status:{...result,artifact:evidence}}).run).artifact.id,'30');
  for(const [sendEnv,artifactEvidence] of [[{PAGES_SEND_ARTIFACT:'true'},{id:'31',digest}],[{PAGES_SEND_ARTIFACT:'true'},{id:'30',digest:`sha256:${'d'.repeat(64)}`}],
    [{},evidence],[{PAGES_SEND_ARTIFACT:'true'},null]])
    await assert.rejects(artifactHarness(sendEnv,{status:{...result,artifact:artifactEvidence}}).run,error=>pagesFailureDiagnostic(error).code==='evidence');
  assert.match(pagesStepSummary({...result,artifact:evidence}),new RegExp(`CI artifact 30 \\(\`${digest}\`\\)`));
  assert.match(pagesStepSummary(result),/\| Host build \|/);
  for(const bad of [{id:'0',digest},{id:'30',digest:'x'},null]) assert.throws(()=>pagesStepSummary({...result,artifact:bad}));
});
