// @ts-nocheck
import { RuntimeEventBus, TitanAgentRuntime } from "../../../packages/runtime/agent-runtime/index.mjs";
import { SqliteRunStore } from "../../../packages/runtime/agent-runtime/sqlite-run-store.mjs";
import { AuthorityContextResolver, CapabilityRequirementResolver, RuntimeAuthorityGateway, SqliteAuthorityStore, SqliteWorkerAccessStore, WorkerAccessResolver } from "../../../packages/runtime/authority/index.mjs";
import { WorkforceService } from "./index.js";
import { WorkforceRuntimeAdapter } from "./runtime-adapter.js";
import { SqliteWorkforceStore } from "./sqlite-store.js";
import { ZeroWorkforceRuntimeDispatcher } from "./zero-runtime-dispatcher.js";
// Agent 3 transport integrations only; canonical work and evidence remain Titan-owned.
import { createCanonicalAgent3Commissioning } from "./agent3/titan-hatchet-commissioning.mjs";

const requiredMethod=(owner,name,label)=>{if(!owner||typeof owner[name]!=="function")throw new Error(`production-runtime-port-required:${label}.${name}`);};

function buildAuthorityGateway(storage,ports){
  if(ports?.authorityGateway){
    requiredMethod(ports.authorityGateway,"authorize","authorityGateway");
    requiredMethod(ports.authorityGateway,"execute","authorityGateway");
    return {authorityGateway:ports.authorityGateway,authorityStore:null,authorityContextResolver:null};
  }

  requiredMethod(ports?.executionGateway,"execute","executionGateway");
  for(const name of ["governanceResolver","evidenceResolver","riskResolver","connectivityResolver"]){
    requiredMethod(ports?.[name],"resolve",name);
  }
  const requirementResolver=ports?.requirementResolver??new CapabilityRequirementResolver({registryProvider:ports?.capabilityRegistryProvider});
  requiredMethod(requirementResolver,"resolve","requirementResolver");

  const authorityStore=new SqliteAuthorityStore(storage);
  const workerAccessStore=new SqliteWorkerAccessStore(storage);
  const accessResolver=ports?.accessResolver??new WorkerAccessResolver({store:workerAccessStore});
  requiredMethod(accessResolver,"resolve","accessResolver");
  const authorityContextResolver=new AuthorityContextResolver({
    authorityStore,
    requirementResolver,
    accessResolver,
    governanceResolver:ports.governanceResolver,
    evidenceResolver:ports.evidenceResolver,
    riskResolver:ports.riskResolver,
    connectivityResolver:ports.connectivityResolver,
  });
  const authorityGateway=new RuntimeAuthorityGateway({
    contextResolver:authorityContextResolver,
    executionGateway:ports.executionGateway,
    authorityStore,
  });
  return {authorityGateway,authorityStore,authorityContextResolver,workerAccessStore,accessResolver,requirementResolver};
}

export async function createProductionRuntimeBootstrap({storage,ports,eventBus}={}){
  if(!storage||typeof storage.query!=="function")throw new Error("production-runtime-storage-required");
  requiredMethod(ports?.modelRouter,"next","modelRouter");
  requiredMethod(ports?.capabilities,"resolve","capabilities");
  requiredMethod(ports?.contextProvider,"load","contextProvider");

  const authority=buildAuthorityGateway(storage,ports);

  const runStore=new SqliteRunStore(storage);
  const workforceStore=new SqliteWorkforceStore(storage);
  await runStore.migrate();
  await workforceStore.migrate();

  const events=eventBus??new RuntimeEventBus();
  const runtime=new TitanAgentRuntime({
    store:runStore,
    modelRouter:ports.modelRouter,
    capabilities:ports.capabilities,
    authorityGateway:authority.authorityGateway,
    contextProvider:ports.contextProvider,
    eventBus:events,
  });
  const runtimeAdapter=new WorkforceRuntimeAdapter(runtime);
  let workforceRuntime=runtimeAdapter;
  let zeroExecutionRuntime=runtime;
  let agent3=null;
  if(ports?.agent3Commissioning){
    // All required service owners come from trusted host configuration, never
    // a caller, worker or website parameter. Partial cutover fails closed.
    agent3=createCanonicalAgent3Commissioning({
      ...ports.agent3Commissioning,
      workforceStore,workerStore:workforceStore,
      nativeRuntime:runtimeAdapter,
      nativeRunLookup:({company_id,work_id})=>runStore.findByWork(company_id,work_id),
      zeroNativeRuntime:runtime,
      canonicalRunById:({company_id,run_id})=>runStore.get(company_id,run_id),
      strictCommissioning:true,
    });
    // Migration is deliberately NOT implicit here; the authorized company
    // provisioning owner calls agent3.migrate(company_id) BEFORE work ingress.
    workforceRuntime=agent3.runtime;
    zeroExecutionRuntime=agent3.zeroRuntime;
  }
  const workforce=new WorkforceService(workforceStore,workforceRuntime,undefined,workforceStore);

  // One canonical Zero -> Workforce -> persistent-runtime bridge. Keep dispatch as
  // a compatibility alias so existing composition roots do not gain a second path.
  const zeroDispatcher=new ZeroWorkforceRuntimeDispatcher(
    workforce,
    workforceStore,
    workforceStore,
    zeroExecutionRuntime,
    (fn) => storage.transaction(async (tx) => {
      const store = new SqliteWorkforceStore(tx);
      // Lifecycle preparation must not auto-wake a second runtime.
      return fn(new WorkforceService(store, undefined, undefined, store), store);
    }),
  );
  const dispatch=(input)=>zeroDispatcher.dispatch(input);

  return Object.freeze({
    storage,runStore,workforceStore,runtime:zeroExecutionRuntime,events,workforce,zeroDispatcher,dispatch,
    agent3,
    authorityGateway:authority.authorityGateway,
    authorityStore:authority.authorityStore,
    authorityContextResolver:authority.authorityContextResolver,
    workerAccessStore:authority.workerAccessStore??null,
    accessResolver:authority.accessResolver??null,
    requirementResolver:authority.requirementResolver??null,
  });
}
