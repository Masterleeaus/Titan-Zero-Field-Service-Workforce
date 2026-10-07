const ZERO_SITE='https://titanzero.io';
const CORE_SITE='https://core.titanzero.io';
const BUILD_SITE='https://build.titanzero.io';
const DESK_SITE='https://desk.titanzero.io';
const FIELD_SITE='https://field.titanzero.io';
const PAY_SITE='https://pay.titanzero.io';
const SIGNUP='/contact#availability';
const LOGIN='/contact#availability';
const JOIN=SIGNUP;

const trades=[
 ['🛠️','Handyman & Property Maintenance','Multi-skill jobs, recurring maintenance, repairs and small projects'],
 ['🪚','Carpentry & Joinery','Site measures, materials, staged work and installation evidence'],
 ['🎨','Painting & Decorating','Room/area scopes, colour notes, prep stages, photos and handover'],
 ['🧱','Plastering & Repairs','Defect capture, patch/repair scopes, drying stages and completion'],
 ['🔲','Tiling & Surface Work','Measurements, materials, preparation, installation and sign-off'],
 ['🚿','Pressure & Exterior Cleaning','Quotes, site access, equipment, evidence and recurring work'],
 ['🏡','Rental & Strata Maintenance','Property history, approvals, tenants, owners and work orders'],
 ['🔧','Equipment & Appliance Repair','Asset history, fault notes, parts, approvals and return visits']
];

const features=[
 ['Lead → job intake','Capture enquiry, property, problem, photos, urgency and preferred timing in one record.'],
 ['Site visit & estimate','Schedule inspections and turn measurements, notes and images into a scoped estimate.'],
 ['Quote + approval','Send itemised labour/material scopes, optional items and clear approval status.'],
 ['Job scheduling','Assign the right worker, reserve time, add access notes and coordinate arrival communication.'],
 ['Materials & purchasing','Track required materials, receipts, supplier runs and chargeable items against the job.'],
 ['Variations','Document scope changes, price/time impact and customer approval before extra work proceeds.'],
 ['Field workflow','Arrive, start, pause, add notes, complete tasks and keep the office view current.'],
 ['Before / during / after evidence','Attach photos, notes, measurements and completion evidence to the work order.'],
 ['Multi-stage jobs','Split larger work into inspection, prep, repair, return visit and final handover stages.'],
 ['Customer communication','Automate confirmations, ETA/delay updates, approval requests and completion messages.'],
 ['Invoice & payment handoff','Turn approved work, time, materials and variations into accurate billing context.'],
 ['Maintenance follow-up','Create reminders, recurring inspections and proactive rebooking from completed work.']
];





const FIELD_SPECIALISTS=[
 'Scheduling Specialist','Dispatch Specialist','Routing Specialist','Capacity Specialist','Workforce Specialist',
 'Job Specialist','Field Support Specialist','Quality Specialist','Evidence Specialist','Safety Specialist',
 'Materials Specialist','Inventory Specialist','Equipment Specialist','Maintenance Specialist','Supply Specialist',
 'Standards Specialist','Compliance Specialist','Training Specialist','Audit Specialist','Continuous Improvement Specialist',
 'Operations Analytics Specialist','Predictive Operations Specialist'
];

const FIELD_WORKERS=[
 'Scheduling Worker','Dispatch Worker','Route Worker','Assignment Worker','Gap-Fill Worker','Access Worker',
 'Weather Recovery Worker','Checklist Worker','Evidence Worker','Visual Review Worker','Quality Worker',
 'Variation Worker','Materials Worker','Inventory Worker','Equipment Worker','Maintenance Worker',
 'Supplier Order Worker','Safety Worker','Training Worker','Audit Worker','Service Report Worker','Notification Worker'
];

function nav(active=''){
 const current=x=>active===x?' aria-current="page" class="active"':'';
 return `<a class="skip-link" href="#main">Skip to content</a><nav class="nav" aria-label="Primary"><div class="wrap navin">
  <a class="brand field-brand field-brand-image" data-link href="/" aria-label="Titan Zero Field home"><img src="/assets/field-logo-wide.webp" alt="Titan Zero Field — Run the Work"></a>
  <div id="navlinks" class="navlinks">
   <a data-link${current('home')} href="/">Home</a>
   <a data-link${current('features')} href="/features">Features</a>
   <a data-link${current('workforce')} href="/workforce">Workforce</a>
   <a data-link${current('go')} href="/titan-go">Titan Go</a>
   <a data-link${current('trades')} href="/trades">Trades</a>
   <a data-link${current('pricing')} href="/pricing">Pricing</a>
   <a data-link${current('contact')} href="/contact">Contact</a>
   <div class="nav-actions">
    <a class="btn nav-join" href="${SIGNUP}">Access details</a>
    <a class="btn primary nav-login" href="${LOGIN}">Access status</a>
   </div>
  </div>
  <button class="mobile" id="menu" aria-label="Open menu" aria-controls="navlinks" aria-expanded="false">☰</button>
 </div></nav>`;
}

function footer(){return `${footerVisual()}<footer class="footer mega-footer"><div class="wrap footer-grid">
 <div class="footer-brand">
  <b>Titan Zero Field</b>
  <p>Run the work: jobs, scheduling, dispatch, field workforce, evidence, quality, Standards and operational intelligence.</p>
  <div class="footer-actions"><a class="btn primary" href="${SIGNUP}">Access details</a><a class="btn" href="${LOGIN}">Login</a></div>
 </div>
 <div>
  <h4>Product</h4>
  <a data-link href="/features">Features</a>
  <a data-link href="/workforce">Workforce</a>
  <a data-link href="/titan-go">Titan Go</a>
  <a data-link href="/standards">Titan Standards</a>
  <a data-link href="/trades">Trades</a>
  <a data-link href="/pricing">Pricing</a>
 </div>
 <div>
  <h4>Resources</h4>
  <a data-link href="/why-field">Why Field</a>
  <a data-link href="/about">About Field</a>
  <a data-link href="/onboarding">Onboarding</a>
  <a data-link href="/integrations">Integrations</a>
  <a data-link href="/security">Control & Recovery</a>
  <a data-link href="/faq">FAQ</a>
  <a data-link href="/contact">Contact</a>
 </div>
 <div>
  <h4>Titan Zero</h4>
  <a data-link href="/suite">Suite Overview</a>
  <a href="${BUILD_SITE}">Build ↗</a>
  <a href="${DESK_SITE}">Desk ↗</a>
  <a href="${FIELD_SITE}">Field ↗</a>
  <a href="${PAY_SITE}">Pay ↗</a>
  <a data-link href="/sovereign">Sovereign</a>
 </div>
 </div>
 <div class="wrap footer-bottom"><span>© Titan Zero Field</span><span>Manager → Specialist → Worker</span><span>Titan Go + Standards included with Field</span></div>
</footer>`}

function card(a,b,c,d=[]){
 let icon='',title='',desc='',tags=[];
 if(c===undefined){
   title=a??''; desc=b??'';
 }else{
   icon=a??''; title=b??''; desc=c??''; tags=Array.isArray(d)?d:[];
 }
 return `<article class="card">${icon?`<div class="icon">${icon}</div>`:''}<h3>${title}</h3>${desc?`<p>${desc}</p>`:''}${tags.length?`<div class="tags">${tags.map(x=>`<span class="tag">${x}</span>`).join('')}</div>`:''}</article>`;
}
function splitHero(kicker,title,copy,image,alt,actions=''){
 return `<section class="hero split-hero"><div class="wrap split-hero-grid"><div class="split-hero-copy"><div class="eyebrow">${kicker}</div><h1>${title}</h1><p class="lead">${copy}</p>${actions}</div><div class="split-hero-media"><img src="${image}" alt="${alt}" loading="eager" decoding="async"></div></div></section>`;
}

function openFeatureRow(items){
 return `<div class="open-feature-grid">${items.map((x,i)=>`<div class="open-feature"><span class="open-num">${String(i+1).padStart(2,'0')}</span><div><h3>${x[0]}</h3><p>${x[1]}</p></div></div>`).join('')}</div>`;
}
function tradePage(){
 const verticals=[
 ['handyman-property-maintenance','🛠️','Handyman & Property Maintenance','Multi-skill repairs, installations, recurring maintenance','Variable scope • recurring work'],
 ['carpentry-joinery','🪚','Carpentry & Joinery','Site measures, materials, staged work and installation','Measures • materials • stages'],
 ['painting-decorating','🎨','Painting & Decorating','Areas, preparation, products, colours and handover','Prep • coats • handover'],
 ['plastering-repairs','🧱','Plastering & Repairs','Defect evidence, repair stages, drying and return visits','Defects • drying • returns'],
 ['tiling-surface-work','🔲','Tiling & Surface Work','Measurements, substrate preparation and installation','Substrate • materials • sign-off'],
 ['pressure-exterior-cleaning','🚿','Pressure & Exterior Cleaning','Surface, access, equipment and before/after proof','Access • equipment • evidence'],
 ['rental-strata-maintenance','🏡','Rental & Strata Maintenance','Properties, stakeholders, approvals and access','Approvals • access • reporting'],
 ['equipment-appliance-repair','🔧','Equipment & Appliance Repair','Asset history, diagnosis, parts and return visits','Assets • parts • service history']
 ];
 return `${nav('trades')}<main id="main">
 <section class="hero compact"><div class="wrap"><div class="eyebrow">FIELD VERTICALS</div><h1>One operating system.<br><span>Different work deserves different context.</span></h1><p class="lead">The Field foundation stays consistent while the job model, evidence, readiness and workflow adapt to the trade.</p></div></section>
 ${pageArt("/assets/page-trades-v30.webp","Titan Zero Field trade workflows")}


 <section class="section"><div class="wrap"><div class="trade-mosaic">${verticals.map((v,i)=>`<a data-link href="/trades/${v[0]}" class="${i===0||i===6?'wide':''}"><span class="trade-icon">${v[1]}</span><div><h3>${v[2]}</h3><p>${v[3]}</p><small>${v[4]}</small></div><b>Explore →</b></a>`).join('')}</div></div></section>

 <section class="section alt"><div class="wrap"><div class="eyebrow">SHARED FIELD ENGINE</div><h2>Every vertical still uses the same operational backbone.</h2>
 <div class="capability-ribbon">${['Work orders','Scheduling','Dispatch','Titan Go','Offline','Time','Materials','Variations','Evidence','Quality','Assets','Standards'].map(x=>`<span>${x}</span>`).join('')}</div></div></section>

 <section class="section faded-bg map-bg"><div class="wrap overlay-content narrow"><div class="eyebrow">VERTICAL CONTEXT</div><h2>The difference is not a colour theme — it is what the job needs to succeed.</h2><p class="lead">A repair job, staged painting job, property maintenance visit and equipment service call all require different readiness checks, evidence and return logic. Field keeps those differences explicit.</p></div></section>

 ${ctaBlock('Choose the trade. Keep the Field operating model.','The vertical changes the work context; Titan Zero Field remains the delivery system underneath.')}
 </main>${footer()}`;
}

function onboarding(){
 const steps=[
  ['01','Map the work','Services, job types, recurring work, sites, scopes and operating flow.'],
  ['02','Map the people','Roles, skills, qualifications, availability and escalation ownership.'],
  ['03','Set scheduling rules','Hours, service area, travel, capacity, assignment and conflicts.'],
  ['04','Configure Titan Go','Field actions, instructions, checklists, evidence, incidents and offline behaviour.'],
  ['05','Model readiness','Materials, inventory, equipment, custody and maintenance.'],
  ['06','Load Standards','SOPs, quality, safety, compliance, competency and evidence gates.'],
  ['07','Set authority','Observe, Recommend, Prepare and Execute per capability.'],
  ['08','Define handoffs','What arrives from Desk and what verified completion sends to Pay.'],
  ['09','Launch & tune','Review real exceptions before expanding autonomy.']
 ];
 return `${nav('')}<main id="main">
 <section class="hero compact"><div class="wrap"><div class="eyebrow">FIELD ONBOARDING</div><h1>Configure the delivery system around<br><span>how your business really works.</span></h1><p class="lead">Onboarding is operational modelling, not just filling out settings.</p></div></section>
 ${pageArt("/assets/page-onboarding-v30.webp","Titan Zero Field plan to proof workflow")}


 <section class="section"><div class="wrap"><div class="eyebrow">IMPLEMENTATION PATH</div><div class="onboarding-timeline">${steps.map(x=>`<div><span>${x[0]}</span><h3>${x[1]}</h3><p>${x[2]}</p></div>`).join('')}</div></div></section>

 <section class="section alt"><div class="wrap split-editorial"><div><div class="eyebrow">LAUNCH READINESS</div><h2>Know why the operation is ready — or not.</h2><p class="lead">The same readiness thinking used for jobs should apply to the rollout itself.</p></div><div>${checkList([
  ['Workers mapped','Roles, skills, qualifications and availability are current.'],
  ['Work model mapped','Services, job types, stages and recurring work are understood.'],
  ['Field kit ready','Titan Go actions, checklists and offline behaviour are configured.'],
  ['Standards loaded','SOPs, quality, safety and evidence gates are usable.'],
  ['Authority explicit','Every action has a clear boundary or escalation path.'],
  ['Handoffs tested','Desk → Field and Field → Pay context arrives cleanly.']
 ])}</div></div></section>

 ${ctaBlock('Deploy Field progressively.','Start with clean operational context and bounded authority, then expand automation from real evidence.')}
 </main>${footer()}`;
}

