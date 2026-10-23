import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {apiOrigin} from '../workflow.js';
import {reportSections,hasReportContent,referenceValue,verifiedOriginals} from '../research-view.js';
import {diagramStyle} from '../research-diagrams.js';

const code=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function extract(start,end){
  const first=code.indexOf(start),last=code.indexOf(end,first);
  assert.ok(first>=0&&last>first,`Missing UI function boundary: ${start}`);
  return code.slice(first,last);
}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

test('connection entry defaults to private backend while explicit direct mode remains available',()=>{
  const calls=[];
  const context=vm.createContext({addPaperSourceControl(){},directConnectionForm:options=>calls.push(['direct',options]),backendConnectionForm:options=>calls.push(['backend',options])});
  vm.runInContext(extract('function connectionForm(','function directConnectionForm('),context);
  const resume=()=>{};
  context.connectionForm();context.connectionForm({continueToBatch:true,onConnected:resume});context.connectionForm({mode:'direct',onConnected:resume});
  assert.deepEqual(calls.map(x=>x[0]),['backend','backend','direct']);
  assert.equal(calls[1][1].continueToBatch,true);assert.equal(calls[1][1].onConnected,resume);assert.equal(calls[2][1].onConnected,resume);
});

test('direct UI API calls cannot send the private-backend Bearer token or fetch its address',async()=>{
  const state={mode:'direct',demo:false,base:'https://synthetic-private-backend.invalid',token:'SYNTHETIC-BACKEND-TOKEN'},calls=[];
  const context=vm.createContext({addPaperSourceControl(){},state,directApi:{handle:async(path,options)=>{calls.push({path,options});return {local:true};}},fetch(){throw new Error('Direct API must not fetch the private backend');},FormData:class{}});
  vm.runInContext(extract('async function api(','function apiErrorMessage('),context);
  const options={method:'POST',body:'{"name":"Synthetic topic"}'};
  const response=await context.api('/api/projects',options);
  assert.equal(response.local,true);assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/projects');assert.equal(calls[0].options,options);
  assert.equal(calls[0].options.headers,undefined);assert.equal(state.token,'SYNTHETIC-BACKEND-TOKEN');
});

test('explicit backend mode keeps authenticated backend requests working',async()=>{
  const state={mode:'backend',demo:false,base:'https://synthetic-private-backend.invalid',token:'SYNTHETIC-BACKEND-TOKEN'},calls=[];
  const context=vm.createContext({addPaperSourceControl(){},state,FormData:class{},directApi:{handle(){throw new Error('Backend mode must not use the browser library');}},fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({backend:true})};}});
  vm.runInContext(extract('async function api(','function apiErrorMessage('),context);
  assert.equal((await context.api('/api/projects')).backend,true);
  assert.equal(calls[0].url,'https://synthetic-private-backend.invalid/api/projects');assert.equal(calls[0].options.headers.Authorization,'Bearer SYNTHETIC-BACKEND-TOKEN');
});

test('direct settings opened from home stays in API settings and forwards continuation',()=>{
  const resume=()=>{},calls=[];
  const context=vm.createContext({addPaperSourceControl(){},state:{mode:'direct',demo:false,nav:'home'},directConnectionForm:options=>calls.push(options),requireService(){throw new Error('Direct settings must not open backend login');}});
  vm.runInContext(extract('function settingsForm(','function batchForm('),context);
  context.settingsForm({continueToBatch:true,onComplete:resume});
  assert.equal(calls.length,1);assert.equal(calls[0].continueToBatch,true);assert.equal(calls[0].onConnected,resume);
});

function readerContext(){
  const state={mode:'direct',demo:false,view:'latest',papers:[],jobs:[]},display=[],assets=[];
  const exportButton={addEventListener(){}},context=vm.createContext({addPaperSourceControl(){},state,esc,reportSections,hasReportContent,referenceValue,verifiedOriginals,diagramStyle,watermark:'Analysis performed using the norman-paper-reading skill | APPLIED-SIGNATURE',badge:label=>`<span>${esc(label)}</span>`,publicationLink:()=>'',tags:()=>[],showModal:(title,body)=>display.push({title,body}),renderMath(){},loadReaderAssets:async path=>assets.push(path),$:id=>id==='exportCandidate'?exportButton:null});
  vm.runInContext(extract('function reportLabel(','function badge('),context);
  vm.runInContext(extract('function section(','function renderMath('),context);
  vm.runInContext(extract('async function showPaper(','async function showCandidate('),context);
  return {state,context,display,assets};
}
function paper(){return {id:'D001',title:'Synthetic abstract-only research',doi:'10.1234/synthetic',year:2026,authors:['A Synthetic Author'],publication_status:'published',analysis:{verified:false,skill_applied:false,summary:'Generated fixture abstract analysis.',scientific_question:'Fixture question?',flow_steps:[],actions:[],evidence:[],sources:['Crossref abstract'],verification_status:'摘要草稿；全文、原图、公式均未核验。',verification_gaps:['未取得全文']}};}

test('direct draft reader discloses missing full text without claiming Norman was applied',()=>{
  const {context}=readerContext(),markup=context.readingBody(paper(),{draft:true});
  assert.match(markup,/摘要研究报告/);assert.match(markup,/未执行 norman-paper-reading 外部技能/);assert.match(markup,/阅读依据/);assert.match(markup,/摘要草稿；全文、原图、公式均未核验/);
  assert.doesNotMatch(markup,/APPLIED-SIGNATURE|Analysis performed using|分析采用 norman-paper-reading 技能|>已模型核验<|>已完成精读</);
  assert.doesNotMatch(markup,/下载已获取的全文 PDF/);
});

