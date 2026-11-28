#!/usr/bin/env node
/**
 * Deliberate, operator-only Hatchet staging command. No server start, no
 * environment-derived credentials, no implicit live submission or retry.
 *
 * Example:
 * TITAN_AGENT3_STAGING_ENV=isolated-staging node \
 *   integration/scripts/hatchet_live_staging_cli.mjs \
 *   --module /secure/titan/staging-ports.mjs --request /secure/titan/request.json \
 *   --mode inspect --report /secure/titan/inspection.json
 *
 * The module exports createPorts() returning the **already connected** Titan
 * durable store, vault-backed SDK transport, current-authority verifier and
 * independent registered-staging-deployment attestor. It must be operator
 * controlled, not an uploaded request or a public URL.
 */
import {parseArgs} from 'node:util';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHatchetStagingJournal} from '../titan-hatchet-staging-journal.mjs';
import {createHatchetLiveStagingAcceptance} from '../titan-hatchet-staging-acceptance.mjs';
const exit=code=>{throw new Error(`agent3-staging-cli-${code}`)};
const parsed=parseArgs({options:{module:{type:'string'},request:{type:'string'},mode:{type:'string'},report:{type:'string'},'approve-disposable-workflow':{type:'boolean',default:false}},strict:true});
const argv=parsed.values;
const mode=argv.mode;
if(process.env.TITAN_AGENT3_STAGING_ENV!=='isolated-staging')exit('isolated-env-required');
if(!['inspect','execute'].includes(mode))exit('mode-invalid');
if(mode==='execute'&&!argv['approve-disposable-workflow'])exit('explicit-execution-approval-required');
for(const key of ['module','request','report'])if(typeof argv[key]!=='string'||!isAbsolute(argv[key]))exit(`${key}-absolute-path-required`);
if(new Set([argv.module,argv.request,argv.report]).size!==3)exit('path-alias-denied');
for(const key of ['module','request']){const st=await lstat(argv[key]);if(!st.isFile()||st.isSymbolicLink())exit(`${key}-file-invalid`);}
// Modules must be operator-owned and export trusted ports; arbitrary remote
// URLs, untrusted job payloads and command evaluation are never supported.
// The exclusive, fsynced intent MUST exist before loading any trusted ports
// or potentially sending a remote Hatchet workflow. A crash leaves a durable
// reconciliation-only marker and a second invocation cannot reuse the report.
const data=JSON.parse(await readFile(argv.request,'utf8'));
const journal=createHatchetStagingJournal({reportPath:argv.report,mode,subject:data});
await journal.begin();
const operator=await import(pathToFileURL(resolve(argv.module)).href);
if(typeof operator.createPorts!=='function')exit('operator-ports-unavailable');
const ports=await operator.createPorts();
const stage=createHatchetLiveStagingAcceptance(ports);
let outcome;
try{outcome=mode==='execute'?await stage.executeOnce(data):await stage.inspect(data);}
catch{
  // The intent remains persisted; provider error details are neither logged
  // nor written to disk. Reconcile using canonical Titan/Hatchet evidence.
  exit('attempt-unknown-reconcile-only');
}
if(outcome.schema!=='titan.agent3.live-staging-report/v1')exit('report-contract-invalid');
const committed=await journal.finalize(outcome);
console.log(JSON.stringify({report:committed.reportPath,intent:committed.intentPath,
  status:committed.status,safe_to_retry:false,commissioning_approved:false}));