function faq(){
 const qs=[
  ['What exactly is Titan Zero Field?','Field is the operational delivery app in the Titan Zero suite. It owns jobs, work orders, scheduling, dispatch, field execution, evidence, quality, materials, assets, Standards and operational analytics.'],
  ['Are Build, Desk and Pay included in Field?','No. They are sibling Titan Zero apps. Build creates demand, Desk converts and serves customers, Field delivers the work, and Pay invoices and collects. This site sells Field only.'],
  ['Is Titan Go included with Field?','Yes. Titan Go is the field/mobile execution surface for workers and is part of Titan Zero Field.'],
  ['Is Titan Standards really included free?','Yes. Standards is permanently included inside Field: SOPs, work instructions, quality, WHS/OHS, compliance, licences, training, competency, audits, corrective actions and continuous improvement.'],
  ['What do Assist, Suggest, Autonomous and Predictive + Autonomous mean?','Assist helps on request. Suggest watches and recommends. Autonomous executes specific authorised routine actions. Predictive + Autonomous anticipates likely outcomes and can initiate only actions already allowed by capability-specific authority.'],
  ['Does Predictive give Titan more authority?','No. Prediction and authority are separate. A prediction may trigger a recommendation or an already-authorised response, but it never expands permissions by itself.'],
  ['Can Field work offline?','Yes. Field is designed around offline job access, queued actions and evidence, deterministic replay, conflict handling, reconnect revalidation and safe synchronisation.'],
  ['Does Field replace tradespeople?','No. Titan Zero Field coordinates and supports the work. Human field workers still perform physical work and judgement-heavy site decisions; the digital workforce handles bounded operational tasks around them.'],
  ['How is the Field workforce organised?','Operations Manager → Specialists → Workers. The Operations Manager owns delivery outcomes. Specialists own domain decisions such as scheduling, quality or materials. Workers execute bounded tasks.'],
  ['What happens when Field is uncertain?','The safe operating pattern is to preserve context, stop outside authority and escalate to an authorised person rather than guess.'],
  ['Are Maps, model and messaging costs unlimited?','No. The Field subscription covers the platform and workforce capability. Expensive external usage such as mapping, model/API calls or operational messaging above allowances should remain transparent and metered.'],
  ['Which trades does Field support?','The current site covers handyman/property maintenance, carpentry, painting, plastering, tiling, pressure/exterior cleaning, rental/strata maintenance and equipment/appliance repair, with one common Field foundation.']
 ];
 return `${nav('')}<main id="main"><section class="hero compact"><div class="wrap"><div class="eyebrow">FIELD FAQ</div><h1>Questions before you<br><span>deploy Titan Zero Field.</span></h1><p class="lead">Straight answers about Field, Titan Go, Standards, autonomy, offline operation and the wider Titan Zero suite.</p></div></section>
 <section class="section"><div class="wrap faq-list">${qs.map(q=>`<details><summary>${q[0]}</summary><p>${q[1]}</p></details>`).join('')}</div></section>
 ${ctaBlock('Ready to choose a Field autonomy level?','Compare Assist, Suggest, Autonomous and Predictive + Autonomous for Titan Zero Field.')}</main>${footer()}`;
}

function ctaBlock(title,copy){
 return `<section class="section cta"><div class="wrap cta-inner"><div><h2>${title}</h2><p>${copy}</p></div><div class="actions"><a class="btn primary" href="/pricing">View pricing</a><a class="btn ghost" href="${SIGNUP}">Access details</a></div></div></section>`;
}


const verticalDetails={"handyman-property-maintenance": {"icon": "🛠️", "name": "Handyman & Property Maintenance", "focus": "multi-skill repairs, installations, maintenance and punch-list work", "jobs": ["General repairs", "Fixtures & installations", "Doors & hardware", "Rental maintenance", "Preventive maintenance"], "workflow": ["Capture property, issue, photos and access", "Assess remotely or on site", "Scope labour, materials and options", "Schedule the right multi-skill worker", "Track evidence, materials and variations", "Sign off and create future maintenance"]}, "carpentry-joinery": {"icon": "🪚", "name": "Carpentry & Joinery", "focus": "site measures, materials, staged work and installation", "jobs": ["Doors & hardware", "Shelving & storage", "Timber repairs", "Trim & finishing", "Installation work"], "workflow": ["Capture drawings, photos and outcome", "Book and record site measure", "Define materials and finish", "Prepare labour/material scope", "Plan procurement and stages", "Install, evidence and hand over"]}, "painting-decorating": {"icon": "🎨", "name": "Painting & Decorating", "focus": "areas, preparation, products, colours and staged completion", "jobs": ["Interior painting", "Exterior painting", "Rental refresh", "Feature walls", "Patch-and-paint"], "workflow": ["Capture areas and colour intent", "Assess preparation/access", "Estimate surfaces and materials", "Confirm products and exclusions", "Schedule prep/coating stages", "Record touch-ups and sign-off"]}, "plastering-repairs": {"icon": "🧱", "name": "Plastering & Repairs", "focus": "defect evidence, repair stages, drying and return visits", "jobs": ["Wall/ceiling patches", "Crack repairs", "Water damage", "Sheet replacement", "Make-good work"], "workflow": ["Capture defect and likely cause", "Measure affected areas", "Assess repair dependencies", "Quote repair/finishing", "Schedule repair and returns", "Document finish and handover"]}, "tiling-surface-work": {"icon": "🔲", "name": "Tiling & Surface Work", "focus": "measurements, substrate preparation, materials and installation", "jobs": ["Splashbacks", "Floor tiling", "Wall tiling", "Tile repairs", "Regrouting"], "workflow": ["Capture dimensions and tile intent", "Assess substrate/preparation", "Calculate materials/wastage", "Quote preparation/install", "Schedule stages", "Record finish and sign-off"]}, "pressure-exterior-cleaning": {"icon": "🚿", "name": "Pressure & Exterior Cleaning", "focus": "surface, access, equipment, evidence and recurring service", "jobs": ["Driveways & paths", "Building exteriors", "Decks & paving", "Commercial exteriors", "Property refresh"], "workflow": ["Capture surfaces/access/photos", "Assess area/equipment", "Quote scope/exclusions", "Schedule crew/equipment", "Record before/after evidence", "Create repeat-service follow-up"]}, "rental-strata-maintenance": {"icon": "🏡", "name": "Rental & Strata Maintenance", "focus": "property history, stakeholders, approvals and access", "jobs": ["Reactive repairs", "Vacate make-good", "Common areas", "Routine tasks", "Multi-trade punch lists"], "workflow": ["Capture property/occupant/requester", "Determine approval/access path", "Assess and quote", "Coordinate occupant scheduling", "Track evidence/variations", "Report to stakeholders"]}, "equipment-appliance-repair": {"icon": "🔧", "name": "Equipment & Appliance Repair", "focus": "asset history, diagnosis, parts, approvals and return visits", "jobs": ["Diagnostic call-outs", "Equipment servicing", "Parts replacement", "Follow-up repair", "Preventive service"], "workflow": ["Capture asset/model/symptoms", "Review history and triage", "Schedule diagnosis", "Record fault/parts/options", "Approve and coordinate return", "Close with service history"]}};

function workflowDescription(label){
 const s=(label||'').toLowerCase();
 const rules=[
  [/enquiry|capture/,'Capture the customer, property, problem, urgency, photos and preferred timing so the next action starts with usable context.'],
  [/assess|measure|diagnos/,'Record site condition, measurements, access, dependencies and unknowns before committing labour, materials or timing.'],
  [/quote|estimate/,'Turn the approved scope into clear labour, materials, options, exclusions, pricing context and an approval path.'],
  [/approve/,'Keep customer approval, deposits or required authority attached to the scope before work moves forward.'],
  [/schedule/,'Match the work to availability, skills, travel, access requirements and the correct job stage.'],
  [/execute|do the work|repair|install/,'Give the field worker the scope, property context and evidence requirements while progress, time and materials stay connected.'],
  [/change|variation/,'Capture changed scope, reason, price and time impact, then obtain the required approval before additional work proceeds.'],
  [/complete|close|handover/,'Collect completion evidence, outstanding notes and sign-off so the office receives a clean, billing-ready handoff.'],
  [/continue|follow|rebook/,'Move completed work into invoicing, payment follow-up, reviews, maintenance reminders and the next relevant opportunity.'],
  [/launch|tune/,'Begin with bounded authority, review real exceptions and expand workforce autonomy only where the workflow proves reliable.'],
  [/channel/,'Connect approved customer channels while preserving the same customer, job and authority context across conversations.'],
  [/customer journey/,'Define what should happen from first enquiry through booking, work, payment and future service so handoffs remain consistent.'],
  [/digital workforce/,'Assign specialist digital workers and explicitly define what each may observe, recommend, prepare or execute.'],
  [/human workforce/,'Map roles, skills, availability, approvals and escalation ownership so the system knows when a person must take control.'],
  [/business map/,'Configure services, locations, hours, service area, job types, pricing and operating rules around the real business.']
 ];
 const hit=rules.find(r=>r[0].test(s)); return hit?hit[1]:'Keep the scope, customer context, responsibility, evidence and next action connected so the workflow can move without losing information.';
}

