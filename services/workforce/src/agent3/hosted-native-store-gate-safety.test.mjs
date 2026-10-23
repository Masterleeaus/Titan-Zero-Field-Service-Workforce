import test from 'node:test';
import assert from 'node:assert/strict';
import {assertHostedNativeGateSafeToCommission,NATIVE_GATE_INCOMPATIBILITY,NATIVE_GATE_AUDIT} from './titan-hosted-native-store-gate-safety.mjs';
const blocked=new RegExp(NATIVE_GATE_INCOMPATIBILITY);

test('existing native-only host remains available without an Agent 3 setting',()=>{
 assert.equal(assertHostedNativeGateSafeToCommission(undefined),undefined);
});
test('fully configured Agent 3 host cannot enter a proven non-reentrant physical gate',()=>{
 assert.throws(()=>assertHostedNativeGateSafeToCommission({schema:'titan.agent3.hosted-commissioning/v1',enabled:true,company_ids:['company-a']}),blocked);
});
test('operator attestations cannot override a known physical double-acquisition',()=>{
 assert.throws(()=>assertHostedNativeGateSafeToCommission({enabled:true,mode:'operator-authorized',attested:true,ready:true,unsafeBypass:true}),blocked);
});
test('disabled but present commissioning configuration does not silently bypass contract review',()=>{
 assert.throws(()=>assertHostedNativeGateSafeToCommission({enabled:false}),blocked);
});
test('null, falsy and malformed configured values fail closed',()=>{
 for(const value of [null,false,0,'',{}])assert.throws(()=>assertHostedNativeGateSafeToCommission(value),blocked);
});
test('audit binds exactly to reviewed canonical Git objects',()=>{
 assert.equal(NATIVE_GATE_AUDIT.native_opener_sha,'80ab3010f151e01c0133db0f13753e7d3369fce4');
 assert.equal(NATIVE_GATE_AUDIT.canonical_gate_sha,'23d347b83ed876527cf6198ff9968b788ec29621');
 assert.equal(NATIVE_GATE_AUDIT.native_work_orders_sha,'268a2bb65c808461cac0e81851c8ac60698c54a5');
 assert.equal(NATIVE_GATE_AUDIT.status,'commissioning-blocked');
 assert.equal(Object.isFrozen(NATIVE_GATE_AUDIT),true);
});
