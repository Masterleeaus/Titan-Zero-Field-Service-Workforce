import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeAuthorityGateway } from "./runtime-authority-gateway.mjs";

const canonical=(decision="ALLOW",company_id="co-1",overrides={})=>({
  company_id,authority_decision_id:"auth-1",worker_id:"worker-1",capability:"booking.create",
  actor_id:"actor-1",worker_type:"human",surface:"directadmin",
  operation_id:"run-1",action_id:"run-1",decision,evaluated_at:"2026-10-02T00:00:00.000Z",
  evaluated_risk:{level:"medium",source:"risk-engine",ref:"risk-1"},
  ...overrides,
});

test("only canonical ALLOW becomes runtime approved",async()=>{
 const gateway=new RuntimeAuthorityGateway({
  contextResolver:{async evaluate(){return canonical("ALLOW");}},
  executionGateway:{async execute(){throw new Error("unused");}},
 });
 const decision=await gateway.authorize({company_id:"co-1",agent_id:"worker-1",capability:"booking.create",run_id:"run-1"});
 assert.equal(decision.status,"approved");
 assert.equal(decision.canonical.decision,"ALLOW");
});

test("approval requirement is preserved and other outcomes deny",async()=>{
 for(const [value,status] of [["APPROVAL_REQUIRED","approval_required"],["DENY","denied"],["EVIDENCE_REQUIRED","denied"],["AUTHORITY_UNAVAILABLE","denied"]]){
  const gateway=new RuntimeAuthorityGateway({contextResolver:{async evaluate(){return canonical(value);}},executionGateway:{async execute(){}}});
  assert.equal((await gateway.authorize({company_id:"co-1",agent_id:"worker-1",capability:"booking.create",run_id:"run-1"})).status,status);
 }
});

test("execution revalidates current authority and carries the superseding decision",async()=>{
 let request;
 let evaluationInput;
 const gateway=new RuntimeAuthorityGateway({
  contextResolver:{async evaluate(value){
    evaluationInput=value;
    return canonical("ALLOW","co-1",{
      authority_decision_id:value.authority_decision_id??"auth-current",
      supersedes_authority_decision_id:value.supersedes_authority_decision_id??null,
      evaluated_at:value.now??"2026-10-02T00:00:01.000Z",
    });
  }},
  executionGateway:{async execute(value){request=value;return {state:"VERIFIED",verified:true};}},
 });
 const decision={status:"approved",decision_id:"auth-1",canonical:canonical()};
 await gateway.execute({decision,capability:{name:"booking.create"},input:{amount:25},idempotency_key:"tool-1",company_id:"co-1",actor_id:"actor-1",correlation_id:"correlation-1",work_id:"work-1",agent_id:"worker-1",run_id:"run-1"});
 assert.equal(evaluationInput.company_id,"co-1");
 assert.equal(evaluationInput.actor_id,"actor-1");
 assert.equal(evaluationInput.worker_type,"human");
 assert.equal(evaluationInput.surface,"directadmin");
 assert.equal(evaluationInput.agent_id,"worker-1");
 assert.equal(evaluationInput.supersedes_authority_decision_id,"auth-1");
 assert.equal(evaluationInput.execution_input.amount,25);
 assert.equal(request.company_id,"co-1");
 assert.equal(request.actor_id,"actor-1");
 assert.equal(request.correlation_id,"correlation-1");
 assert.match(request.decision_id,/^authority:run-1:tool-1:execute:/);
 assert.equal(request.supersedes_decision_id,"auth-1");
 assert.equal(request.authority.revalidated,true);
 assert.equal(request.risk.level,"medium");
 assert.equal(request.risk.source,"risk-engine");
 await assert.rejects(()=>gateway.execute({decision,capability:{name:"booking.create"},input:{amount:25},idempotency_key:"tool-actor-mismatch",company_id:"co-1",actor_id:"untrusted-caller",correlation_id:"correlation-1",work_id:"work-1",agent_id:"worker-1",run_id:"run-1"}),/runtime-actor-mismatch/);
 await assert.rejects(()=>gateway.execute({decision,capability:{name:"booking.create"},input:{},idempotency_key:"tool-2",company_id:"co-2",work_id:"work-1",agent_id:"worker-1",run_id:"run-1"}),/company-mismatch/);
});

