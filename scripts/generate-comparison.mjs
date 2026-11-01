import {open,readFile,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {adapterGaps,generateComparison,planComparison,toReasonerAdapterInput} from '../src/evaluation/generator.js';

const usage=`Usage:
  node scripts/generate-comparison.mjs --manifest manifest.json --decisions decisions.json [--base-dir dir] [--dry-run] [--output plan.json]
  node scripts/generate-comparison.mjs --manifest manifest.json --decisions decisions.json --execute --external-transfer --max-calls N --budget-usd X --ledger ledger.jsonl [--base-dir dir] [--estimated-call-usd 0.05] [--timeout-ms 60000] [--raw-dir dir] [--provider-module file.mjs --provenance synthetic|provider]
Dry run is the default: it builds and hashes every prompt input and never calls a provider.`;
const booleans=['--dry-run','--execute','--external-transfer'],valued=['--manifest','--decisions','--base-dir','--output','--ledger','--max-calls','--budget-usd','--estimated-call-usd','--timeout-ms','--raw-dir','--provider-module','--provenance'];
const maxInput=64*1024*1024;

function parse(argv){
 const options={};
 for(let i=0;i<argv.length;i++){
  const key=argv[i];
  if(key==='--help')return {help:true};
  if(Object.hasOwn(options,key))throw Error(usage);
  if(booleans.includes(key)){options[key]=true;continue;}
  if(!valued.includes(key)||argv[i+1]===undefined||argv[i+1].startsWith('--'))throw Error(usage);
  options[key]=argv[++i];
 }
 return options;
}
const integer=(value,name)=>{if(!/^[1-9][0-9]*$/.test(value??''))throw Error(`invalid ${name}`);const n=Number(value);if(!Number.isSafeInteger(n))throw Error(`invalid ${name}`);return n;};
const decimal=(value,name)=>{const n=Number(value);if(!/^[0-9]+(\.[0-9]+)?$/.test(value??'')||!Number.isFinite(n)||n<=0)throw Error(`invalid ${name}`);return n;};
async function readJson(path){
 if((await stat(path)).size>maxInput)throw Error('input exceeds 64 MiB');
 const raw=await readFile(path);if(raw.byteLength>maxInput)throw Error('input exceeds 64 MiB');
 return JSON.parse(raw.toString('utf8'));
}
async function writeExclusive(path,body){const handle=await open(path,'wx');try{await handle.writeFile(body,'utf8');}finally{await handle.close();}}

// importProvider is injected so tests never reach the real adapter or its API key.
export async function main(argv,{importProvider=()=>import('../server/reasoner-adapter.js'),stdout=line=>console.log(line)}={}){
 const o=parse(argv);
 if(o.help){stdout(usage);return null;}
 if(!o['--manifest']||!o['--decisions'])throw Error(usage);
 if(o['--execute']&&o['--dry-run'])throw Error('--execute and --dry-run are mutually exclusive');
 const manifest=await readJson(o['--manifest']),decisions=await readJson(o['--decisions']),baseDir=o['--base-dir']??dirname(resolve(o['--decisions']));
 if(!o['--execute']){
  const plan=await planComparison({manifest,decisions,baseDir});
  if(o['--output']){await writeExclusive(o['--output'],`${JSON.stringify(plan,null,2)}\n`);}
  stdout(`Dry run: ${plan.decisions} decisions, ${plan.totals.cells} prompts hashed, ${plan.totals.promptBytes} prompt bytes, no provider called, manifest SHA-256 ${plan.manifestSha256}`);
  return plan;
 }
 if(!o['--external-transfer']||!o['--max-calls']||!o['--budget-usd']||!o['--ledger'])throw Error('--execute requires --external-transfer, --max-calls, --budget-usd and --ledger');
 const maxCalls=integer(o['--max-calls'],'--max-calls'),budgetUsd=decimal(o['--budget-usd'],'--budget-usd'),estimatedCallUsd=o['--estimated-call-usd']===undefined?0.05:decimal(o['--estimated-call-usd'],'--estimated-call-usd'),timeoutMs=o['--timeout-ms']===undefined?60000:integer(o['--timeout-ms'],'--timeout-ms');
 let callProvider,provenance;
 if(o['--provider-module']){
  if(!['synthetic','provider'].includes(o['--provenance']))throw Error('--provider-module requires --provenance synthetic|provider');
  const module=await import(pathToFileURL(resolve(o['--provider-module'])).href);
  if(typeof module.callProvider!=='function')throw Error('provider module must export callProvider(promptInput,{signal,endpoint})');
  callProvider=module.callProvider;provenance=o['--provenance'];
 } else {
  const gaps=adapterGaps(manifest);
  if(gaps.length){const error=Error(`ADAPTER_UNSUPPORTED: the existing reasoner adapter cannot run this manifest: ${gaps.join('; ')}. Supply --provider-module.`);error.code='ADAPTER_UNSUPPORTED';throw error;}
  const {reasonScenarios}=await importProvider();
  callProvider=(promptInput,{signal})=>reasonScenarios({...toReasonerAdapterInput(promptInput),signal});provenance='provider';
 }
 const result=await generateComparison({manifest,decisions,callProvider,ledgerPath:o['--ledger'],baseDir,externalTransfer:true,maxCalls,budgetUsd,estimatedCallUsd,timeoutMs,provenance,rawResponseDir:o['--raw-dir']??null});
 stdout(`Generated ledger ${result.ledgerPath}: ${result.plannedCells} cells, ${result.calls} provider calls, estimated cost ${result.spentUsd.toFixed(4)} USD, tail SHA-256 ${result.tailHash}, provenance ${result.provenance}`);
 return result;
}

const entry=process.argv[1]?resolve(process.argv[1]).toLowerCase():'';
if(entry===resolve(fileURLToPath(import.meta.url)).toLowerCase()){
 main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