test('opening a D-number record always uses draft reading even if a stale verified flag is present',async()=>{
  const {state,context,display}=readerContext(),draft=paper();draft.analysis.verified=true;state.papers=[draft];
  await context.showPaper('D001');
  assert.equal(display.length,1);assert.match(display[0].body,/摘要研究报告/);assert.match(display[0].body,/原图及公式未视觉核验/);assert.match(display[0].body,/摘要草稿；全文、原图、公式均未核验/);
  assert.doesNotMatch(display[0].body,/APPLIED-SIGNATURE|Analysis performed using|分析采用 norman-paper-reading 技能|>已模型核验<|>已完成精读</);
  assert.equal(state.papers[0].id,'D001');
});

test('D-number paper cards lead to an honestly labelled report without claiming visual verification',()=>{
  const {context}=readerContext();
  vm.runInContext(extract('function paperCard(','function section('),context);
  const p=paper();p.analysis.verified=true;const markup=context.paperCard(p);
  assert.match(markup,/D001/);assert.match(markup,/摘要研究报告/);assert.match(markup,/查看详细分析/);assert.match(markup,/data-open-paper="D001"/);
  assert.doesNotMatch(markup,/进入精读与研究规划|>已模型核验<|>已完成精读</);
});

test('partial reports with invalid optional arrays remain readable without mutating saved evidence',()=>{
  const {context}=readerContext(),p=paper();
  p.analysis={...p.analysis,flow_steps:'One supplied step',actions:[null,{title:'Pending action',evidence_ids:'invalid'}],evidence:[null,{claim:'Unverified claim',source_block_ids:null}],visuals:{invalid:true},sources:null};
  const saved=JSON.stringify(p);vm.runInContext(extract('function paperCard(','function section('),context);
  assert.match(context.paperCard(p),/Generated fixture abstract analysis/);assert.match(context.readingBody(p,{draft:true}),/Unverified claim/);assert.equal(JSON.stringify(p),saved);
  context.state.view='evidence';
  for(const priorities of [{invalid:true},[null,{reason:'Check the actual comparator'}]]){
    p.analysis.research_logic={reading_priorities:priorities};
    assert.match(context.paperCard(p),/Generated fixture abstract analysis/);
  }
});

function directConnectionContext(){
  const fields=new Map(),writes=[],state={mode:'backend',demo:true,base:'https://synthetic-backend.invalid',token:'SYNTHETIC-BACKEND-TOKEN'},events=[];
  const $=id=>{if(!fields.has(id))fields.set(id,{value:'',hidden:true,addEventListener(){},dataset:{},classList:{add(){},remove(){}}});return fields.get(id);};
  $('directBase').value='https://models.example/v1';$('directKey').value='SYNTHETIC-DIRECT-KEY';$('directModel').value='fixture-model';
  let visible=true,resolveModels;
  const context=vm.createContext({addPaperSourceControl(){},state,$,esc,apiOrigin,field:()=>'',showModal(){},modalContext:()=>()=>visible,busy:handler=>handler,backendConnectionForm(){},closeModal(){},enterDemo(){},clearInterval(){},render(){},toast(){},batchForm(){},localStorage:{setItem:(key,value)=>writes.push([key,value])},loadWorkspace:async()=>events.push('load-workspace'),directApi:{getSettings:()=>({}),configure:async options=>events.push(['configure',options]),listModels:()=>new Promise(resolve=>{resolveModels=resolve;})}});
  vm.runInContext(extract('function directConnectionForm(','function backendConnectionForm('),context);context.directConnectionForm();
  return {context,state,fields,$,writes,events,close:()=>{visible=false;},resolveModels:models=>resolveModels(models)};
}

test('closing direct settings before model-list results arrive cannot write into another form',async()=>{
  const setup=directConnectionContext(),loading=setup.$('fetchModels').onclick({});setup.close();setup.resolveModels(['fixture-model']);await loading;
  assert.equal(setup.$('directModelChoices').hidden,true);assert.equal(setup.$('directModelChoices').innerHTML,undefined);assert.deepEqual(setup.writes,[]);
});

test('saving a direct connection remembers mode but never writes the supplied key into localStorage',async()=>{
  const setup=directConnectionContext();
  setup.$('directVisionModel').value='fixture-vision-model';
  await setup.$('directConnectForm').onsubmit({preventDefault(){},submitter:setup.$('directConnectSubmit')});
  assert.equal(setup.state.mode,'direct');assert.equal(setup.state.base,'');assert.equal(setup.state.token,'');
  assert.deepEqual(setup.writes,[['pw-mode','direct']]);assert.equal(setup.events[0][0],'configure');assert.equal(setup.events[0][1].api_key,'SYNTHETIC-DIRECT-KEY');assert.equal(setup.events[0][1].vision_model,'fixture-vision-model');assert.equal(setup.events[1],'load-workspace');
});

test('disconnecting direct API clears its memory session while retaining the browser project list',async()=>{
  const state={mode:'direct',demo:false,projects:[{id:'browser-project'}]},events=[],logout={};
  const context=vm.createContext({addPaperSourceControl(){},state,$:id=>{assert.equal(id,'logout');return logout;},directApi:{clearSession:async()=>events.push('clear-key')},loadWorkspace:async()=>events.push('reload-browser-projects'),toast(){},enterDemo(){throw new Error('Disconnecting the key must not replace saved browser projects with demo');}});
  const start=code.indexOf("$('logout').onclick="),end=code.indexOf("$('help').onclick=",start);assert.ok(start>=0&&end>start);
  vm.runInContext(code.slice(start,end),context);await logout.onclick();
  assert.deepEqual(events,['clear-key','reload-browser-projects']);assert.equal(state.projects[0].id,'browser-project');assert.equal(state.demo,false);
});
