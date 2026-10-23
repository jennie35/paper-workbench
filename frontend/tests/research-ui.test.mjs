import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {synthesisHtml,hasReportContent} from '../research-view.js';
import {paperIdsForBatch,activeStatuses} from '../results.js';
const code=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function extract(start,end){const a=code.indexOf(start),b=code.indexOf(end,a);assert.ok(a>=0&&b>a);return code.slice(a,b);}
const element=value=>({value:value||'',innerHTML:'',addEventListener(){},querySelectorAll:()=>[],classList:{add(){},toggle(){}},setAttribute(){}});

test('project configuration captures known conditions without substituting paper resources or making a schedule',()=>{
  const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,element());return fields.get(id);};
  $('scopeCount').value='3';$('scopeStage').value='validation';$('scopeRunMode').value='existing-task';$('scopeLanguage').value='zh-CN';$('scopeMethods').value='Existing measurement system';$('scopeResources').value='';$('scopeConstraints').value='No additional instrument budget';$('scopeKeywords').value='测量,独立重复,measurement\nrepeatability';
  const context=vm.createContext({$});vm.runInContext(extract('function readResearchConfigFields(){','function modalError('),context);
  const result=context.readResearchConfigFields();assert.equal(result.default_count,3);assert.equal(result.known_resources,'');assert.equal(result.constraints,'No additional instrument budget');assert.equal(result.run_mode,'existing-task');assert.deepEqual(Array.from(result.keywords_en),['measurement','repeatability']);
  $('scopeCount').value='21';assert.throws(()=>context.readResearchConfigFields(),/1–20/);
});

test('synthesis is absent from the page while its stored records remain intact',()=>{
  const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,element());return fields.get(id);};
  const job={id:'job',status:'completed',checkpoint:{synthesis:{status:'completed',record_ids:['D001'],supports:[],priority_actions:[],limitations:['Only one actual report']}}};
  const context=vm.createContext({state:{demo:false},$,selectedBatch:()=>job,activeStatuses,esc:String,badge:String,synthesisHtml,synthesisForm(){},showResearchBrief(){},api(){throw new Error('Rendering must never call API');}});
  vm.runInContext(extract('function renderSynthesis(){','function synthesisForm('),context);context.renderSynthesis();assert.equal($('researchSynthesis').innerHTML,'');assert.equal($('researchSynthesis').hidden,true);assert.equal(job.checkpoint.synthesis.limitations[0],'Only one actual report');
});

test('opening synthesis confirmation never launches a model until explicitly confirmed',()=>{
  const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,element());return fields.get(id);};let body='';
  const job={id:'job',status:'completed'},context=vm.createContext({state:{jobs:[job],settings:{}},$,requireService:()=>true,activeStatuses,showModal:(label,html)=>body=html,configurationComplete:()=>false,modalContext:()=>()=>true,busy:handler=>handler,closeModal(){},toast(){},api(){throw new Error('No paid request on opening');}});
  vm.runInContext(extract('function synthesisForm(','function briefMarkdown('),context);context.synthesisForm('job');assert.match(body,/可能产生用量/);assert.match(body,/不新增论文/);assert.equal(typeof $('confirmSynthesis').onclick,'function');
});

test('unfinished syntheses never render an empty warning or decision section',()=>{
  for(const status of ['partial','insufficient_evidence','unavailable']){
    const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,element());return fields.get(id);};
    const job={id:'job',status:'completed',checkpoint:{synthesis:{status,limitations:['Original evidence missing'],judgement_changes:[{record_ids:['D001'],after:'Check statistical unit first'}]}}};
    const context=vm.createContext({state:{demo:false},$,selectedBatch:()=>job,activeStatuses,esc:String,badge:String,synthesisHtml,synthesisForm(){},showResearchBrief(){}});
    vm.runInContext(extract('function renderSynthesis(){','function synthesisForm('),context);context.renderSynthesis();assert.equal($('researchSynthesis').innerHTML,'');assert.equal($('researchSynthesis').hidden,true);assert.equal(job.checkpoint.synthesis.judgement_changes[0].after,'Check statistical unit first');
  }
});

