import test from 'node:test';
import assert from 'node:assert/strict';
import {agent3HostedErrorResponse} from './titan-hosted-error-response.mjs';
test('uncertain effect returns recovery-required response, never an auto-retry hint',()=>{
  const x=agent3HostedErrorResponse(new Error('agent3-hosted-outcome-uncertain'));
  assert.equal(x.status,503);assert.deepEqual(x.body,{error:'conversation-outcome-uncertain',retryable:false,reconciliation_required:true});
  assert.equal(Object.isFrozen(x.body),true);
});
test('company placement denial does not disclose internal registry detail',()=>{
  for(const code of ['agent3-hosted-operation-denied','agent3-hosted-placement-denied','agent3-hosted-schema-denied','agent3-hosted-commissioning-denied']){
    const x=agent3HostedErrorResponse(new Error(code,{cause:new Error('secret-path:/company-PRIVATE/password')}));
    assert.equal(x.status,503);assert.deepEqual(x.body,{error:'conversation-execution-unavailable',retryable:false});
    assert.doesNotMatch(JSON.stringify(x),/secret-path|password|PRIVATE/);
  }
});
test('unrecognised native errors remain owned by existing safe native protocol',()=>{
  for(const value of [new Error('native-execution'),new Error('agent3-super-secret'),null,undefined,'agent3-hosted-outcome-uncertain'])
    assert.equal(agent3HostedErrorResponse(value),null);
});
test('error response objects are immutable',()=>{
  const x=agent3HostedErrorResponse(new Error('agent3-hosted-outcome-uncertain'));
  assert.equal(Object.isFrozen(x),true);assert.equal(Object.isFrozen(x.body),true);
});
