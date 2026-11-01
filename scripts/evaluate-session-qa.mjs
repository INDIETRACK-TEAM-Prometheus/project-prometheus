import {readFile, open} from 'node:fs/promises';
import {createSessionQaReport} from '../src/evaluation/session-qa.js';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!['--pilot', '--accuracy', '--output'].includes(key) || Object.hasOwn(options, key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('use --pilot <summary.json> [--accuracy <report.json>] --output <new-report.json>');
  options[key] = args[++i];
}
if (!options['--pilot'] || !options['--output']) throw new Error('pilot summary and new output path required');

const pilot = JSON.parse(await readFile(options['--pilot'], 'utf8'));
const accuracyReport = options['--accuracy'] ? JSON.parse(await readFile(options['--accuracy'], 'utf8')) : null;
const report = createSessionQaReport({pilot, accuracyReport});
const file = await open(options['--output'], 'wx');
try { await file.writeFile(JSON.stringify(report, null, 2)); }
finally { await file.close(); }
console.log(`Wrote ${options['--output']}`);