const verticalSEO={"handyman-property-maintenance":{"intro":"Handyman and property-maintenance work is unusually variable: one visit may combine repairs, installation, inspection and small-project tasks. Field keeps changing scope tied to the property, worker capability, materials and customer approval instead of treating every visit as the same generic job.","challenges":[["Variable scope on arrival","Photos and initial notes may only reveal part of the work. Field keeps changed scope and approved variations attached to the visit."],["Multi-skill assignment","The right worker may need several practical skills rather than one trade classification. Eligibility and job context stay visible before dispatch."],["Small-material readiness","Fast jobs can still fail because simple parts, fixtures or consumables are missing. Readiness makes those dependencies explicit."]],"track":["Property history","Multi-skill eligibility","Likely materials","Access notes","Variations","Before/after evidence"],"outcomes":[["Fewer wasted visits","Check access, skill fit and likely materials before dispatch."],["Cleaner variations","Capture extra scope and approval while the worker is still on site."],["More recurring work","Keep maintenance history and repeat-service context attached to the property."]],"related":["rental-strata-maintenance","carpentry-joinery","painting-decorating","equipment-appliance-repair"]},"carpentry-joinery":{"intro":"Carpentry and joinery jobs depend on accurate measures, the right material and a clean sequence between site measure, preparation and installation. Field makes those stages explicit so the installation crew is not discovering missing information or material at the point of work.","challenges":[["Measure before commitment","Dimensions, drawings and site conditions need to be captured before labour and material commitments are finalised."],["Material and finish dependency","Timber, hardware, finish and fabrication choices affect both schedule and readiness."],["Staged installation","Measure, preparation, procurement and installation may happen on different visits with different evidence requirements."]],"track":["Site measures","Drawings/photos","Timber & hardware","Finish requirements","Staged visits","Installation evidence"],"outcomes":[["Better first-fit readiness","Confirm measurements and required material before installation."],["Clear stage ownership","Keep each visit tied to the correct work stage and dependency."],["Defensible handover","Preserve installation evidence, notes and finish condition."]],"related":["handyman-property-maintenance","tiling-surface-work","painting-decorating"]},"painting-decorating":{"intro":"Painting work is driven by surface condition, preparation, product choice, colour and drying time. Field separates those stages so preparation issues, extra coats and touch-ups can be handled as real delivery events rather than buried in a single appointment.","challenges":[["Surface condition changes scope","Repairs, sanding, moisture or previous coatings can change the work after inspection."],["Product and colour accuracy","The correct colour, sheen, product and quantity need to reach the right site."],["Stage and drying coordination","Preparation, coating, drying, touch-up and handover can span several visits or teams."]],"track":["Areas & surfaces","Colour/product notes","Preparation status","Coat/stage progress","Drying/return visits","Handover evidence"],"outcomes":[["Fewer product mistakes","Keep colour and product context attached to the job."],["Visible stage progress","Know whether work is in prep, coating, drying or touch-up."],["Cleaner handover","Record final condition and outstanding touch-ups before closeout."]],"related":["plastering-repairs","rental-strata-maintenance","handyman-property-maintenance"]},"plastering-repairs":{"intro":"Plastering and repair work often starts with a visible defect but depends on what sits behind it. Field keeps defect evidence, likely cause, repair stages and drying or return requirements together so the job is not closed before the underlying work is actually ready.","challenges":[["Cause before cosmetic repair","Cracks or water damage may indicate a dependency that needs to be addressed before finishing."],["Drying and return stages","Repair, drying, sanding and finishing may require separate visits."],["Make-good coordination","Repair quality needs to be verified before painting or final handover proceeds."]],"track":["Defect evidence","Likely cause","Affected area","Repair stage","Drying status","Finish evidence"],"outcomes":[["Better defect history","Preserve what was observed before the repair changed the surface."],["Stage-aware scheduling","Coordinate repair, drying and finishing without losing context."],["Less premature closeout","Use evidence and stage state before marking work complete."]],"related":["painting-decorating","rental-strata-maintenance","handyman-property-maintenance"]},"tiling-surface-work":{"intro":"Tiling is highly sensitive to measurement, substrate condition, material quantity and preparation quality. Field makes substrate readiness and staged installation visible so labour is not dispatched to a surface that cannot yet be tiled.","challenges":[["Substrate readiness","Moisture, flatness, waterproofing or preparation can block installation even when the booking exists."],["Material quantity and batch","Tile quantity, wastage, adhesive, grout and matching product affect readiness."],["Curing and staged work","Preparation, installation, grouting and handover may require controlled sequencing."]],"track":["Measurements","Substrate condition","Tile/material batch","Preparation stage","Installation evidence","Curing/sign-off"],"outcomes":[["Fewer failed starts","Confirm substrate and material readiness before assigning installation."],["Better material control","Keep quantities and wastage attached to the job."],["Clearer quality proof","Record preparation, installation and finished condition."]],"related":["carpentry-joinery","plastering-repairs","handyman-property-maintenance"]},"pressure-exterior-cleaning":{"intro":"Pressure and exterior cleaning jobs are shaped by surface type, site access, weather, water management and equipment. Field keeps those conditions visible alongside routing and before/after evidence, which is especially useful for recurring commercial and property-maintenance work.","challenges":[["Surface sensitivity","Different materials require different pressure, treatment or exclusion decisions."],["Weather and access","Wind, rain, site access or occupied areas can change whether the work should proceed."],["Equipment and water readiness","Machines, hoses, attachments and water/runoff requirements need to be ready before arrival."]],"track":["Surface type","Access constraints","Weather sensitivity","Equipment readiness","Before/after proof","Recurring-service history"],"outcomes":[["Safer execution","Keep surface and site constraints visible to the crew."],["Stronger proof of work","Use before/after evidence for quality and customer handover."],["Better recurring routes","Keep repeat-service history and location context connected."]],"related":["rental-strata-maintenance","handyman-property-maintenance","painting-decorating"]},"rental-strata-maintenance":{"intro":"Rental and strata maintenance adds stakeholder and access complexity to otherwise ordinary field work. Field keeps property, occupant, requester, approval path, access notes and evidence connected so the worker is not caught between competing instructions on site.","challenges":[["Multi-party approval","Owner, manager, occupant or committee approval may be required before extra work proceeds."],["Access coordination","Keys, occupants, building rules and common-area access can determine whether a visit succeeds."],["Stakeholder reporting","The person requesting work may not be the person present at the property, so evidence and closeout reporting matter."]],"track":["Property & location","Requester/occupant context","Approval path","Access notes","Work evidence","Stakeholder report"],"outcomes":[["Fewer access failures","Keep current access and occupant context with the visit."],["Clear approval history","Tie variations and decisions to the right stakeholder."],["Better property records","Preserve work history and evidence across recurring maintenance."]],"related":["handyman-property-maintenance","painting-decorating","pressure-exterior-cleaning","equipment-appliance-repair"]},"equipment-appliance-repair":{"intro":"Equipment and appliance repair is asset-centric rather than just location-centric. Field keeps model, serial or asset identity, symptoms, service history, diagnosis, parts and return visits together so technicians can make decisions from the equipment history rather than a blank job card.","challenges":[["Asset identification","The correct model, serial, history and prior faults matter before diagnosis begins."],["Diagnostic uncertainty","The first visit may establish the fault rather than complete the repair."],["Parts and return visits","Parts availability, approval and follow-up scheduling often determine completion."]],"track":["Asset identity","Symptoms & fault notes","Service history","Required parts","Approval status","Return-visit outcome"],"outcomes":[["Faster diagnosis context","Give technicians history and symptoms before arrival."],["Cleaner parts workflow","Keep part requirements and approvals tied to the asset/job."],["Better service history","Close each repair into a durable equipment record."]],"related":["handyman-property-maintenance","rental-strata-maintenance","carpentry-joinery"]}};

function breadcrumbNav(items){
 return `<nav class="breadcrumbs" aria-label="Breadcrumb">${items.map((x,i)=>i<items.length-1?`<a data-link href="${x[0]}">${x[1]}</a><span aria-hidden="true">/</span>`:`<strong aria-current="page">${x[1]}</strong>`).join('')}</nav>`;
}
function verticalPage(slug){
 const v=verticalDetails[slug]; if(!v)return notFound();
 const seo=verticalSEO[slug]||{intro:'',challenges:[],track:[],outcomes:[],related:[]};
 const profile={
  'handyman-property-maintenance':[['Readiness','Multi-skill eligibility, access, likely materials'],['Evidence','Before/after, variations, sign-off'],['Common risk','Scope expands after arrival']],
  'carpentry-joinery':[['Readiness','Measures, drawings, materials, staged access'],['Evidence','Measurements, installation, finish'],['Common risk','Wrong measure or missing material']],
  'painting-decorating':[['Readiness','Areas, preparation, colours, products'],['Evidence','Prep, coats, touch-ups, handover'],['Common risk','Surface condition changes scope']],
  'plastering-repairs':[['Readiness','Defect cause, area, drying/return stages'],['Evidence','Defect, repair stages, finish'],['Common risk','Hidden moisture or dependency']],
  'tiling-surface-work':[['Readiness','Substrate, measurements, materials, wastage'],['Evidence','Preparation, installation, finish'],['Common risk','Substrate not ready']],
  'pressure-exterior-cleaning':[['Readiness','Surface, access, equipment, weather'],['Evidence','Before/after and exclusions'],['Common risk','Weather/access changes timing']],
  'rental-strata-maintenance':[['Readiness','Property, occupant, approval, access'],['Evidence','Work proof and stakeholder report'],['Common risk','Approval/access chain breaks']],
  'equipment-appliance-repair':[['Readiness','Asset identity, symptoms, history, parts'],['Evidence','Diagnosis, parts, repair outcome'],['Common risk','Return visit / parts dependency']]
 }[slug]||[];
 const related=seo.related.map(r=>[r,verticalDetails[r]]).filter(x=>x[1]);
 return `${nav('trades')}<main id="main"><div class="wrap">${breadcrumbNav([['/','Home'],['/trades','Trades'],['',v.name]])}</div>
 <section class="vertical-hero"><div class="wrap"><div class="vertical-icon">${v.icon}</div><div><div class="eyebrow">TITAN ZERO FIELD / ${v.name.toUpperCase()}</div><h1>${v.name}</h1><p class="lead">${seo.intro||`A specialised Field workflow for ${v.focus}.`}</p><div class="actions"><a data-link class="btn primary" href="/pricing">See Field pricing</a><a data-link class="btn" href="/features">Field features</a></div></div></div></section>
 <section class="section"><div class="wrap"><div class="eyebrow">COMMON WORK</div><h2>Jobs this vertical is designed to organise.</h2>${tagRow(v.jobs,'large')}</div></section>
 <section class="section alt"><div class="wrap"><div class="eyebrow">WHAT MAKES THIS WORK OPERATIONALLY DIFFERENT</div><div class="vertical-insights">${seo.challenges.map(x=>`<article><h3>${x[0]}</h3><p>${x[1]}</p></article>`).join('')}</div></div></section>
 <section class="section"><div class="wrap"><div class="eyebrow">WHAT FIELD KEEPS ATTACHED TO THE JOB</div>${tagRow(seo.track,'large')}</div></section>
 <section class="section alt"><div class="wrap"><div class="eyebrow">OPERATIONAL PROFILE</div>${matrixTable(['Field concern','What matters'],profile.map(x=>[x[0],x[1]]),'vertical-profile-table')}</div></section>
 <section class="section"><div class="wrap"><div class="eyebrow">VERTICAL WORKFLOW</div><h2>One numbered sequence — because order matters here.</h2><div class="vertical-timeline">${v.workflow.map((x,i)=>`<div class="vertical-step"><img src="/assets/field-number-${String(i+1).padStart(2,'0')}.webp" alt="" aria-hidden="true"><div><h3>${x}</h3><p>${workflowDescription(x)}</p></div></div>`).join('')}</div></div></section>
 <section class="section alt"><div class="wrap"><div class="eyebrow">WHAT A BETTER FIELD SYSTEM CHANGES</div>${statementRows(seo.outcomes)}</div></section>
 <section class="section"><div class="wrap"><div class="handoff-band"><div><span>DESK → FIELD</span><h3>Booked work arrives with context.</h3><p>Customer/site, appointment, approved scope and relevant communication history.</p></div><i>→</i><div><span>FIELD → PAY</span><h3>Verified work leaves with proof.</h3><p>Actual time, materials, approved variations, evidence and completion state.</p></div></div></div></section>
 <section class="section alt"><div class="wrap"><div class="eyebrow">RELATED FIELD WORKFLOWS</div><div class="related-trades">${related.map(x=>`<a data-link href="/trades/${x[0]}"><span>${x[1].icon}</span><b>${x[1].name}</b><small>Explore workflow →</small></a>`).join('')}</div></div></section>
 <section class="section"><div class="wrap"><div class="security-link-band"><div><span>AUTHORITY & RECOVERY</span><h3>Digital workers still act inside Field authority.</h3><p>Use capability-specific Observe, Recommend, Prepare and Execute boundaries rather than a global autonomy switch.</p></div><a data-link href="/security">See Field controls →</a></div></div></section>
 ${ctaBlock(`Run ${v.name} through Titan Zero Field.`,'Choose how much operational responsibility the Field workforce can carry under your authority rules.')}
 </main>${footer()}`;
}

function systemMap(){
 return `<section class="section systemmap"><div class="wrap"><div class="eyebrow">HOW FIELD FITS TOGETHER</div><h2>One operational system. Three working layers.</h2><div class="layergrid">
  <a data-link href="/workforce"><span>01</span><h3>Operations Manager & Specialists</h3><p>Capacity, scheduling, dispatch, quality, safety, materials, standards, analytics and escalation.</p></a>
  <a data-link href="/workforce"><span>02</span><h3>Digital Field Workers</h3><p>Bounded scheduling, dispatch, evidence, quality, materials, recovery and notification tasks.</p></a>
  <a data-link href="/titan-go"><span>03</span><h3>Human Field Workforce</h3><p>Titan Go carries assigned work, site context, instructions, evidence and completion into the field.</p></a>
 </div></div></section>`;
}

