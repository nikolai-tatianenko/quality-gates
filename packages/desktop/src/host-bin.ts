import { runHost } from './host-main.js';

runHost({ input: process.stdin, write: line => process.stdout.write(`${line}\n`), args: process.argv.slice(2) })
  .catch(error => { process.stderr.write(`QualityGate desktop host: ${error instanceof Error ? error.message : error}\n`); process.exitCode = 2; });
