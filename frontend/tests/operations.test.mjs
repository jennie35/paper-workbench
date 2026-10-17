import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {apiOrigin,configurationComplete} from '../workflow.js';

const code=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const extract=(start,end)=>code.slice(code.indexOf(start),code.indexOf(end,code.indexOf(start)));
function element(value='') {return {value,files:[],dataset:{},addEventListener(){},focus(){},isConnected:true};}
const common={requireService:()=>true,flowProgress:()=>'',field:()=>'',area:()=>'',esc:String,jsonBody:JSON.stringify,showModal(){},resetFilters(){},loadProject:async()=>{},renderWorkflow(){},dateLabel:String};

test('retrying a reference upload after project creation cannot create the project twice',async()=>{
  const fields=Object.fromEntries(['projectName','projectGoal','referencePdf','skipReference','createSubmit','projectForm','formMessage'].map(id=>[id,element()]));
  fields.projectName.value='Synthetic topic';fields.referencePdf.files=[{name:'fixture.pdf',size:100}];
  const state={projects:[]},errors=[];let creations=0,uploads=0,scopeVisits=0;
  const context=vm.createContext({...common,state,$:id=>fields[id],modalContext:()=>()=>true,
    busy:handler=>async event=>{try{await handler(event);}catch(error){errors.push(error.message);}},
    FormData:class{append(){}},scopeForm:()=>scopeVisits++,
    api:async path=>{if(path==='/api/projects'){creations++;return {id:'created',name:'Synthetic topic'};}uploads++;if(uploads===1)throw new Error('Simulated upload failure');return {id:'ref'};},
  });
  vm.runInContext(extract('function newProjectForm(','function scopeForm('),context);context.newProjectForm();
  const event={preventDefault(){},submitter:fields.createSubmit};
  await fields.projectForm.onsubmit(event);
  assert.equal(creations,1);assert.equal(state.projects.length,1);assert.equal(scopeVisits,0);assert.equal(fields.skipReference.hidden,false);assert.match(errors[0],/不会重复新建/);
  await fields.projectForm.onsubmit(event);
  assert.equal(creations,1);assert.equal(uploads,2);assert.equal(scopeVisits,1);
});

function settingsContext({closedAfterSave=false}={}){
  const fields=Object.fromEntries(['modelBase','apiKey','textModel','visionModel','alexKey','sameModel','providerPreset','configStatus','checkStatus','formMessage','saveSettings','checkSetup','continueSettings'].map(id=>[id,element()]));
  fields.modelBase.value='https://api.example.com/v1';fields.textModel.value='new-model';fields.visionModel.value='new-model';fields.sameModel.checked=true;
  const state={base:'https://private.example.com',token:'fixture-token',settings:{configured:true,base_url:'https://api.example.com/v1',text_model:'old-model',vision_model:'old-model',has_api_key:true,preflight:{ready:false}}};
  const events=[];let current=true,server=state.settings;
  const context=vm.createContext({...common,state,$:id=>fields[id],apiOrigin,configurationComplete,modalContext:()=>()=>current,
    providerFormValues:()=>({base_url:fields.modelBase.value,text_model:fields.textModel.value,vision_model:fields.visionModel.value,api_key:'',openalex_key:''}),
    busy:handler=>async event=>handler(event),
    api:async(path,options={})=>{
      events.push((options.method||'GET')+' '+path);
      if(path==='/api/settings'&&options.method==='PUT'){server={...server,...JSON.parse(options.body),has_api_key:true};if(closedAfterSave)current=false;return {saved:true};}
      if(path==='/api/preflight'){events.push('probe:'+server.text_model);server={...server,preflight:{ready:true,checked_at:'2026-10-16T00:00:00Z'}};return {ready:true};}
      return server;
    },
  });
  vm.runInContext(extract('function settingsForm(','function batchForm('),context);context.settingsForm();
  return {fields,state,events};
}

test('save-and-check validates the edited model instead of the previously saved model',async()=>{
  const {fields,state,events}=settingsContext();await fields.checkSetup.onclick({});
  assert.deepEqual(events.slice(0,3),['PUT /api/settings','GET /api/settings','POST /api/preflight']);
  assert.ok(events.includes('probe:new-model'));assert.equal(state.settings.preflight.ready,true);assert.match(fields.formMessage.textContent,/当前保存的配置通过检查/);
});

