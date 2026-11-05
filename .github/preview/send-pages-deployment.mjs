#!/usr/bin/env node
import {readFile,appendFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {sendPagesDeployment,pagesStepSummary} from './pages-client.mjs';
try {
  const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
  const result=await sendPagesDeployment(process.env,event,{fetchImpl:fetch,clock:{now:Date.now,sleep}});
  const summary=pagesStepSummary(result);console.log(summary);
  if(process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,summary);
} catch {console.error('Pages deployment did not complete; inspect the controller operation. No automatic retry of accepted operations.');process.exitCode=1;}