function authoritySection(){
 return `<section class="section alt"><div class="wrap"><div class="eyebrow">FIELD AUTHORITY BY DESIGN</div><h2>Prediction never grants permission.</h2><p class="lead">Authority is assigned to specific capabilities, so Field can be highly proactive without turning autonomy into a global on/off switch.</p>
 <div class="autonomy-spectrum">
  <div><span>OBSERVE</span><b>See and explain</b><p>Watch schedules, readiness, travel, evidence, quality and exceptions.</p><i style="--w:24%"></i></div>
  <div><span>RECOMMEND</span><b>Suggest the next move</b><p>Propose reassignments, gap fills, route changes and recovery actions.</p><i style="--w:48%"></i></div>
  <div><span>PREPARE</span><b>Build the action</b><p>Prepare schedule changes, orders, notifications or corrective work for approval.</p><i style="--w:72%"></i></div>
  <div><span>EXECUTE</span><b>Act inside policy</b><p>Carry out only the specific Field actions already authorised.</p><i style="--w:100%"></i></div>
 </div><p class="fine">Anything outside configured authority stops and escalates with its job, customer/site and operational context intact.</p></div></section>`;
}

function security(){
 return `${nav('')}<main id="main">
 <section class="hero compact"><div class="wrap"><div class="eyebrow">FIELD CONTROL & RECOVERY</div><h1>Autonomy is only useful<br><span>when failure behaviour is explicit.</span></h1><p class="lead">Field is designed around capability-specific authority, safe offline operation, evidence provenance, conflict handling and recoverable actions.</p></div></section>

 ${authoritySection()}

 <section class="section"><div class="wrap"><div class="eyebrow">RISK → CONTROL → BEHAVIOUR</div>
 ${matrixTable(['Operational risk','Control','Expected behaviour'],[
  ['Company/tenant unresolved','Fail-closed context resolution','Stop before data or authority is used'],
  ['Offline state is stale','Authority contraction + revision checks','Queue only safe actions and revalidate on reconnect'],
  ['Duplicate mutation','Idempotency','Do not duplicate arrival, evidence, material or completion events'],
  ['Queued work conflicts','Revision/conflict handling','Reconcile against current job state before replay'],
  ['Evidence disputed','Provenance + accepted-evidence history','Preserve source and what was accepted at the time'],
  ['Required proof missing','Completion gates','Block closeout until requirements are satisfied'],
  ['Action outside policy','Escalation','Return the exception to an authorised person'],
  ['Execution fails','Recovery path','Retain context so the action can be reviewed, corrected and retried']
 ],'control-matrix')}</div></section>
 ${pageArt("/assets/page-security-v30.webp","Titan Zero Field authority and security controls")}


 <section class="section alt"><div class="wrap"><div class="recovery-callout"><span>FAIL SAFELY</span><h2>“Could not act” is better than “acted without authority.”</h2><p>Field should make blocked work visible, explain why it stopped and preserve enough context for a human or authorised worker to continue.</p></div></div></section>

 ${ctaBlock('Autonomy should fail safely.','Field grows from Assist to Predictive + Autonomous without weakening the control model underneath.')}
 </main>${footer()}`;
}

function integrations(){
 const lanes=[
  ['LOCATION & TIME',['Maps','Routing','Travel time','Weather','Calendar']],
  ['FIELD COMMUNICATION',['Operational SMS','Notifications','APIs','Webhooks']],
  ['READINESS & SUPPLY',['Suppliers','Purchase orders','Asset data','Equipment data']],
  ['INTELLIGENCE',['External models','Local models','Visual analysis','BYO providers']],
  ['BUSINESS HANDOFFS',['Desk intake','Pay completion handoff','Reporting export','Accounting export']]
 ];
 return `${nav('')}<main id="main">
 <section class="hero compact"><div class="wrap"><div class="eyebrow">FIELD INTEGRATIONS</div><h1>Connect capabilities around Field.<br><span>Keep operational truth in one place.</span></h1><p class="lead">Field integrations extend routing, communication, supply, intelligence and downstream handoffs without turning the work order into five competing records.</p></div></section>
 <section class="section"><div class="wrap"><div class="connector-board">${lanes.map(l=>`<div class="connector-lane"><span>${l[0]}</span>${l[1].map(x=>`<b>${x}</b>`).join('')}</div>`).join('')}</div><p class="fine">Specific production connectors depend on deployment and provider configuration. This site does not claim every provider is enabled by default.</p></div></section>
 <section class="section alt"><div class="wrap split-editorial"><div><div class="eyebrow">WHY THE INTEGRATION BOUNDARY MATTERS</div><h2>External services should add capability without owning the job.</h2><p class="lead">A mapping provider can supply routes, a model can analyse evidence, and a supplier can receive an order. Field still keeps the canonical work order, authority decision and execution history so switching a provider does not fragment the operation.</p></div><div>${checkList([
  ['Provider-neutral where practical','Keep maps, models and communication providers replaceable when contracts allow.'],
  ['Context stays with Field','Customer/site, job, evidence and completion remain in the operating record.'],
  ['Failure becomes visible','Provider outage, delivery failure or rejected request becomes an exception rather than silent success.'],
  ['Authority remains local','An external API never grants itself permission to act on the job.']
 ])}</div></div></section>
 <section class="section"><div class="wrap"><div class="eyebrow">INTEGRATION PRINCIPLES</div>${matrixTable(['Principle','Field behaviour'],[
  ['Canonical context','Integrations extend the work order instead of creating competing job truth.'],
  ['Provider-neutral design','Maps, models and communications can be swapped where contracts allow.'],
  ['Authority still applies','External providers do not bypass Field permission or approval rules.'],
  ['Provenance stays visible','Important external data keeps source/provider context.'],
  ['Failure is explicit','Provider outage or failed delivery becomes an operational exception, not silent success.']
 ],'integration-principles')}</div></section>
 ${ctaBlock('Keep Field operationally focused.','Integrations extend delivery; Build, Desk and Pay remain responsible for their own parts of the business lifecycle.')}
 </main>${footer()}`;
}

function sovereignV2(){
 return `${nav('')}<main id="main">
 <section class="hero compact"><div class="wrap"><div class="eyebrow">FIELD DEPLOYMENT OPTION</div><h1>Titan Sovereign.<br><span>Private deployment for Field.</span></h1><p class="lead">Sovereign is a deployment model, not a fifth Field plan.</p></div></section>

 <section class="section"><div class="wrap"><div class="deployment-stack">
  <div><span>APPLICATION</span><h3>Titan Zero Field</h3><p>The same Field operating model, workforce and authority architecture.</p></div>
  <div><span>MODEL / PROVIDERS</span><h3>Local or BYO</h3><p>Local models, approved external providers and explicit privacy/egress rules.</p></div>
  <div><span>DATA</span><h3>Company-isolated storage</h3><p>Operational data stays separated around the canonical company boundary.</p></div>
  <div><span>INFRASTRUCTURE</span><h3>Dedicated VPS / DirectAdmin</h3><p>Private deployment, domains, backups, restore, rollback and environment health.</p></div>
 </div></div></section>

 <section class="section alt"><div class="wrap"><div class="eyebrow">WHY SOVEREIGN</div>${editorialRows([
  ['CONTROL','Infrastructure control','Use dedicated infrastructure and explicit provider configuration.','VPS • domains • backups'],
  ['PRIVACY','Data-egress control','Decide when Field data may leave the deployment and which providers may receive it.','Local models • BYO credentials'],
  ['RESILIENCE','Recovery ownership','Operate with deliberate backup, restore and rollback practices.','Recovery • offline field work']
 ])}</div></section>

 <section class="section"><div class="wrap"><div class="recovery-callout"><span>COMMERCIAL POSITION</span><h2>Quoted separately from the Field subscription ladder.</h2><p>Private deployment should be scoped around infrastructure, migration, integrations, security, support and the Titan apps being deployed.</p></div></div></section>

 ${ctaBlock('Field can be sold as SaaS without giving up a sovereign path.','Private deployment remains a separate Titan Zero commercial option for businesses that need it.')}
 </main>${footer()}`;
}

function chipCloud(items,cls=''){
 return `<div class="shared-chip-grid ${cls}">${items.map(x=>`<span>${x}</span>`).join('')}</div>`;
}
function standardsFinal(){
 return `${nav('standards')}<main id="main">
 <section class="hero compact"><div class="wrap"><div class="eyebrow">TITAN STANDARDS — INCLUDED FREE WITH FIELD</div><h1>Keep the way you want jobs done<br><span>inside the job system.</span></h1><p class="lead">Standards gives you one place for procedures, work instructions, safety requirements, licences, training, audits and corrective action.</p></div></section>

 <section class="section banner-section"><div class="wrap wide-wrap">${imageBanner('/assets/page-standards-v30.webp','Titan Standards for field-service businesses')}</div></section>

 <section class="section"><div class="wrap"><div class="standards-columns">
  <section><span>PROCEDURES</span><h3>How the job should be done</h3>${tagRow(['SOPs','Work instructions','Service standards','Troubleshooting'])}</section>
  <section><span>PEOPLE</span><h3>Who is allowed to do it</h3>${tagRow(['Skills','Training','Licences','Certifications','Refreshers'])}</section>
  <section><span>QUALITY</span><h3>What must be checked</h3>${tagRow(['Evidence','Inspections','Defects','Rework','Completion gates'])}</section>
  <section><span>SAFETY</span><h3>What can stop the job</h3>${tagRow(['WHS/OHS','Site safety','Permits','Expired licences','Restricted work'])}</section>
 </div></div></section>

 <section class="section alt"><div class="wrap"><div class="eyebrow">WHEN STANDARDS AFFECT THE JOB</div>
 ${matrixTable(['Requirement','What Field checks','What happens if it is missing'],[
  ['Worker competency','Skill, training or certification','Do not assign the job'],
  ['Safety requirement','Site or equipment safety check','Pause or escalate'],
  ['Required evidence','Photos, signature or inspection','Do not close the job'],
  ['Quality check','Inspection or defect state','Create corrective work'],
  ['Licence / insurance','Current eligibility','Prevent ineligible work'],
  ['Procedure','Current SOP/work instruction','Send the right work pack']
 ],'compliance-matrix')}</div></section>

 <section class="section"><div class="wrap split-editorial"><div><div class="eyebrow">AUDITS & IMPROVEMENT</div><h2>Use problems to improve the way the business works.</h2><p class="lead">If the same defect, missed step or safety issue keeps appearing, Standards can connect the finding to a corrective action and updated procedure instead of leaving it as another note.</p></div><div>${checkList([
  ['Record the finding','Capture what failed and the proof behind it.'],
  ['Find the cause','Work out whether the problem is training, process, equipment or something else.'],
  ['Assign the fix','Create a corrective or preventative action.'],
  ['Verify the result','Confirm the change actually improved the outcome.']
 ])}</div></div></section>

 ${ctaBlock('Standards is included with Field.','You do not need to buy another app just to keep procedures, training and quality under control.')}
 </main>${footer()}`;
}

function titanGoFinal(){
 return `${nav('go')}<main id="main">
 <section class="hero compact titan-go-hero"><div class="wrap"><div class="eyebrow">TITAN GO</div><h1>The job in the worker’s pocket.</h1><p class="lead">Titan Go is the mobile Field app for workers. It shows what they are doing today and gives them the customer, site, checklist, time, materials and proof they need for each job.</p></div></section>

 <section class="section"><div class="wrap"><figure class="device-showcase"><img src="/assets/titan-go-showcase-v31.webp" alt="Titan Go mobile app showing jobs, job details, evidence and assistant" loading="eager"></figure></div></section>

 <section class="section alt"><div class="wrap"><div class="eyebrow">WHAT WORKERS CAN DO</div>${checkList([
  ['See today’s jobs','Know where to go, when to arrive and what is next.'],
  ['Open the job','See scope, customer/site details and instructions.'],
  ['Use checklists','Follow the required tasks and work instructions.'],
  ['Record time and materials','Keep labour and material use against the correct job.'],
  ['Capture variations','Record changed scope and customer approval.'],
  ['Add evidence','Take photos, collect signatures and attach notes.'],
  ['Report incidents','Escalate safety or operational problems.'],
  ['Complete the job','Close only when required tasks and proof are present.']
 ])}</div></section>

 <section class="section"><div class="wrap"><div class="eyebrow">OFFLINE MODE</div><h2>Keep working when mobile reception disappears.</h2><p class="lead">Titan Go can keep selected job information and safe actions available offline. Notes, evidence and permitted job actions queue on the device, then recheck the job when the connection returns before syncing.</p>
 <div class="offline-states">
  <section><span>ONLINE</span><h3>Get the latest job</h3><p>Load current scope, notes and requirements.</p></section><i>→</i>
  <section><span>OFFLINE</span><h3>Keep working safely</h3><p>Queue only the actions allowed offline.</p></section><i>→</i>
  <section><span>RECONNECT</span><h3>Check and sync</h3><p>Confirm the job has not changed before replaying queued work.</p></section>
 </div></div></section>

 ${ctaBlock('Titan Go is included with Field.','Workers get a focused job app instead of carrying the whole back office in their pocket.')}
 </main>${footer()}`;
}

