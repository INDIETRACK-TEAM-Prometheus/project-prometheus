import {readFile,open} from 'node:fs/promises';
import {runEvaluation} from '../src/evaluation/runner.js';
import {reasonScenarios} from '../server/reasoner-adapter.js';

const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i++){const key=args[i];if(!key.startsWith('--')||Object.hasOwn(options,key))throw Error('invalid arguments');if(['--execute','--external-transfer'].includes(key))options[key]=true;else {if(!args[i+1]||args[i+1].startsWith('--'))throw Error('missing argument');options[key]=args[++i];}}
const allowed=['--input','--output','--participant','--scene','--split','--execute','--external-transfer','--max-calls','--estimated-budget-usd','--estimated-call-usd','--max-decisions'];
if(Object.keys(options).some(x=>!allowed.includes(x))||!options['--input']||!options['--output'])throw Error('input and new output path required');
const file=await open(options['--output'],'wx');
try {
 const trace=JSON.parse(await readFile(options['--input'],'utf8'));
 const report=await runEvaluation({groups:[{trace,participantId:options['--participant'],sceneId:options['--scene'],split:options['--split']}],execute:options['--execute']===true,externalTransfer:options['--external-transfer']===true,maxCalls:Number(options['--max-calls']),estimatedBudgetUsd:Number(options['--estimated-budget-usd']),estimatedCallUsd:options['--estimated-call-usd']===undefined?0.05:Number(options['--estimated-call-usd']),maxDecisions:options['--max-decisions']===undefined?1:Number(options['--max-decisions']),reasoner:reasonScenarios,kind:'provider'});
 await file.writeFile(JSON.stringify(report,null,2));
} finally {await file.close();}
