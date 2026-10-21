import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {synthesisHtml} from '../research-view.js';
import {paperIdsForBatch,activeStatuses} from '../results.js';
const code=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function extract(start,end){const a=code.indexOf(start),b=code.indexOf(end,a);assert.ok(a>=0&&b>a);return code.slice(a,b);}
const element=value=>({value:value||'',innerHTML:'',addEventListener(){},querySelectorAll:()=>[],classList:{add(){},toggle(){}},setAttribute(){}});

test('project configuration captures known conditions without substituting paper resources or making a schedule',()=>{
  const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,element());return fields.get(id);};
  $('scopeCount').value='3';$('scopeStage').value='validation';$('scopeRunMode').value='existing-task';$('scopeLanguage').value='zh-CN';$('scopeMethods').value='Existing measurement system';$('scopeResources').value='';$('scopeConstraints').value='No additional instrument budget';$('scopeKeywordsZh').value='测量,独立重复';$('scopeKeywordsEn').value='measurement\nrepeatability';
  const context=vm.createContext({$});vm.runInContext(extract('function readResearchConfigFields(){','function modalError('),context);
  const result=context.readResearchConfigFields();assert.equal(result.default_count,3);assert.equal(result.known_resources,'');assert.equal(result.constraints,'No additional instrument budget');assert.equal(result.run_mode,'existing-task');assert.deepEqual(Array.from(result.keywords_en),['measurement','repeatability']);
  $('scopeCount').value='21';assert.throws(()=>context.readResearchConfigFields(),/1–20/);
});

test('synthesis rendering reads stored results without making any paid request',()=>{
  const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,element());return fields.get(id);};
  const job={id:'job',status:'completed',checkpoint:{synthesis:{status:'completed',record_ids:['D001'],supports:[],priority_actions:[],limitations:['Only one actual report']}}};
  const context=vm.createContext({state:{demo:false},$,selectedBatch:()=>job,activeStatuses,esc:String,badge:String,synthesisHtml,synthesisForm(){},showResearchBrief(){},api(){throw new Error('Rendering must never call API');}});
  vm.runInContext(extract('function renderSynthesis(){','function synthesisForm('),context);context.renderSynthesis();assert.match($('researchSynthesis').innerHTML,/Only one actual report/);assert.match($('researchSynthesis').innerHTML,/综合已保存/);assert.equal(typeof $('refreshSynthesis').onclick,'function');
});

test('opening synthesis confirmation never launches a model until explicitly confirmed',()=>{
  const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,element());return fields.get(id);};let body='';
  const job={id:'job',status:'completed'},context=vm.createContext({state:{jobs:[job],settings:{}},$,requireService:()=>true,activeStatuses,showModal:(label,html)=>body=html,configurationComplete:()=>false,modalContext:()=>()=>true,busy:handler=>handler,closeModal(){},toast(){},api(){throw new Error('No paid request on opening');}});
  vm.runInContext(extract('function synthesisForm(','function briefMarkdown('),context);context.synthesisForm('job');assert.match(body,/可能产生用量/);assert.match(body,/不新增论文/);assert.equal(typeof $('confirmSynthesis').onclick,'function');
});

test('partial and insufficient syntheses retain actual comparisons and limitations instead of blank status',()=>{
  for(const status of ['partial','insufficient_evidence','unavailable']){
    const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,element());return fields.get(id);};
    const job={id:'job',status:'completed',checkpoint:{synthesis:{status,limitations:['Original evidence missing'],judgement_changes:[{record_ids:['D001'],after:'Check statistical unit first'}]}}};
    const context=vm.createContext({state:{demo:false},$,selectedBatch:()=>job,activeStatuses,esc:String,badge:String,synthesisHtml,synthesisForm(){},showResearchBrief(){}});
    vm.runInContext(extract('function renderSynthesis(){','function synthesisForm('),context);context.renderSynthesis();assert.match($('researchSynthesis').innerHTML,/Original evidence missing/);assert.match($('researchSynthesis').innerHTML,/Check statistical unit first/);assert.match($('researchSynthesis').innerHTML,/证据不足/);
  }
});

test('research brief counts new reports separately from reused and verified records',()=>{
  const job={id:'batch',requested:5,created_at:'2026-10-21T02:00:00Z',checkpoint:{reused:['D001'],completed:[],synthesis:{priority_actions:[]}}};
  const papers=[{id:'D001',batch_id:'old',title:'Reused source',analysis:{summary:'Existing',verified:false}},{id:'D002',batch_id:'batch',title:'New source',doi:'10.5555/test',analysis:{summary:'New actual report',verified:false,reading_list:['Methods'],verification_gaps:['No original figures']}}];
  const context=vm.createContext({state:{project:{name:'Configured topic'},mode:'direct'},paperIdsForBatch,reportRecords:()=>papers,batchLabel:()=> 'B002',displayAnalysis:a=>({...a,reading_list:a.reading_list||[],verification_gaps:a.verification_gaps||[]})});
  vm.runInContext(extract('function briefMarkdown(','function showResearchBrief('),context);const brief=context.briefMarkdown(job);assert.match(brief,/新增研究报告 1 篇/);assert.match(brief,/完成模型全文核验 0 篇/);assert.match(brief,/课题累计 2 篇/);assert.match(brief,/缺额 4 篇/);assert.match(brief,/10.5555\/test/);assert.match(brief,/No original figures/);assert.doesNotMatch(brief,/D001 · Reused source/);
});