function imageBanner(src,alt,href='',priority=false){
 const load=priority?'eager':'lazy';
 const priorityAttr=priority?' fetchpriority="high"':'';
 const img=`<img src="${src}" alt="${alt}" loading="${load}"${priorityAttr} decoding="async">`;
 return href?`<a class="image-banner full-art" href="${href}">${img}</a>`:`<div class="image-banner full-art">${img}</div>`;
}
function productScreenshot(src,title,copy,cls=''){
 return `<figure class="product-shot ${cls}"><img src="${src}" alt="${title}" loading="lazy"><figcaption><b>${title}</b><span>${copy}</span></figcaption></figure>`;
}
function footerVisual(){
 return `<div class="footer-visual"><img src="/assets/field-footer-strip.webp" alt="Titan Zero Field — Run the Work" loading="lazy"></div>`;
}

function editorialRows(items){
 return `<div class="editorial-rows">${items.map((x,i)=>`<div class="editorial-row"><div class="editorial-title"><span>${x[0]}</span><h3>${x[1]}</h3></div><p>${x[2]}</p>${x[3]?`<div class="editorial-meta">${x[3]}</div>`:''}</div>`).join('')}</div>`;
}
function processRail(items){
 return `<div class="process-rail">${items.map((x,i)=>`<div class="process-node"><span class="process-dot"></span><b>${x[0]}</b><small>${x[1]||''}</small></div>${i<items.length-1?'<i aria-hidden="true">→</i>':''}`).join('')}</div>`;
}
function matrixTable(headers,rows,cls=''){
 return `<div class="matrix-shell ${cls}"><table class="data-matrix"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map((c,i)=>`<${i===0?'th':'td'}>${c}</${i===0?'th':'td'}>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function checkList(items){
 return `<ul class="check-list">${items.map(x=>`<li><span>✓</span><div><b>${x[0]}</b><p>${x[1]}</p></div></li>`).join('')}</ul>`;
}
function tagRow(items,cls=''){
 return `<div class="tag-row ${cls}">${items.map(x=>`<span>${x}</span>`).join('')}</div>`;
}
function statementRows(items){
 return `<div class="statement-rows">${items.map(x=>`<div class="statement-row"><b>${x[0]}</b><p>${x[1]}</p></div>`).join('')}</div>`;
}

function pageArt(src,alt){
 return `<section class="page-art-section"><div class="wrap wide-wrap"><figure class="page-art"><img src="${src}" alt="${alt}" loading="lazy" decoding="async"></figure></div></section>`;
}
function fieldHomeV20(){
 return `${nav('home')}<main id="main">
 <section class="art-hero"><div class="wrap wide-wrap">${imageBanner('/assets/page-home-v30.webp','Titan Zero Field — field service management for trade businesses',SIGNUP,true)}</div>
  <div class="wrap art-hero-actions"><div><h1>Run the work.</h1><span>Jobs, schedules, staff, materials, proof and quality in one system.</span></div><div class="actions"><a class="btn primary" href="${SIGNUP}">Access details →</a><a data-link class="btn" href="/pricing">See pricing</a></div></div>
 </section>

 <section class="section"><div class="wrap"><div class="eyebrow">WHAT TITAN ZERO FIELD DOES</div><h2>It helps you organise the work after the customer has booked.</h2><p class="lead">Field is the part of Titan Zero that runs day-to-day delivery. It keeps the job, schedule, worker, site details, materials, checklists, photos, variations and completion status together so your team knows what is happening and what needs attention.</p>
 ${editorialRows([
  ['JOBS','Keep every job in one place','Work orders, visits, tasks, recurring work, site notes and job history stay connected.','Jobs • Work orders • Sites'],
  ['SCHEDULE','Know who is doing what','See availability, skills, travel, capacity and live changes before work is assigned.','Calendar • Dispatch • Maps'],
  ['FIELD','Give workers the right information','Titan Go carries site details, instructions, checklists, time, materials and job actions into the field.','Mobile • Offline • Evidence'],
  ['QUALITY','Know when the job is really finished','Require photos, signatures, checklist completion, inspection or approval before closeout.','Evidence • Standards • Completion']
 ])}</div></section>

 <section class="section alt"><div class="wrap"><div class="eyebrow">FROM BOOKED JOB TO FINISHED JOB</div>
 ${processRail([
  ['Plan','Check scope, site and readiness'],
  ['Assign','Choose the right worker'],
  ['Travel','Route and access'],
  ['Do the work','Time, materials and changes'],
  ['Prove it','Photos, signatures and checks'],
  ['Complete','Close and hand off']
 ])}</div></section>

 <section class="section faded-bg operations-dusk-bg"><div class="wrap overlay-content">
  <div class="eyebrow">WHEN THE DAY CHANGES</div><h2>Field helps you recover without losing track of the job.</h2><p class="lead">A worker calls in sick, a customer cannot provide access, weather changes the plan, a job takes longer than expected. Field keeps the affected jobs visible and helps you decide what can be moved, reassigned or followed up.</p>
  <div class="metric-line"><div><b>Ready?</b><span>Check worker, materials, equipment and access before dispatch.</span></div><div><b>Delayed?</b><span>See what jobs and customers are affected.</span></div><div><b>Finished?</b><span>Close only when required proof is there.</span></div></div>
 </div></section>

 <section class="section"><div class="wrap"><div class="eyebrow">WHAT FIELD HELPS YOUR BUSINESS DO</div>
 <div class="number-feature-grid">
  ${[
   ['01','Keep the schedule workable','Balance jobs, staff, travel and changes without rebuilding the day from scratch.'],
   ['02','Send workers prepared','Give them the site details, instructions, materials and equipment information they need.'],
   ['03','Keep proof with the job','Store photos, signatures, notes and approved variations against the correct work order.'],
   ['04','Keep work consistent','Use checklists, SOPs, safety rules and quality checks as part of the job.']
  ].map(x=>`<article class="number-feature"><img src="/assets/field-number-${x[0]}.webp" alt="" aria-hidden="true" loading="lazy"><div><h3>${x[1]}</h3><p>${x[2]}</p></div></article>`).join('')}
 </div></div></section>

 <section class="section alt"><div class="wrap split-editorial"><div><div class="eyebrow">TITAN GO</div><h2>The worker sees the job, not the whole office system.</h2><p class="lead">Titan Go gives field staff the information and actions they need for the work in front of them: today’s jobs, site details, directions, checklists, notes, time, materials, variations, incidents, photos and completion.</p><a data-link class="text-link" href="/titan-go">Explore Titan Go →</a></div>
 <div>${checkList([
  ['Works offline','Safe actions and evidence can queue when mobile reception drops.'],
  ['Keeps the job current','Workers see the latest scope, notes and site information.'],
  ['Captures proof on site','Photos, signatures and notes stay with the job.'],
  ['Makes handover easier','The office receives a clear completion record.']
 ])}</div></div></section>

 <section class="section"><div class="wrap split-editorial reverse"><div><div class="eyebrow">TITAN STANDARDS — INCLUDED FREE</div><h2>Put your procedures into the job instead of leaving them in a folder.</h2><p class="lead">Use SOPs, work instructions, safety requirements, licences, training, quality checks and audits inside the same system that runs the work.</p><a data-link class="text-link" href="/standards">Explore Titan Standards →</a></div>
 <div>${statementRows([
  ['Tell people what good looks like','Give each job the right checklist, instructions and evidence requirements.'],
  ['Check who is allowed to do the work','Use skills, training, licences and certification requirements.'],
  ['Record problems properly','Keep defects, incidents and corrective work with the job.'],
  ['Improve repeated problems','Use audits and recurring failures to update the way the work is done.']
 ])}</div></div></section>

 <section class="section workforce-bg-story"><div class="wrap overlay-content narrow"><div class="eyebrow">FIELD WORKFORCE</div><h2>A digital operations team working behind your field staff.</h2><p class="lead">The Operations Manager coordinates the system. Specialists look after areas such as scheduling, quality, safety and supply. Workers carry out the smaller repetitive tasks underneath them.</p><a data-link class="btn primary" href="/workforce">Meet the Field workforce →</a></div></section>

 <section class="section alt home-pricing"><div class="wrap"><div class="eyebrow">FIELD PRICING</div><h2>Choose how much of the office work Titan is allowed to handle.</h2><p class="lead">The plans use the same Field system. The difference is whether Titan only helps when asked, watches and suggests, or can carry out approved routine actions for you.</p>
  <div class="price-mini-grid">
   <div><span>Assist</span><b>A$299</b><small>/month</small></div>
   <div class="featured"><span>Suggest</span><b>A$499</b><small>/month</small></div>
   <div><span>Autonomous</span><b>A$899</b><small>/month</small></div>
   <div><span>Predictive + Autonomous</span><b>A$1,299</b><small>/month</small></div>
  </div><div class="actions topgap"><a data-link class="btn primary" href="/pricing">Compare Field plans →</a></div>
 </div></section>

 ${fieldSuiteMention()}
 ${ctaBlock('Run the work through Titan Zero Field.','Build finds work, Desk books it, Field delivers it, and Pay handles the money afterward.')}
 </main>${footer()}`;
}

function fieldSuiteMention(){
 return `<section class="section suite-line"><div class="wrap"><div class="suite-line-inner">
  <div><span class="eyebrow">PART OF TITAN ZERO</span><h2>Build → Desk → <strong>Field</strong> → Pay</h2><p>Field owns delivery and verification. The surrounding apps create demand, convert it and collect the money.</p></div>
  <nav class="suite-links" aria-label="Titan Zero apps">
   <a href="${BUILD_SITE}"><span class="dot blue"></span>Build</a>
   <a href="${DESK_SITE}"><span class="dot red"></span>Desk</a>
   <a href="${FIELD_SITE}" class="current"><span class="dot yellow"></span>Field</a>
   <a href="${PAY_SITE}"><span class="dot green"></span>Pay</a>
  </nav>
 </div></div></section>`;
}

function fieldFeaturesV20(){
 return `${nav('features')}<main id="main">
 <section class="hero compact"><div class="wrap"><div class="eyebrow">FIELD FEATURES</div><h1>Everything you need to<br><span>organise and deliver the work.</span></h1><p class="lead">Field combines job management, scheduling, mobile work, materials, proof, quality and standards in one system.</p></div></section>
 ${pageArt("/assets/page-features-v30.webp","Titan Zero Field features overview")}

 <section class="section"><div class="wrap"><div class="eyebrow">JOBS & WORK ORDERS</div><h2>Keep the full job record together.</h2>${checkList([
  ['Service requests and work orders','Create the job, scope, visits, tasks and recurring work.'],
  ['Sites and properties','Keep access notes, service history and site information attached.'],
  ['Job status and history','See what happened, what is happening and what still needs to happen.'],
  ['Dependencies and return visits','Keep staged work and follow-up visits linked to the same job.']
 ])}</div></section>

 <section class="section alt"><div class="wrap"><div class="eyebrow">SCHEDULING & DISPATCH</div><h2>Plan the day around real staff and real travel.</h2>${matrixTable(['Feature','What it does','Why it helps'],[
  ['Availability','Shows when workers are actually available','Avoid double-booking'],
  ['Skills & qualifications','Checks whether the worker is suitable for the job','Send the right person'],
  ['Travel & routing','Uses location and travel time when planning work','Reduce wasted driving'],
  ['Capacity','Shows how much work the team can realistically handle','Avoid overloaded days'],
  ['Live changes','Supports reassigning, gap filling and recovery','Keep the day moving']
 ],'features-matrix')}</div></section>

 <section class="section"><div class="wrap"><div class="eyebrow">TITAN GO</div><h2>Give the field team the information they need on site.</h2>${checkList([
  ['Today’s jobs','See assigned work and timing.'],
  ['Customer and site details','Access instructions, address and contact information.'],
  ['Checklists and notes','Follow the work and record what happened.'],
  ['Time and materials','Record labour time, consumables and parts used.'],
  ['Variations','Capture changed scope and approval.'],
  ['Photos and signatures','Store before/after proof and handover.'],
  ['Offline mode','Continue safe work when reception drops.']
 ])}</div></section>

 <section class="section alt"><div class="wrap"><div class="eyebrow">MATERIALS, STOCK & EQUIPMENT</div><h2>Know whether the job is ready before the worker arrives.</h2>${statementRows([
  ['Materials','Track what the job needs and what was actually used.'],
  ['Inventory','Track stock locations, receipts and low-stock problems.'],
  ['Equipment','Track availability, custody, condition and maintenance.'],
  ['Suppliers','Prepare purchase orders and record goods received.'],
  ['Readiness','Check worker, materials, equipment and access before dispatch.']
 ])}</div></section>

 <section class="section"><div class="wrap"><div class="eyebrow">EVIDENCE & QUALITY</div><h2>Do not close a job just because someone pressed “complete”.</h2>${checkList([
  ['Before/after photos','Keep proof attached to the job.'],
  ['Signatures','Capture customer handover or approval.'],
  ['Completion gates','Require the checklist, evidence or inspection the job needs.'],
  ['Defects and rework','Record what failed and what needs correcting.'],
  ['Visual review','Use AI-assisted review without treating it as unquestionable fact.']
 ])}</div></section>

 <section class="section alt"><div class="wrap"><div class="eyebrow">STANDARDS, SAFETY & TRAINING</div><h2>Keep the way you want work done inside the system.</h2>${checkList([
  ['SOPs and work instructions','Give workers the current procedure for the job.'],
  ['WHS/OHS and safety','Add safety checks and job restrictions.'],
  ['Licences and certifications','Track expiry and eligibility.'],
  ['Training and competency','Keep onboarding and refresher requirements current.'],
  ['Audits and improvement','Turn findings into corrective action and better procedures.']
 ])}</div></section>

 ${fieldSuiteMention()}${ctaBlock('Field owns delivery.','Desk hands over booked work. Field runs it. Pay receives the verified completion afterward.')}
 </main>${footer()}`;
}

function fieldWorkforceV20(){
 const manager=["Operations Manager", "operations_manager", "Owns delivery, capacity, quality and escalation across the whole Field operation."];
 const specialistTeams={
  planning:[["Scheduling Specialist", "scheduling_specialist", "Plans appointments, recurring work and calendar changes."],["Dispatch Specialist", "dispatch_specialist", "Coordinates live assignments and keeps work moving."],["Routing Specialist", "routing_specialist", "Builds efficient routes around travel, timing and job priority."],["Capacity Specialist", "capacity_specialist", "Balances demand, availability and workload across the team."],["Workforce Specialist", "workforce_specialist", "Matches skills, availability and qualifications to work."]],
  field:[["Job Specialist", "job_specialist", "Keeps each job moving from approved scope to completion."],["Field Support Specialist", "field_support_specialist", "Supports workers in real time with job context and escalation."],["Evidence Specialist", "evidence_specialist", "Keeps photos, signatures and proof organised against the job."],["Quality Specialist", "quality_specialist", "Checks work against standards before closeout."],["Safety Specialist", "safety_specialist", "Helps keep jobs safe, compliant and ready for field execution."]],
  standards:[["Standards Specialist", "standards_specialist", "Maintains SOPs, work instructions and company standards."],["Compliance Specialist", "compliance_specialist", "Tracks licences, insurance, certifications and job eligibility."],["Training Specialist", "training_specialist", "Keeps onboarding, SOP training, competency and refreshers current."],["Audit Specialist", "audit_specialist", "Runs operational, job, safety and compliance audits with evidence."],["Continuous Improvement Specialist", "continuous_improvement_specialist", "Turns recurring failures into verified improvement."]],
  supply:[["Materials Specialist", "materials_specialist", "Keeps required materials visible and job-ready."],["Inventory Specialist", "inventory_specialist", "Tracks stock levels, locations, receipts and low-stock risk."],["Equipment Specialist", "equipment_specialist", "Keeps tools and equipment available, assigned and fit for work."],["Maintenance Specialist", "maintenance_specialist", "Keeps equipment maintenance and service history visible."],["Supply Specialist", "supply_specialist", "Coordinates suppliers, orders and goods receipt."]],
  analytics:[["Operations Analytics Specialist", "operations_analytics_specialist", "Turns field activity into operational decisions."],["Predictive Operations Specialist", "predictive_operations_specialist", "Looks ahead for workload, capacity, readiness and failure risk."]]
 };
 const workerTeams={
  planning:[["Scheduling Worker", "scheduling_worker", "Carries out bounded schedule updates and appointment actions."],["Dispatch Worker", "dispatch_worker", "Sends assignments and bounded live dispatch updates."],["Route Worker", "route_worker", "Builds route options and travel estimates."],["Assignment Worker", "assignment_worker", "Matches eligible workers to jobs inside configured rules."],["Gap-Fill Worker", "gap_fill_worker", "Finds suitable work for newly available capacity."],["Access Worker", "access_worker", "Checks site access information before the visit."],["Weather Recovery Worker", "weather_recovery_worker", "Identifies weather-affected work and prepares recovery actions."]],
  field:[["Checklist Worker", "checklist_worker", "Loads and updates required job checklists and work packs."],["Evidence Worker", "evidence_worker", "Organises photos, signatures and accepted evidence."],["Visual Review Worker", "visual_review_worker", "Reviews before-and-after evidence and proposes findings."],["Quality Worker", "quality_worker", "Checks completion rules, evidence gates and quality exceptions."],["Variation Worker", "variation_worker", "Prepares changed-scope records and approval requests."],["Service Report Worker", "service_report_worker", "Compiles completed-job service reports."],["Notification Worker", "notification_worker", "Sends approved operational notifications."]],
  supply:[["Materials Worker", "materials_worker", "Records materials used and job material quantities."],["Inventory Worker", "inventory_worker", "Records stock movement, receipts and low-stock exceptions."],["Equipment Worker", "equipment_worker", "Updates equipment custody, assignment and condition."],["Maintenance Worker", "maintenance_worker", "Creates and updates bounded maintenance actions."],["Supplier Order Worker", "supplier_order_worker", "Prepares purchase orders and tracks receipt events."]],
  standards:[["Safety Worker", "safety_worker", "Runs required safety checks and raises unsafe conditions."],["Training Worker", "training_worker", "Assigns required training and records completion."],["Audit Worker", "audit_worker", "Runs audit checklists and records evidence-backed findings."]]
 };
 const profile=(x,kind='specialist')=>`<article class="staff-profile-card ${kind}"><img src="/assets/staff-${x[1]}.webp" alt="${x[0]} profile" loading="lazy"><div class="staff-profile-notes"><span>${kind==='worker'?'BOUNDED WORKER':'WHAT THEY HANDLE'}</span><p>${x[2]}</p></div></article>`;
 const team=(title,copy,rows,workers)=>`<section class="section workforce-team-section"><div class="wrap"><div class="team-heading"><div><div class="eyebrow">${title}</div><h2>${copy}</h2></div><span>${rows.length} specialists</span></div><div class="staff-profile-grid">${rows.map(x=>profile(x)).join('')}</div>${workers?`<div class="workers-heading"><b>Workers in this team</b><p>These roles carry out specific, bounded tasks for the specialists above.</p></div><div class="staff-profile-grid workers">${workers.map(x=>profile(x,'worker')).join('')}</div>`:''}</div></section>`;
 return `${nav('workforce')}<main id="main">
 <section class="workforce-directory-hero"><div class="wrap"><div class="eyebrow">TITAN ZERO FIELD WORKFORCE</div><h1>A clear operations team<br><span>behind every job.</span></h1><p class="lead">Field uses a simple structure: the Operations Manager coordinates the whole operation, Specialists make decisions in their area, and Workers carry out specific tasks inside the rules you set.</p><div class="workforce-counts"><span><b>1</b> manager</span><span><b>22</b> specialists</span><span><b>22</b> workers</span></div></div></section>

 <section class="section manager-directory"><div class="wrap"><div class="team-heading"><div><div class="eyebrow">OPERATIONS MANAGER</div><h2>The person coordinating the whole Field operation.</h2></div></div><div class="manager-card-wrap">${profile(manager,'manager')}</div></div></section>

 ${team('PLANNING & COORDINATION','Plans the day, assigns work and keeps the schedule moving.',specialistTeams.planning,workerTeams.planning)}
 ${team('FIELD SUPPORT, QUALITY & SAFETY','Supports the crew, keeps proof attached and checks the work before closeout.',specialistTeams.field,workerTeams.field)}
 ${team('STANDARDS, COMPLIANCE & TRAINING','Keeps procedures, licences, competency and audits current.',specialistTeams.standards,workerTeams.standards)}
 ${team('MATERIALS, EQUIPMENT & SUPPLY','Makes sure jobs have the stock, equipment and supplier support they need.',specialistTeams.supply,workerTeams.supply)}
 ${team('ANALYTICS & PREDICTIVE OPERATIONS','Turns field activity into useful operational decisions and early warnings.',specialistTeams.analytics,null)}

 <section class="section alt"><div class="wrap split-editorial"><div><div class="eyebrow">HOW THE ROLES WORK TOGETHER</div><h2>Manager → Specialist → Worker</h2><p class="lead">You do not have to manage dozens of unrelated bots. The manager coordinates outcomes, each specialist owns a clear area of operations, and workers carry out the repetitive actions underneath them.</p></div><div>${checkList([
  ['Manager','Prioritises work, exceptions and business-wide operational outcomes.'],
  ['Specialist','Makes domain decisions such as scheduling, quality, safety or supply.'],
  ['Worker','Executes a bounded task such as a route calculation, evidence check or notification.'],
  ['Human team','Keeps control of physical work, customer relationships and decisions outside Titan authority.']
 ])}</div></div></section>

 ${authoritySection()}
 ${ctaBlock('A real team structure — not a bag of AI agents.','Choose the level of authority that fits your business today, then expand it only where it earns your trust.')}
 </main>${footer()}`;
}

function fieldPricingV20(){
 const levels=[
  ['Assist','A$299','Titan helps when you ask.','Drafts, summaries, analysis and on-demand help.'],
  ['Suggest','A$499','Titan watches and recommends.','Monitors the operation and suggests or prepares actions.'],
  ['Autonomous','A$899','Titan handles approved routine work.','Runs authorised tasks without asking every time.'],
  ['Predictive + Autonomous','A$1,299','Titan looks ahead and acts inside your rules.','Uses forecasts and risk signals to start approved responses.']
 ];
 return `${nav('pricing')}<main id="main">
 <section class="hero compact"><div class="wrap"><div class="eyebrow">TITAN ZERO FIELD PRICING</div><h1>Choose how much<br><span>office work Titan handles.</span></h1><p class="lead">All plans use the same Field operating system. The main difference is how proactive the digital workforce is allowed to be.</p></div></section>
 ${pageArt("/assets/page-pricing-v30.webp","Titan Zero Field pricing")}

 <section class="section"><div class="wrap"><div class="field-price-grid">${levels.map((x,i)=>`<article class="${i===1?'featured':''}"><span>${x[0]}</span><strong>${x[1]}</strong><small>/month</small><p>${x[2]}</p><em>${x[3]}</em>${i===1?'<b>Good starting point for a growing team</b>':''}</article>`).join('')}</div></div></section>

 <section class="section alt"><div class="wrap"><div class="eyebrow">WHAT CHANGES BETWEEN PLANS</div>
 ${matrixTable(['Capability','Assist','Suggest','Autonomous','Predictive + Autonomous'],[
  ['Help when you ask','✓','✓','✓','✓'],
  ['Watch for problems','—','✓','✓','✓'],
  ['Recommend next actions','—','✓','✓','✓'],
  ['Prepare work for approval','Limited','✓','✓','✓'],
  ['Carry out approved routine work','—','—','✓','✓'],
  ['Use predictive signals','—','Some','Some','✓'],
  ['Start approved responses from predictions','—','—','Limited','✓'],
  ['Keep human approvals and history','✓','✓','✓','✓']
 ],'pricing-comparison')}</div></section>

 <section class="section"><div class="wrap split-editorial"><div><div class="eyebrow">INCLUDED WITH FIELD</div><h2>You still get the actual Field system at every level.</h2><p class="lead">The lower plans are not crippled versions of job management. Titan Go, Standards and the core Field records remain part of the product.</p></div><div>${checkList([
  ['Titan Go','Mobile and offline field execution.'],
  ['Titan Standards','SOPs, compliance, training and audits.'],
  ['Jobs and work orders','Scheduling, evidence, materials and variations.'],
  ['Authority controls','Decide what Titan may suggest, prepare or execute.']
 ])}</div></div></section>

 <section class="section alt"><div class="wrap"><div class="eyebrow">EXTERNAL USAGE</div><h2>Some third-party costs stay separate.</h2><p class="lead">Things such as maps, external AI models, SMS or voice usage can create provider costs. Those are metered rather than hidden inside the subscription.</p></div></section>

 ${fieldSuiteMention()}${ctaBlock('Choose the level that suits the way you work now.','You can expand Titan’s authority later instead of switching the entire system on at once.')}
 </main>${footer()}`;
}

function fieldSuiteV20(){
 return `${nav('suite')}<main id="main">
 <section class="hero compact"><div class="wrap"><div class="eyebrow">THE TITAN ZERO SUITE</div><h1>Four business systems.<br><span>One owner experience.</span></h1><p class="lead">Build creates demand. Desk converts it. Field delivers it. Pay collects it. This website focuses specifically on Field.</p></div></section>

 <section class="section"><div class="wrap"><div class="suite-flow">
  <a href="${BUILD_SITE}" class="build"><span>BUILD</span><b>Create demand</b><p>Prospecting, markets, campaigns and growth.</p></a><i>→</i>
  <a href="${DESK_SITE}" class="desk"><span>DESK</span><b>Convert & serve</b><p>Reception, CRM, sales, quotes and booking.</p></a><i>→</i>
  <a href="${FIELD_SITE}" class="field"><span>FIELD</span><b>Deliver & verify</b><p>Jobs, workforce, field execution and quality.</p></a><i>→</i>
  <a href="${PAY_SITE}" class="pay"><span>PAY</span><b>Invoice & collect</b><p>Billing, reconciliation and collections.</p></a>
 </div></div></section>

 <section class="section alt"><div class="wrap split-editorial"><div><div class="eyebrow">TITAN ZERO</div><h2>Talk to the business in outcomes.</h2><p>“Fix tomorrow’s schedule” routes into Field. “Follow those quotes” routes into Desk. The owner should not need to think in module boundaries.</p><a href="${ZERO_SITE}" class="text-link">Explore Titan Zero ↗</a></div>
 <div><div class="eyebrow">TITAN ZERO CORE</div><h2>Manage the environment behind it.</h2><p>Apps, workforce, sites, models, API keys, channels, permissions, integrations, servers, backups, updates and health.</p><a href="${CORE_SITE}" class="text-link">Explore Core ↗</a></div></div></section>
 </main>${footer()}`;
}

function contactV23(){
 return `${nav('contact')}<main id="main">
 <section class="hero compact"><div class="wrap"><div class="eyebrow">CONTACT TITAN ZERO FIELD</div><h1>Talk to us about<br><span>running the work better.</span></h1><p class="lead">Start a Field conversation, discuss fit, ask about onboarding, or begin a founding-business deployment.</p></div></section>
 ${pageArt("/assets/page-contact-v30.webp","Titan Zero Field support and contact team")}


 <section class="section"><div class="wrap contact-grid">
  <article id="join" class="contact-card featured"><span>JOIN FIELD</span><h2>Start with Titan Zero Field</h2><p>Choose an autonomy level, then configure workforce, scheduling, Titan Go, Standards, evidence and authority around the way you actually work.</p><div class="actions"><a class="btn primary" href="${SIGNUP}">Access details</a><a data-link class="btn" href="/pricing">View pricing</a></div></article>
  <article class="contact-card"><span>EXISTING USER</span><h2>Open Field</h2><p>Return to the application for your current Field environment.</p><div class="actions"><a class="btn" href="${LOGIN}">Login</a></div></article>
 </div></section>

 <section class="section alt"><div class="wrap"><div class="eyebrow">USEFUL CONTEXT TO BRING</div>${checkList([
  ['Your delivery problem','Scheduling, dispatch, capacity, evidence, quality, compliance or field mobility.'],
  ['Your workforce','Field workers, office operators, locations and key skill/qualification constraints.'],
  ['Your current process','How work moves from booking through execution, proof and invoicing.'],
  ['Your autonomy preference','Where you want assistance, suggestions, approval or authorised execution.']
 ])}</div></section>

 ${ctaBlock('Ready to run the work through Field?','Start the conversation and map the deployment around your operation.')}
 </main>${footer()}`;
}

function whyFieldV24(){
 return `${nav('')}<main id="main">
 <section class="hero compact"><div class="wrap"><div class="eyebrow">WHY TITAN ZERO FIELD</div><h1>Field-service software should<br><span>help carry the operation.</span></h1><p class="lead">The difference is not “more features”. It is whether the system understands what has to be true for work to be delivered correctly.</p></div></section>
 <section class="section"><div class="wrap">${statementRows([
  ['A calendar is not readiness','A slot can be free while the correct worker, materials, equipment or access are missing.'],
  ['A job card is not execution','Workers need current scope, instructions, time, materials, variations and evidence in the field.'],
  ['A photo is not proof','Evidence becomes useful when provenance, requirement and accepted state are preserved.'],
  ['Automation is not authority','Recommendation, preparation and execution should be independently controlled.'],
  ['Compliance is not a PDF','Standards matter when they can affect eligibility, work packs, evidence and closeout.'],
  ['Analytics is not improvement','Signals only matter when they can become action, recovery or a better operating standard.']
 ])}</div></section>
 <section class="section alt"><div class="wrap split-editorial"><div><div class="eyebrow">WHAT CHANGES IN PRACTICE</div><h2>Field treats exceptions as part of the system design.</h2><p class="lead">A cancellation, failed visit, missing material or poor-quality closeout should not send the business back to spreadsheets and phone calls. Field keeps enough context around the exception for a person or authorised digital worker to recover it.</p></div><div>${checkList([
  ['Before dispatch','Expose readiness problems while there is still time to fix them.'],
  ['During execution','Keep scope changes, incidents and uncertainty attached to the job.'],
  ['At closeout','Require the proof and quality state the business actually needs.'],
  ['After failure','Preserve evidence so the process can improve rather than repeat.']
 ])}</div></div></section>
 <section class="section"><div class="wrap"><div class="eyebrow">THE OPERATING QUESTION</div><h2>Can this work be delivered correctly, safely and profitably — right now?</h2><p class="lead">Field keeps the operational context needed to answer that question before dispatch, during execution and at closeout.</p>${processRail([['Ready','Worker + materials + equipment'],['Deliver','Scope + field context'],['Verify','Evidence + quality'],['Learn','Exceptions + Standards']])}</div></section>
 ${ctaBlock('Run the work as a system.','Explore Field features, workforce and pricing to see how much operational responsibility Titan can carry.')}
 </main>${footer()}`;
}

function aboutFieldV24(){
 return `${nav('')}<main id="main">
 <section class="hero compact"><div class="wrap"><div class="eyebrow">ABOUT TITAN ZERO FIELD</div><h1>Field is the delivery system<br><span>inside Titan Zero.</span></h1><p class="lead">It owns the operational journey from booked work to verified completion.</p></div></section>
 <section class="section"><div class="wrap split-editorial"><div><h2>What Field owns</h2><p class="lead">Jobs, work orders, scheduling, dispatch, Titan Go, time, materials, variations, evidence, quality, assets, supply, Standards and operational analytics all belong to the delivery side of the business.</p><p class="body-copy">That boundary matters. Field receives booked work and commercial context from Desk, but it does not become a marketing CRM. At the other end it hands verified labour, materials, variations and completion state to Pay rather than becoming the receivables system.</p></div><div>${checkList([
  ['Before the job','Readiness, assignment, capacity, route and access.'],
  ['During the job','Field actions, time, materials, scope change and incidents.'],
  ['At closeout','Evidence, quality, completion gates and verified handoff.'],
  ['After the job','Operational analytics, audits and continuous improvement.']
 ])}</div></div></section>
 <section class="section alt"><div class="wrap"><div class="eyebrow">THE DESIGN PRINCIPLE</div><h2>One record should move through the business without being recreated.</h2><p class="lead">The customer, property, approved scope and appointment can arrive from Desk; Field adds the execution truth; Pay receives the verified financial context. That lets the four Titan Zero apps remain commercially clear without forcing the business to reconcile duplicate records.</p></div></section>
 ${fieldSuiteMention()}
 <section class="section alt"><div class="wrap"><div class="eyebrow">ABOVE & BEHIND FIELD</div>${editorialRows([
  ['ZERO','Titan Zero','The owner’s conversational interface across Build, Desk, Field and Pay.','Talk to your business'],
  ['CORE','Titan Zero Core','The system manager for apps, workforce, sites, models, channels, permissions, integrations, servers, backups and health.','Manage the environment']
 ])}</div></section>
 </main>${footer()}`;
}

function notFound(){return `${nav()}<main id="main"><section class="hero compact"><div class="wrap"><div class="eyebrow">404</div><h1>Page not found.</h1><p class="lead">That page is not part of the current Titan Zero Field site.</p><a data-link class="btn primary" href="/">Back to Field</a></div></section></main>${footer()}`}

const routes={
 '/':fieldHomeV20,
 '/features':fieldFeaturesV20,
 '/workforce':fieldWorkforceV20,
 '/pricing':fieldPricingV20,
 '/titan-go':titanGoFinal,
 '/standards':standardsFinal,
 '/trades':tradePage,
 '/trades/handyman-property-maintenance':()=>verticalPage('handyman-property-maintenance'),
 '/trades/carpentry-joinery':()=>verticalPage('carpentry-joinery'),
 '/trades/painting-decorating':()=>verticalPage('painting-decorating'),
 '/trades/plastering-repairs':()=>verticalPage('plastering-repairs'),
 '/trades/tiling-surface-work':()=>verticalPage('tiling-surface-work'),
 '/trades/pressure-exterior-cleaning':()=>verticalPage('pressure-exterior-cleaning'),
 '/trades/rental-strata-maintenance':()=>verticalPage('rental-strata-maintenance'),
 '/trades/equipment-appliance-repair':()=>verticalPage('equipment-appliance-repair'),
 '/suite':fieldSuiteV20,
 '/integrations':integrations,
 '/security':security,
 '/onboarding':onboarding,
 '/faq':faq,
 '/sovereign':sovereignV2,
 '/field':fieldHomeV20,
 '/platform':fieldHomeV20,
 '/operations':fieldHomeV20,
 '/field-workforce':fieldWorkforceV20,
 '/operations-workforce':fieldWorkforceV20,
 '/ai-workforce':fieldWorkforceV20,
 '/build':fieldSuiteV20,
 '/desk':fieldSuiteV20,
 '/pay':fieldSuiteV20,
 '/front-office':fieldSuiteV20,
 '/zero':fieldSuiteV20,
 '/core':fieldSuiteV20
,
 '/owner-operations':fieldHomeV20
,
 '/contact':contactV23
,
 '/why-field':whyFieldV24
,
 '/about':aboutFieldV24
};
const routeMeta={"/":["Field Service Management Software Australia | Titan Zero Field","Run jobs, scheduling, dispatch, field teams, evidence, quality and compliance with Titan Zero Field, built for Australian field-service businesses."],"/features":["Field Service Software Features | Titan Zero Field","Explore work orders, scheduling, dispatch, maps, offline field work, materials, evidence, quality, Standards and predictive operations."],"/workforce":["AI Field Service Workforce | Titan Zero Field","Meet the Operations Manager, Specialists and Workers that support scheduling, dispatch, quality, safety, materials and field operations."],"/pricing":["Field Service Software Pricing Australia | Titan Zero Field","Titan Zero Field plans start at A$299/month, with Assist, Suggest, Autonomous and Predictive + Autonomous operational workforce levels."],"/titan-go":["Field Service Mobile App | Titan Go","Titan Go gives field workers jobs, maps, site context, checklists, time, materials, variations, evidence and offline execution."],"/standards":["Field Service SOP & Compliance Software | Titan Standards","Titan Standards brings SOPs, WHS/OHS, compliance, training, competency, auditing, quality and continuous improvement into Field."],"/trades":["Tradie Job Management Software Australia | Titan Zero Field","Explore job management and field-service workflows for Australian handyman, carpentry, painting, plastering, tiling, cleaning, maintenance and repair businesses."],"/trades/handyman-property-maintenance":["Handyman Job Management Software Australia | Titan Zero Field","Run handyman and property maintenance jobs with scheduling, materials, variations, recurring work, field evidence and quality controls in Titan Zero Field."],"/trades/carpentry-joinery":["Carpentry Job Management Software Australia | Titan Zero Field","Manage carpentry and joinery jobs with site measures, staged work, material readiness, scheduling, installation evidence and return visits."],"/trades/painting-decorating":["Painting Contractor Software Australia | Titan Zero Field","Manage painting jobs with surface preparation, colours, products, staged scheduling, field evidence, touch-ups and quality handover."],"/trades/plastering-repairs":["Plastering Job Management Software Australia | Titan Zero Field","Coordinate plastering and repair jobs with defect evidence, measurements, drying stages, return visits, materials and quality closeout."],"/trades/tiling-surface-work":["Tiling Job Management Software Australia | Titan Zero Field","Manage tiling work with measurements, substrate readiness, materials, preparation, staged installation, field evidence and sign-off."],"/trades/pressure-exterior-cleaning":["Pressure Cleaning Software Australia | Titan Zero Field","Run pressure and exterior cleaning jobs with access, surfaces, equipment, weather, routing, before-and-after evidence and recurring work."],"/trades/rental-strata-maintenance":["Rental & Strata Maintenance Software Australia | Titan Zero Field","Coordinate rental and strata maintenance with properties, approvals, access, scheduling, work orders, field evidence and stakeholder handover."],"/trades/equipment-appliance-repair":["Equipment Repair Management Software Australia | Titan Zero Field","Track repair jobs with asset history, diagnosis, parts readiness, approvals, return visits, field evidence and service history."],"/suite":["Titan Zero Suite | Build, Desk, Field & Pay","Titan Zero connects Build, Desk, Field and Pay. This site focuses on Field, the operational delivery system for field-service work."],"/integrations":["Field Service Software Integrations | Titan Zero Field","Connect Field with maps, routing, weather, supplier workflows, model providers, notifications, APIs and Desk/Pay handoffs."],"/security":["Field Service Automation Controls | Titan Zero Field","See how Titan Zero Field handles capability-level authority, offline safety, evidence provenance, conflict handling and operational recovery."],"/onboarding":["Field Service Software Onboarding | Titan Zero Field","Configure workers, skills, scheduling, Titan Go, materials, equipment, Standards, evidence, quality and authority around your operation."],"/faq":["Titan Zero Field FAQ | Field Service Software","Answers about Titan Zero Field, Titan Go, Titan Standards, offline operation, autonomy, pricing, integrations and the wider Titan Zero suite."],"/sovereign":["Private Field Service Software Deployment | Titan Sovereign","Explore a private Titan Zero Field deployment with dedicated infrastructure, company-isolated storage, BYO models, backups and privacy controls."],"/contact":["Contact Titan Zero Field | Field Service Software","Contact Titan Zero Field about product fit, pricing, onboarding, integrations, workforce, Titan Go, Standards or private deployment."],"/why-field":["Why Titan Zero Field | Field Service Management","See why Titan Zero Field goes beyond job scheduling with readiness, dispatch recovery, offline execution, evidence, quality and Standards."],"/about":["About Titan Zero Field | Field Service Software","Titan Zero Field is the delivery app in the Titan Zero suite, built for jobs, scheduling, dispatch, field execution, quality and operational intelligence."]};







const IMAGE_DIMS={"/assets/staff-supply_specialist.webp":[1122,1402],"/assets/staff-maintenance_worker.webp":[1080,1350],"/assets/staff-assignment_worker.webp":[1080,1350],"/assets/staff-equipment_worker.webp":[1080,1350],"/assets/staff-evidence_worker.webp":[1080,1350],"/assets/workforce-supply-v31.webp":[1672,941],"/assets/staff-audit_worker.webp":[1080,1350],"/assets/staff-variation_worker.webp":[1080,1350],"/assets/field-number-08.webp":[360,357],"/assets/staff-workforce_specialist.webp":[1080,1350],"/assets/staff-scheduling_specialist.webp":[1122,1402],"/assets/page-pricing-v30.webp":[1536,689],"/assets/staff-dispatch_worker.webp":[1080,1350],"/assets/staff-access_worker.webp":[1080,1350],"/assets/field-bg-map-v26.webp":[1672,941],"/assets/staff-supplier_order_worker.webp":[1080,1350],"/assets/staff-operations_manager.webp":[1122,1402],"/assets/staff-weather_recovery_worker.webp":[1080,1350],"/assets/page-contact-v30.webp":[1536,689],"/assets/field-number-01.webp":[355,360],"/assets/workforce-ops-bg-v31.webp":[1672,941],"/assets/page-titan-go-v30.webp":[1536,689],"/assets/workforce-quality-v31.webp":[1672,941],"/assets/staff-checklist_worker.webp":[1080,1350],"/assets/field-hero-v26.webp":[1916,821],"/assets/field-number-07.webp":[360,357],"/assets/staff-maintenance_specialist.webp":[1080,1350],"/assets/staff-inventory_worker.webp":[1080,1350],"/assets/field-ui-mobile-details.webp":[900,2033],"/assets/staff-standards_specialist.webp":[1122,1402],"/assets/field-photo-dispatch.webp":[1672,941],"/assets/staff-field_support_specialist.webp":[1122,1402],"/assets/staff-materials_worker.webp":[1080,1350],"/assets/field-workforce.webp":[1448,1086],"/assets/staff-compliance_specialist.webp":[1080,1350],"/assets/field-number-03.webp":[360,352],"/assets/staff-route_worker.webp":[1080,1350],"/assets/field-number-06.webp":[360,355],"/assets/staff-notification_worker.webp":[1080,1350],"/assets/staff-quality_specialist.webp":[1122,1402],"/assets/staff-evidence_specialist.webp":[1080,1350],"/assets/page-trades-v30.webp":[1536,689],"/assets/workforce-standards-v31.webp":[1672,941],"/assets/staff-training_worker.webp":[1080,1350],"/assets/field-photo-road.webp":[1200,958],"/assets/field-standards-v26.webp":[1916,821],"/assets/staff-quality_worker.webp":[1080,1350],"/assets/staff-job_specialist.webp":[1080,1350],"/assets/field-ui-mobile-jobs.webp":[900,1830],"/assets/staff-routing_specialist.webp":[1080,1350],"/assets/field-photo-evidence.webp":[1672,941],"/assets/staff-training_specialist.webp":[1080,1350],"/assets/staff-equipment_specialist.webp":[1080,1350],"/assets/field-dashboard-v26.webp":[1448,1086],"/assets/field-number-05.webp":[360,353],"/assets/field-number-02.webp":[357,360],"/assets/workforce-hero-v31.webp":[1672,941],"/assets/page-standards-v30.webp":[1536,689],"/assets/titan-go-showcase-v31.webp":[1672,941],"/assets/page-security-v30.webp":[1536,689],"/assets/workforce-team-overview-v31.webp":[1672,941],"/assets/field-bg-van-v26.webp":[1672,941],"/assets/field-schedule-v26.webp":[1916,821],"/assets/staff-safety_worker.webp":[1080,1350],"/assets/staff-safety_specialist.webp":[1080,1350],"/assets/workforce-coordination-v31.webp":[1672,941],"/assets/field-footer-strip.webp":[2200,124],"/assets/field-logo-wide.webp":[2400,680],"/assets/staff-scheduling_worker.webp":[1080,1350],"/assets/page-features-v30.webp":[1536,689],"/assets/staff-continuous_improvement_specialist.webp":[1080,1350],"/assets/field-ui-mobile-evidence.webp":[900,2059],"/assets/page-onboarding-v30.webp":[1536,689],"/assets/staff-gap_fill_worker.webp":[1080,1350],"/assets/staff-capacity_specialist.webp":[1080,1350],"/assets/staff-predictive_operations_specialist.webp":[1080,1350],"/assets/staff-service_report_worker.webp":[1080,1350],"/assets/field-number-04.webp":[360,352],"/assets/page-home-v30.webp":[1536,689],"/assets/page-workforce-v30.webp":[1536,689],"/assets/staff-dispatch_specialist.webp":[1122,1402],"/assets/staff-materials_specialist.webp":[1122,1402],"/assets/staff-audit_specialist.webp":[1080,1350],"/assets/field-og.webp":[1200,630],"/assets/field-ui-mobile-zero.webp":[900,2033],"/assets/staff-operations_analytics_specialist.webp":[1122,1402],"/assets/staff-inventory_specialist.webp":[1080,1350],"/assets/staff-visual_review_worker.webp":[1080,1350]};
function addImageDimensions(html){
 return String(html??'').replace(/<img\b[^>]*>/gi,tag=>{
  const m=tag.match(/\bsrc="([^"]+)"/i); if(!m)return tag;
  const d=IMAGE_DIMS[m[1]]; if(!d)return tag;
  let out=tag;
  if(!/\bwidth="/i.test(out))out=out.replace(/^<img\b/i,`<img width="${d[0]}"`);
  if(!/\bheight="/i.test(out))out=out.replace(/^<img\b/i,`<img height="${d[1]}"`);
  if(!/\bdecoding="/i.test(out))out=out.replace(/^<img\b/i,'<img decoding="async"');
  return out;
 });
}
function sanitizeHtml(html){
 const cleaned=String(html??'').replace(/>\s*(undefined|null)\s*</gi,'><').replace(/\bundefined\b/gi,'').replace(/\bnull\b/gi,'');
 return addImageDimensions(cleaned);
}
const NOINDEX_ROUTES=new Set(['/suite']);
const canonicalRouteMap={"/field":"/","/platform":"/","/operations":"/","/field-workforce":"/workforce","/operations-workforce":"/workforce","/ai-workforce":"/workforce","/build":"/suite","/desk":"/suite","/pay":"/suite","/front-office":"/suite","/zero":"/suite","/core":"/suite","/owner-operations":"/"};
function render(){
 const raw=location.pathname||'/';
 const path=raw.length>1?raw.replace(/\/+$/,''):raw;
 const isKnown=Boolean(routes[path]);
 const fn=routes[path]||notFound;
 document.getElementById('app').innerHTML=sanitizeHtml(fn());
 wire();
 const canonicalPath=canonicalRouteMap[path]||path;
 const m=routeMeta[path]||routeMeta[canonicalPath]||['Page not found | Titan Zero Field','The requested Titan Zero Field page could not be found.'];
 const canonicalUrl='https://field.titanzero.io'+(canonicalPath==='/'?'/':canonicalPath);
 document.title=m[0];
 const set=(sel,attr,value)=>{const el=document.querySelector(sel);if(el)el.setAttribute(attr,value)};
 set('meta[name="description"]','content',m[1]);
 const robotsValue=!isKnown?'noindex,follow':(NOINDEX_ROUTES.has(canonicalPath)?'noindex,follow':'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1');
 set('meta[name="robots"]','content',robotsValue);
 set('link[rel="canonical"]','href',canonicalUrl);
 set('link[rel="alternate"][hreflang="en-AU"]','href',canonicalUrl);
 set('link[rel="alternate"][hreflang="x-default"]','href',canonicalUrl);
 set('meta[property="og:url"]','content',canonicalUrl);
 set('meta[property="og:title"]','content',m[0]);
 set('meta[property="og:description"]','content',m[1]);
 set('meta[name="twitter:title"]','content',m[0]);
 set('meta[name="twitter:description"]','content',m[1]);
 const hash=location.hash;
 if(hash){requestAnimationFrame(()=>document.querySelector(hash)?.scrollIntoView({block:'start'}));}
 else{scrollTo(0,0);}
}

function wire(){
 document.querySelectorAll('[data-link]').forEach(a=>a.addEventListener('click',e=>{
  if(a.origin===location.origin){
   e.preventDefault();
   history.pushState({},'',a.pathname+(a.search||'')+(a.hash||''));
   render();
  }
 }));
 const menu=document.getElementById('menu');
 const links=document.getElementById('navlinks');
 const setMenu=open=>{
  if(!menu||!links)return;
  links.classList.toggle('menuopen',open);
  menu.setAttribute('aria-expanded',String(open));
  menu.setAttribute('aria-label',open?'Close menu':'Open menu');
  menu.textContent=open?'×':'☰';
 };
 menu?.addEventListener('click',()=>setMenu(!links?.classList.contains('menuopen')));
 document.onkeydown=e=>{if(e.key==='Escape')setMenu(false)};
}

addEventListener('popstate',render);
wire();
