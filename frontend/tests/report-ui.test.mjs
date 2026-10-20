import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {activeStatuses,needsEvidence,summarizeBatch,paperIdsForBatch} from '../results.js';
const code=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const extract=(start,end)=>{const a=code.indexOf(start),b=code.indexOf(end,a);assert.ok(a>=0&&b>a);return code.slice(a,b);};
const el=()=>({value:'',dataset:{},hidden:false,classList:{toggle(){}},setAttribute(){},removeAttribute(){},querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){}});

test('application boots against current HTML IDs without removed navigation controls',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),fields=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>[m[1],el()]));
  const context=vm.createContext({document:{getElementById:id=>fields.get(id)||null,querySelectorAll:()=>[]},localStorage:{getItem:()=>null},sessionStorage:{getItem:()=>null},demoProject:{id:'demo',name:'Synthetic topic'},demoPapers:[],activeStatuses,needsEvidence,summarizeBatch,paperIdsForBatch,createBrowserApi:()=>({ready:Promise.resolve()}),setTimeout,clearTimeout});
  assert.doesNotThrow(()=>vm.runInContext(code.replace(/^import .*;\r?\n/gm,''),context));
  assert.equal(fields.get('workspace').hidden,true);
  assert.doesNotMatch(html,/data-nav="jobs"|分析批次与结果|id="projectTabs"/);
});

test('saved candidate analyses become visible report records without duplicating registered papers',()=>{
  const state={papers:[{id:'D001',doi:'10.1234/a',analysis:{summary:'a'}}],jobs:[{id:'first',checkpoint:{candidates:[{paper_id:'D001',doi:'10.1234/a',analysis:{summary:'duplicate'}},{doi:'10.1234/b',analysis:{summary:'b'}},{doi:'10.1234/c'}]}},{id:'second',checkpoint:{candidates:[{doi:'10.1234/d',analysis:{summary:'d'}}]}}]};
  const context=vm.createContext({state});vm.runInContext(extract('function reportRecords(){','function badge('),context);
  const papers=context.reportRecords();assert.equal(papers.length,3);assert.deepEqual(Array.from(papers,p=>p.analysis.summary),['a','b','d']);assert.equal(new Set(papers.map(p=>p.id)).size,3);assert.equal(papers[1]._candidateJob,'first');
});

test('batch labels remain distinct for equal timestamps and identify each stored batch',()=>{
  const state={jobs:[{id:'bbbbbbbb-2',created_at:'2026-10-20T01:00:00Z'},{id:'aaaaaaaa-1',created_at:'2026-10-20T01:00:00Z'}]};
  const context=vm.createContext({state});vm.runInContext(extract('function batchLabel(','function reportLabel('),context);
  assert.match(context.batchLabel(state.jobs[0]),/^B002 · BBBBBBBB$/);assert.match(context.batchLabel(state.jobs[1]),/^B001 · AAAAAAAA$/);
});

test('reused reports stay readable in a batch but do not inflate its new-report count',()=>{
  const job={id:'batch',checkpoint:{reused:['D001'],completed:[]}};
  const context=vm.createContext({paperIdsForBatch,reportRecords:()=>[{id:'D001',batch_id:'old'},{id:'D002',batch_id:'batch'}]});
  vm.runInContext(extract('function batchReportCounts(','function badge('),context);
  const counts=context.batchReportCounts(job);assert.equal(counts.generated,1);assert.equal(counts.reused,1);
});

test('unverified saved reports render in the main report list even with zero verified readings',()=>{
  const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,el());return fields.get(id);};
  const paper={id:'D001',batch_id:'batch',title:'Readable report',analysis:{verified:false,summary:'Actual source summary',actions:[]}};
  const job={id:'batch',checkpoint:{completed:[],reused:[]}},state={papers:[paper],jobs:[job],view:'latest',mode:'direct',demo:false};
  const context=vm.createContext({state,$,esc:String,reportRecords:()=>[paper],renderBatchSummary(){},tags:()=>[],selectedBatch:()=>job,paperIdsForBatch,batchLabel:()=> 'B001',dateLabel:String,activeStatuses,paperCard:p=>`<article>${p.title}</article>`,renderCandidates(){},renderBatchHistory(){},bindResultActions(){},clearFilters(){},batchForm(){}});
  vm.runInContext(extract('function renderPapers(){','function clearFilters('),context);context.renderPapers();
  assert.match($('cards').innerHTML,/Readable report/);assert.doesNotMatch($('cards').innerHTML,/尚无完成全部核验/);assert.match($('resultCount').textContent,/1 篇文献报告/);
});

test('opening project deletion confirmation does not delete anything and blocks active analysis',()=>{
  const state={demo:false,project:{id:'topic',name:'A <topic>'},projects:[{id:'topic',name:'A <topic>'}]},fields=new Map(),calls=[];
  const context=vm.createContext({state,$:id=>{if(!fields.has(id))fields.set(id,el());return fields.get(id);},esc:s=>s.replaceAll('<','&lt;').replaceAll('>','&gt;'),showModal:(title,body)=>calls.push(body),modalContext:()=>()=>true,busy:f=>f,closeModal(){},api(){throw new Error('No mutation before confirmation');},toast:message=>calls.push(message)});
  vm.runInContext(extract('function deleteProjectForm(','function download('),context);context.deleteProjectForm();
  assert.equal(calls.length,1);assert.match(calls[0],/无法撤销/);assert.match(calls[0],/A &lt;topic&gt;/);assert.equal(typeof fields.get('confirmDelete').onclick,'function');
  state.activeJob={project_id:'topic'};context.deleteProjectForm();assert.match(calls[1],/先停止任务/);
});

test('confirmed deletion removes only its project from UI and clears stale selection before reload',async()=>{
  const state={demo:false,project:{id:'A',name:'A'},projects:[{id:'A',name:'A'},{id:'B',name:'B'}],papers:[{id:'D001'}],jobs:[{id:'old'}]},fields=new Map(),calls=[];
  const context=vm.createContext({state,$:id=>{if(!fields.has(id))fields.set(id,el());return fields.get(id);},esc:String,showModal(){},modalContext:()=>()=>true,busy:f=>f,closeModal(){},api:async(path,options)=>calls.push([path,options.method]),toast(){},resetFilters(){},localStorage:{getItem:()=> 'A',removeItem:key=>calls.push(key)},loadWorkspace:async()=>calls.push('reload')});
  vm.runInContext(extract('function deleteProjectForm(','function download('),context);context.deleteProjectForm();await fields.get('confirmDelete').onclick();
  assert.deepEqual(calls,[['/api/projects/A','DELETE'],'pw-project','reload']);assert.equal(state.projects.length,1);assert.equal(state.projects[0].id,'B');assert.equal(state.project,null);assert.equal(state.papers.length,0);assert.equal(state.jobs.length,0);assert.equal(state.nav,'home');
});