test("runless human operations remain bound to their canonical operation and idempotency identifiers",async()=>{
 let request;
 const gateway=new RuntimeAuthorityGateway({
  contextResolver:{async evaluate(value){return canonical("ALLOW","co-1",{
    authority_decision_id:value.authority_decision_id??"auth-human",
    capability:"titan.workforce.reassign",
    worker_id:value.agent_id,
    operation_id:value.operation_id,
    action_id:value.action_id,
    worker_type:value.worker_type,
    surface:value.surface,
    supersedes_authority_decision_id:value.supersedes_authority_decision_id??null,
    evaluated_at:value.now??"2026-10-02T00:00:01.000Z",
  });}},
  executionGateway:{async execute(value){request=value;return {state:"VERIFIED"};}},
 });
 const decision=await gateway.authorize({
  company_id:"co-1",agent_id:"human-worker-1",worker_type:"human",surface:"directadmin",
  capability:"titan.workforce.reassign",operation_id:"operation-human-1",action_id:"operation-human-1",
  idempotency_key:"operation-human-1",
 });
 assert.equal(decision.canonical.operation_id,"operation-human-1");
 await gateway.execute({decision,capability:{name:"titan.workforce.reassign"},input:{work_id:"work-1"},
  idempotency_key:"titan.workforce.reassign:operation-human-1",company_id:"co-1",work_id:"work-1",agent_id:"human-worker-1"});
 assert.equal(request.execution_id,"execution:co-1:operation-human-1:titan.workforce.reassign:operation-human-1");
 assert.equal(request.run_id,undefined);
});

test("caller cancellation reaches the canonical execution gateway",async()=>{
 const controller=new AbortController();
 let request;
 const gateway=new RuntimeAuthorityGateway({
  contextResolver:{async evaluate(value){return canonical("ALLOW","co-1",{
    authority_decision_id:value.authority_decision_id??"auth-cancel",
    supersedes_authority_decision_id:value.supersedes_authority_decision_id??null,
    evaluated_at:value.now??"2026-10-02T00:00:01.000Z",
  });}},
  executionGateway:{async execute(value){request=value;return {state:"VERIFIED"};}},
 });
 const decision={status:"approved",decision_id:"auth-1",canonical:canonical()};
 await gateway.execute({decision,capability:{name:"booking.create"},input:{},idempotency_key:"cancel-1",
  company_id:"co-1",agent_id:"worker-1",run_id:"run-1",signal:controller.signal});
 assert.equal(request.signal,controller.signal);
});

test("revocation or downgrade after authorization blocks execution before provider call",async()=>{
 for(const currentDecision of ["DENY","APPROVAL_REQUIRED","AUTHORITY_UNAVAILABLE","ESCALATE"]){
  let providerCalls=0;
  let evaluations=0;
  const gateway=new RuntimeAuthorityGateway({
   contextResolver:{async evaluate(value){
    evaluations++;
    return canonical(currentDecision,"co-1",{
      authority_decision_id:value.authority_decision_id??`current-${currentDecision}`,
      supersedes_authority_decision_id:value.supersedes_authority_decision_id??null,
      evaluated_at:value.now??"2026-10-02T00:00:01.000Z",
    });
   }},
   executionGateway:{async execute(){providerCalls++;return {state:"VERIFIED"};}},
  });
  const planned={status:"approved",decision_id:"auth-1",canonical:canonical("ALLOW")};
  await assert.rejects(
    ()=>gateway.execute({decision:planned,capability:{name:"booking.create"},input:{},idempotency_key:`tool-${currentDecision}`,company_id:"co-1",work_id:"work-1",agent_id:"worker-1",run_id:"run-1"}),
    /authority-not-allowed/,
  );
  assert.equal(evaluations,1);
  assert.equal(providerCalls,0);
 }
});

test("current authority decision is persisted as a superseding decision before execution",async()=>{
 const appended=[];
 const gateway=new RuntimeAuthorityGateway({
  contextResolver:{async evaluate(value){return canonical("ALLOW","co-1",{
    authority_decision_id:value.authority_decision_id,
    supersedes_authority_decision_id:value.supersedes_authority_decision_id,
    evaluated_at:value.now,
  });}},
  authorityStore:{async appendDecision(value){appended.push(value);}},
  executionGateway:{async execute(){return {state:"VERIFIED"};}},
 });
 const planned={status:"approved",decision_id:"auth-1",canonical:canonical("ALLOW")};
 await gateway.execute({decision:planned,capability:{name:"booking.create"},input:{},idempotency_key:"tool-persist",company_id:"co-1",work_id:"work-1",agent_id:"worker-1",run_id:"run-1"});
 assert.equal(appended.length,1);
 assert.match(appended[0].authority_decision_id,/^authority:run-1:tool-persist:execute:/);
 assert.equal(appended[0].supersedes_authority_decision_id,"auth-1");
});