test('research conditions contain each search field once and resources remain optional',()=>{
  const context=vm.createContext({state:{mode:'direct',demo:false,settings:{}},esc:String,field:(label,id)=>`<input id="${id}">${label}`,area:(label,id)=>`<textarea id="${id}">${label}`,choice:(label,id)=>`<select id="${id}">${label}`});
  vm.runInContext(extract('function researchConfigFields(scope)','function readResearchConfigFields()'),context);
  const html=context.researchConfigFields({default_count:5,keywords:['topic']});
  for(const id of ['scopeQuestion','scopeKeywords','scopeInclude','scopeExclude'])assert.equal((html.match(new RegExp(`id="${id}"`,'g'))||[]).length,1,id);
  assert.match(html,/留空不会阻止检索/);assert.match(html,/课题定时任务/);assert.match(html,/需要私人后台/);assert.doesNotMatch(html,/id="saveSchedule"/);
  assert.doesNotMatch(html,/id="scopeKeywordsZh"|id="scopeKeywordsEn"/);assert.match(html,/本次检索依据/);
  assert.match(html,/<details class="research-optional"><summary>选填：已有方法、资源与约束<\/summary>/);
  assert.match(html,/<details class="research-optional">[\s\S]*id="scopeResources"[\s\S]*id="scopeVersions"[\s\S]*<\/details>/);
});

test('scope summary combines only actual question, search terms and inclusion rules',()=>{
  const context=vm.createContext({esc:String});vm.runInContext(extract('function scopeSummaryHtml(','function bindScopeSummary('),context);
  const html=context.scopeSummaryHtml({research_question:'Which process changes accuracy?',keywords:['measurement'],keywords_zh:['测量'],include:'Physical experiments',exclude:'Simulation only',known_resources:''});assert.match(html,/Which process changes accuracy/);assert.match(html,/measurement · 测量/);assert.match(html,/Physical experiments/);assert.match(html,/Simulation only/);assert.doesNotMatch(html,/未报告|仪器|预算/);
});

test('schedule controls read configuration but save only on explicit button click',async()=>{
  const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,element());return fields.get(id);},calls=[];
  $('scopeCount').value='5';
  const original={enabled:false,time:'09:00',timezone:'Asia/Shanghai',target_count:5,next_run_at:null};
  const context=vm.createContext({state:{mode:'backend',demo:false},$,busy:handler=>handler,jsonBody:JSON.stringify,api:async(path,options={})=>{calls.push({path,...options});return options.method==='PUT'?{...JSON.parse(options.body),next_run_at:'2026-10-24T01:00:00Z'}:original;}});
  vm.runInContext(extract('function scheduleDescription(','function readResearchConfigFields()'),context);
  await context.bindSchedule('topic',()=>true);assert.equal(calls.length,1);assert.equal(calls[0].method,undefined);
  $('scheduleEnabled').checked=true;$('scheduleTime').value='08:30';$('scopeCount').value='3';assert.equal(calls.length,1);
  await $('saveSchedule').onclick();assert.equal(calls.length,2);assert.equal(calls[1].method,'PUT');assert.deepEqual(JSON.parse(calls[1].body),{enabled:true,time:'08:30',timezone:'Asia/Shanghai',target_count:3});assert.match($('scheduleStatus').textContent,/下次运行/);
});

test('direct schedule panel never attempts backend reads or creates browser timers',async()=>{
  const context=vm.createContext({state:{mode:'direct',demo:false},$(){throw new Error('No server controls in direct mode');},api(){throw new Error('No schedule API in direct mode');},setInterval(){throw new Error('Do not pretend a browser timer is a server schedule');}});
  vm.runInContext(extract('async function bindSchedule(','function readResearchConfigFields()'),context);
  await context.bindSchedule('topic',()=>true);
});

