import {open,readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateComparisonV2} from '../src/evaluation/comparison-v2.js';
import {sha256Hex} from '../src/evaluation/manifest.js';

const usage='Usage: node scripts/evaluate-comparison-v2.mjs --manifest manifest.json --ledger ledger.jsonl --annotations annotations.json --output report.json [--expect-manifest-sha256 hex]';
const valued=['--manifest','--ledger','--annotations','--output','--expect-manifest-sha256'];
const maxInput=64*1024*1024;

async function readBytes(path){
 if((await stat(path)).size>maxInput)throw Error('input exceeds 64 MiB');
 const raw=await readFile(path);if(raw.byteLength>maxInput)throw Error('input exceeds 64 MiB');return raw;
}

export async function main(argv,{stdout=line=>console.log(line)}={}){
 const o={};
 for(let i=0;i<argv.length;i++){
  const key=argv[i];
  if(key==='--help'){stdout(usage);return null;}
  if(!valued.includes(key)||Object.hasOwn(o,key)||argv[i+1]===undefined||argv[i+1].startsWith('--'))throw Error(usage);
  o[key]=argv[++i];
 }
 if(!o['--manifest']||!o['--ledger']||!o['--annotations']||!o['--output'])throw Error(usage);
 const manifestRaw=await readBytes(o['--manifest']),ledgerRaw=await readBytes(o['--ledger']),annotationsRaw=await readBytes(o['--annotations']);
 const sourceSha256s={manifestFile:sha256Hex(manifestRaw),ledgerFile:sha256Hex(ledgerRaw),annotationsFile:sha256Hex(annotationsRaw)};
 const report=evaluateComparisonV2({manifest:JSON.parse(manifestRaw.toString('utf8')),ledgerText:ledgerRaw.toString('utf8'),annotations:JSON.parse(annotationsRaw.toString('utf8'))},{sourceSha256s});
 if(o['--expect-manifest-sha256']!==undefined&&o['--expect-manifest-sha256']!==report.manifestSha256){const error=Error('MANIFEST_HASH_MISMATCH: manifest differs from the externally expected hash');error.code='MANIFEST_HASH_MISMATCH';throw error;}
 const handle=await open(o['--output'],'wx');
 try{await handle.writeFile(`${JSON.stringify(report,null,2)}\n`,'utf8');}finally{await handle.close();}
 stdout(`Wrote offline v2 report: ${report.sessionCount} sessions, ${report.decisionCount} decisions, verdict ${report.verdict.status}, data provenance ${report.dataProvenance}, manifest SHA-256 ${report.manifestSha256}`);
 return report;
}

const entry=process.argv[1]?resolve(process.argv[1]).toLowerCase():'';
if(entry===resolve(fileURLToPath(import.meta.url)).toLowerCase()){
 main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
