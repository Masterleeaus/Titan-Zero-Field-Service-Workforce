#!/usr/bin/env node
/**
 * Read-only recovery observation of a prior Hatchet staging attempt.
 *
 * An existing .intent means a provider effect MAY already have happened. This
 * command compares that exact intent with Titan's current durable reservation
 * and a provider's proven-complete tenant-specific inventory. It never
 * submits, cancels, retries, marks accepted, or lifts commissioning.
 *
 * Example:
 *   TITAN_AGENT3_STAGING_ENV=isolated-staging node \
 *     integration/scripts/hatchet_staging_reconcile_cli.mjs \
 *     --module /secure/operator-ports.mjs --request /secure/request.json \
 *     --journal /secure/staging.json --output /secure/recovery-review.json
 */
import {parseArgs} from 'node:util';
import {open,readFile,lstat,stat} from 'node:fs/promises';
import {resolve,dirname,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createStagingCrashRecovery} from '../titan-hatchet-staging-recovery.mjs';
const fail=code=>{throw new Error(`agent3-staging-reconcile-cli-${code}`)};
const values=parseArgs({options:{module:{type:'string'},request:{type:'string'},journal:{type:'string'},
  output:{type:'string'},actor:{type:'string'}},strict:true}).values;
if(process.env.TITAN_AGENT3_STAGING_ENV!=='isolated-staging')fail('isolated-env-required');
for(const key of ['module','request','journal','output']){
  if(typeof values[key]!=='string'||!isAbsolute(values[key])||values[key]!==resolve(values[key]))fail(`${key}-path-invalid`);
}
if(typeof values.actor!=='string'||values.actor.length<1||values.actor.length>256)fail('actor-required');
const paths=[values.module,values.request,values.journal,values.output,values.journal+'.intent'];
if(new Set(paths).size!==paths.length)fail('path-alias-denied');
for(const key of ['module','request']){
 const item=await lstat(values[key]);if(!item.isFile()||item.isSymbolicLink()||(item.mode&0o022)!==0)fail('input-file-untrusted');
}
const destination=await lstat(dirname(values.output));
if(!destination.isDirectory()||destination.isSymbolicLink()||(destination.mode&0o022)!==0)fail('output-directory-untrusted');
const source=JSON.parse(await readFile(values.request,'utf8'));
// Always load the operator-supplied, trusted module AFTER validating inputs,
// never allow importing modules from a request field or provider body.
const module=await import(pathToFileURL(values.module).href);
if(typeof module.createPorts!=='function')fail('trusted-ports-unavailable');
const ports=await module.createPorts();
const inspector=createStagingCrashRecovery(ports);
const report=await inspector.inspect({reportPath:values.journal,subject:source,actor_id:values.actor});
if(report.schema!=='titan.agent3.staging-recovery/v1'||report.safe_to_retry!==false||
   report.commissioning_approved!==false||report.business_outcome_verified!==false)fail('invalid-report');
// No rename/overwrite; this is a one-time, read-only observation receipt.
// Credentials are not included in report, and provider exceptions were
// classified in the recovery core rather than serialized.
const out=await open(values.output,'wx',0o600);
try{await out.writeFile(JSON.stringify(report,null,2)+'\n','utf8');await out.sync();}
finally{await out.close();}
const directory=await open(dirname(values.output),'r');
try{await directory.sync();}finally{await directory.close();}
console.log(JSON.stringify({recovery_report:values.output,status:report.provider_finding,
 safe_to_retry:false,commissioning_approved:false,requires_operator_reconciliation:true}));