test('bulk retrieval and history sections stay empty without deleting records',()=>{
  const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,element());return fields.get(id);};
  const state={jobs:[{id:'job',checkpoint:{candidates:Array.from({length:160},(_,i)=>({title:'Paper '+i}))}}]};
  const context=vm.createContext({state,$});
  vm.runInContext(extract('function renderCandidates(){','function showBatchMaterials('),context);vm.runInContext(extract('function renderBatchHistory(){','function synthesisForm('),context);
  context.renderCandidates();context.renderBatchHistory();for(const id of ['candidatePanel','batchHistoryPanel']){assert.equal($(id).hidden,true);assert.equal($(id).innerHTML,'');}assert.equal(state.jobs[0].checkpoint.candidates.length,160);
});

test('focused source supplement shows only the requested papers and one detail at a time',()=>{
  const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,element('0'));return fields.get(id);};let markup='';
  const job={id:'job',requested:5,status:'waiting_sources',checkpoint:{candidates:Array.from({length:160},(_,i)=>({title:'Paper '+i,status:'no_fulltext'}))}};
  const context=vm.createContext({state:{jobs:[job]},$,needsEvidence:new Set(['no_fulltext']),activeStatuses,esc:String,showModal:(label,body)=>markup=body,candidateCard:(j,item)=>item.title,bindResultActions(){},bindUploads(){},closeModal(){}});
  vm.runInContext(extract('function showBatchMaterials(','function candidateCard('),context);context.showBatchMaterials('job');assert.equal((markup.match(/<option /g)||[]).length,5);assert.doesNotMatch(markup,/Paper 5<|160/);assert.equal($('materialContent').innerHTML,'Paper 0');assert.equal(job.checkpoint.candidates.length,160);
});

test('zero reports explain acquisition trouble without exposing retrieval dumps',()=>{
  const context=vm.createContext({esc:String});vm.runInContext(extract('function searchDiagnosisHtml(','function renderBatchSummary('),context);
  const html=context.searchDiagnosisHtml({checkpoint:{search_diagnosis:{relevant:8,fulltext_unavailable:8,next_steps:['继续寻找开放全文','可补充合法取得的 PDF'],source_errors:[]}}});assert.match(html,/已找到 8 篇相关论文/);assert.match(html,/未取得可读正文/);assert.match(html,/继续寻找开放全文/);assert.doesNotMatch(html,/缺额|160 条|检索记录/);
});

test('backend discovery diagnosis shows its actual relevant candidate count',()=>{
  const context=vm.createContext({esc:String});vm.runInContext(extract('function searchDiagnosisHtml(','function renderBatchSummary('),context);
  const html=context.searchDiagnosisHtml({checkpoint:{search_diagnosis:{relevant_candidates:7,fulltext_unavailable:5,analysis_pending:2,next_steps:[],source_errors:[]}}});
  assert.match(html,/已找到 7 篇相关论文/);assert.match(html,/5 篇暂未取得可读正文/);assert.match(html,/2 篇尚待完成分析/);
});

test('research brief counts new reports separately from reused and verified records',()=>{
  const job={id:'batch',requested:5,created_at:'2026-10-21T02:00:00Z',checkpoint:{reused:['D001'],completed:[],synthesis:{priority_actions:[]}}};
  const papers=[{id:'D001',batch_id:'old',title:'Reused source',analysis:{summary:'Existing',verified:false}},{id:'D002',batch_id:'batch',title:'New source',doi:'10.5555/test',analysis:{summary:'New actual report',verified:false,reading_list:['Methods'],verification_gaps:['No original figures']}}];
  const context=vm.createContext({state:{project:{name:'Configured topic'},mode:'direct'},hasReportContent,paperIdsForBatch,reportRecords:()=>papers,batchLabel:()=> 'B002',displayAnalysis:a=>({...a,reading_list:a.reading_list||[],verification_gaps:a.verification_gaps||[]})});
  vm.runInContext(extract('function briefMarkdown(','function showResearchBrief('),context);const brief=context.briefMarkdown(job);assert.match(brief,/新增研究报告 1 篇/);assert.match(brief,/完成模型全文核验 0 篇/);assert.match(brief,/课题累计 2 篇/);assert.match(brief,/目标新增 5 篇；实际新增 1 篇/);assert.doesNotMatch(brief,/复用|缺额|研究启示：未记录/);assert.match(brief,/10.5555\/test/);assert.doesNotMatch(brief,/D001 · Reused source/);
});