test('closing a settings form while it saves cannot launch a delayed model check',async()=>{
  const {fields,events}=settingsContext({closedAfterSave:true});await fields.checkSetup.onclick({});
  assert.ok(!events.some(event=>event.includes('/api/preflight')));
});

test('opening resume review never submits the paid retry action',async()=>{
  const state={demo:false,activeJob:null,jobs:[{id:'batch',project_id:'topic',requested:5,checkpoint:{completed:[],candidates:[],scope_snapshot:{research_question:'Original range',keywords:[]}}}],settings:{configured:true,has_api_key:true,base_url:'https://api.example.com',text_model:'text',vision_model:'vision'}};
  const fields={retryCancel:element(),confirmRetry:element()};let calls=0,markup='';
  const context=vm.createContext({...common,state,configurationComplete,$:id=>fields[id],summarizeBatch:()=>({target:5,complete:0,missingFulltext:0,unverified:0}),modalContext:()=>()=>true,closeModal(){},busy:handler=>handler,showModal:(title,body)=>{markup=body;},api:async()=>{calls++;}});
  vm.runInContext(extract('async function retryForm(','function renderProjects('),context);await context.retryForm('batch');
  assert.equal(calls,0);assert.match(markup,/确认恢复整个批次/);assert.match(markup,/继续会产生 API 用量/);assert.equal(typeof fields.confirmRetry.onclick,'function');
});

test('an expired older request cannot clear a newer authenticated session',async()=>{
  const state={base:'https://private.example.com',token:'old-token'};let finish;
  const context=vm.createContext({state,FormData:class{},sessionStorage:{removeItem(){throw new Error('New session must not be removed');}},apiErrorMessage:()=> 'Expired',fetch:()=>new Promise(resolve=>{finish=resolve;})});
  vm.runInContext(extract('async function api(','function apiErrorMessage('),context);
  const request=context.api('/api/projects');state.token='new-token';finish({ok:false,status:401,json:async()=>({detail:'Expired'})});
  await assert.rejects(request,/Expired/);assert.equal(state.token,'new-token');
});

test('a failed private workspace refresh keeps private records and exposes reconnect state',async()=>{
  const state={base:'https://private.example.com',token:'fixture',demo:false,papers:[{id:'R001'}],project:{id:'old-topic'}};let rendered=0;
  const context=vm.createContext({state,api:async()=>{throw new Error('Connection failed');},render:()=>rendered++});
  vm.runInContext(extract('async function loadWorkspace(','async function loadProject('),context);
  await assert.rejects(context.loadWorkspace(),/Connection failed/);
  assert.equal(state.demo,false);assert.equal(state.papers[0].id,'R001');assert.equal(state.offline,'Connection failed');assert.equal(rendered,1);
});

test('failed project switching preserves the prior project and its filters',async()=>{
  const state={base:'https://private.example.com',token:'fixture',demo:false,projects:[{id:'A'},{id:'B'}],project:{id:'A'},papers:[{id:'A-paper'}],jobs:[{id:'A-job'}]};let resets=0;
  const context=vm.createContext({state,api:async()=>{throw new Error('Connection failed');},render(){},closeModal(){},toast(){},resetFilters(){resets++;}});
  vm.runInContext(extract('async function selectProject(','async function openActiveJob('),context);await context.selectProject('B');
  assert.equal(state.project.id,'A');assert.equal(state.papers[0].id,'A-paper');assert.equal(state.jobs[0].id,'A-job');assert.equal(resets,0);assert.equal(state.projectLoading,false);
});

test('a failed project-data refresh cannot mix a new project name with the old project papers',async()=>{
  const state={base:'https://private.example.com',token:'fixture',demo:false,project:{id:'A'},papers:[{id:'A-paper'}],jobs:[{id:'A-job'}]};
  const context=vm.createContext({state,localStorage:{getItem:()=> 'B'},render(){},api:async path=>{
    if(path==='/api/projects')return [{id:'B'}];if(path==='/api/settings')return {};if(path==='/api/workspace/status')return {active_job:null};throw new Error('Project data unavailable');
  }});
  vm.runInContext(extract('async function loadWorkspace(','async function loadProject('),context);await assert.rejects(context.loadWorkspace(),/Project data unavailable/);
  assert.equal(state.project.id,'A');assert.equal(state.papers[0].id,'A-paper');assert.equal(state.jobs[0].id,'A-job');assert.equal(state.demo,false);
});
