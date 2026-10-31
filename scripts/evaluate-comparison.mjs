import {createHash} from 'node:crypto';
import {open,readFile,stat} from 'node:fs/promises';
import {evaluateComparison} from '../src/evaluation/comparison.js';

const usage='Usage: node scripts/evaluate-comparison.mjs --input heldout.json --output report.json [--seed 2026] [--bootstrap-iterations 2000]';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i++){
 const key=args[i];
 if(key==='--help'){console.log(usage);process.exit(0);}
 if(!['--input','--output','--seed','--bootstrap-iterations'].includes(key)||Object.hasOwn(options,key)||!args[i+1]||args[i+1].startsWith('--'))throw Error(usage);
 options[key]=args[++i];
}
if(!options['--input']||!options['--output'])throw Error(usage);
const integer=(value,fallback,min,max)=>{
 if(value===undefined)return fallback;
 if(!/^(0|[1-9][0-9]*)$/.test(value))throw Error('invalid numeric option');
 const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<min||parsed>max)throw Error('invalid numeric option');return parsed;
};
const seed=integer(options['--seed'],2026,0,0xffffffff),bootstrapIterations=integer(options['--bootstrap-iterations'],2000,200,20000);
const size=(await stat(options['--input'])).size;if(size>64*1024*1024)throw Error('input exceeds 64 MiB');
const raw=await readFile(options['--input']);
if(raw.byteLength>64*1024*1024)throw Error('input exceeds 64 MiB');
const dataset=JSON.parse(raw.toString('utf8'));
const sourceSha256=createHash('sha256').update(raw).digest('hex');
const report=evaluateComparison(dataset,{seed,bootstrapIterations,sourceSha256});
const output=await open(options['--output'],'wx');
try {await output.writeFile(`${JSON.stringify(report,null,2)}\n`,'utf8');}
finally {await output.close();}
console.log(`Wrote offline comparison report: ${report.heldoutSessionCount} held-out sessions, ${report.decisionCount} paired decisions, source SHA-256 ${sourceSha256}`);
