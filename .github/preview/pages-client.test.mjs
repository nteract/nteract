import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sendPagesDeployment,pagesStepSummary,pagesJournalSummary,pagesFailureDiagnostic,PAGES_DEPLOY_TIMEOUT_MS} from './pages-client.mjs';
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
    ['status-http','status','http',503],['status-parse','status','parse'],['status-identity','status','identity'],
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
      if(fault===`${current}-http`) return new Response(secret,{status:httpStatus});
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
    assert.deepEqual(diagnostic,{phase,code,elapsedMs:afterAdmission?5000:0,pollCount:afterAdmission?1:0,
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
  const failure=JSON.parse(lines[1]);assert.equal(failure.phase,'status');assert.equal(failure.code,'transport');assert.equal(failure.operationId,id);
  assert.ok(!lines.join('\n').includes(secret));assert.equal(lines.length,3);
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
