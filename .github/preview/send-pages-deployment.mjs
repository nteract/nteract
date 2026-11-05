#!/usr/bin/env node
import {readFile,appendFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {sendPagesDeployment,pagesStepSummary,pagesFailureDiagnostic} from './pages-client.mjs';
let acceptedOperationId,result;
try {
  const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
  result=await sendPagesDeployment(process.env,event,{fetchImpl:fetch,clock:{now:Date.now,sleep},
    onAccepted:({operationId})=>{acceptedOperationId=operationId;console.log(JSON.stringify({event:'pages_deployment_accepted',operationId}));}});
} catch(error) {
  console.error(JSON.stringify({event:'pages_deployment_failed',...(acceptedOperationId?{operationId:acceptedOperationId}:{}),...pagesFailureDiagnostic(error)}));
  console.error('Pages deployment did not complete; inspect the controller operation. No automatic retry of accepted operations.');process.exitCode=1;
}
if(result) {
  let code='validation';
  try {
    const summary=pagesStepSummary(result);code='write';console.log(summary);
    if(process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,summary);
  } catch {
    console.error(JSON.stringify({event:'pages_deployment_report_failed',status:'succeeded',operationId:acceptedOperationId,phase:'summary',code}));
    console.error('Deployment completed; summary report failed. Do not redispatch this operation.');process.exitCode=1;
  }
}
