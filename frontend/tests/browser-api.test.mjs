import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserApi as implementation} from '../browser-api.js';

function fakeLocks(){
  const held=new Set(),waiting=new Map();
  return {query:async()=>({held:[...held].map(name=>({name})),pending:[]}),async request(name,options,callback){
    if(typeof options==='function'){callback=options;options={};}
    if(held.has(name)&&options.ifAvailable)return callback(null);
    if(held.has(name))await new Promise(resolve=>{const queue=waiting.get(name)||[];queue.push(resolve);waiting.set(name,queue);});
    held.add(name);try{return await callback({name});}finally{held.delete(name);waiting.get(name)?.shift()?.();}
  }};
}
const testLocks=fakeLocks();
const createBrowserApi=options=>implementation({lockManager:testLocks,...options});

const SECRET='fixture-only-secret-must-not-be-exported';
const config={base_url:'https://models.example/v1',api_key:SECRET,text_model:'fixture-text'};
const copy=value=>JSON.parse(JSON.stringify(value));
function memoryStore(initial=null){let value=initial;return {load:async()=>value&&copy(value),save:async data=>{value=copy(data);},snapshot:()=>copy(value)};}
function response(value,status=200){return {ok:status>=200&&status<300,status,json:async()=>copy(value)};}
const paper=(doi,title,abstract='Actual fixture abstract: method and finding are described here.')=>({DOI:doi,title:[title],abstract,author:[{given:'Ada',family:'Example'}],type:'journal-article','container-title':['Fixture Journal'],published:{'date-parts':[[2026,1,1]]}});
function modelAnswer(value){return response({choices:[{message:{content:JSON.stringify(value)}}]});}
function mockFetch(items,{failAnalysis=0,analysisGate=null}={}){
  const calls=[];let failures=failAnalysis;
  const fetchImpl=async(url,options={})=>{
    calls.push({url:String(url),options});
    if(String(url).startsWith('https://api.crossref.org/works'))return response({message:{items}});
    if(String(url).endsWith('/models'))return response({data:[{id:'fixture-text'},{id:'fixture-text'},{id:'fixture-other'}]});
    const body=JSON.parse(options.body),system=body.messages[0].content,input=JSON.parse(body.messages[1].content);
    if(system.includes('实质相关性筛选'))return modelAnswer({selected:input.candidates.map((_,index)=>({index,reason:'This fixture directly addresses the specified research question.',score:0.95})),excluded:[]});
    if(analysisGate)await analysisGate(options.signal);
    if(failures>0){failures-=1;return response({error:{code:'insufficient_quota',message:'unsafe body '+SECRET}},429);}
    return modelAnswer({summary:'A summary grounded in the supplied abstract.',scientific_question:'A testable question.',verified:true,skill_applied:true,visuals:[{page:1,label:'Invented figure'}],evidence:[{claim:'A limited abstract-level observation.',observation:input.paper?.abstract,source_block_ids:['MADE-UP-FULLTEXT'],limits:'Requires full text.'}],flow_steps:['Read the actual abstract','Obtain full text before checking figures'],actions:[{title:'A proposed pilot study',method:'Compare matched conditions',sample_size_basis:'n = 999 fabricated'}]});
  };
  return {calls,fetchImpl};
}
async function setup(fetchImpl,store=memoryStore()){
  const api=createBrowserApi({store,fetchImpl});await api.configure(config);
  const project=await api.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'Fixture topic',goal:'Test research evidence'})});
  await api.handle(`/api/projects/${project.id}/scope`,{method:'PUT',body:JSON.stringify({research_question:'Fixture research question',keywords:['fixture'],include:'Methods',exclude:'Unrelated',inferred:false})});
  return {api,project,store};
}
async function start(api,project,count=1){return api.handle(`/api/projects/${project.id}/jobs`,{method:'POST',body:JSON.stringify({count})});}
async function settled(api,jid){for(let i=0;i<500;i++){const job=await api.handle(`/api/jobs/${jid}`);if(!['running','queued'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,1));}throw new Error('Fixture job did not finish');}

test('configuration does not call a provider, persists only public settings, and cannot forward a retained key to another origin',async()=>{
  const store=memoryStore(),calls=[];const api=createBrowserApi({store,fetchImpl:async(...args)=>{calls.push(args);return response({});}});
  const saved=await api.configure(config);assert.equal(saved.configured,true);assert.equal(calls.length,0);assert.equal(JSON.stringify(saved).includes(SECRET),false);assert.equal(JSON.stringify(store.snapshot()).includes(SECRET),false);
  await api.configure({...config,api_key:'',text_model:'fixture-other'});
  await assert.rejects(api.configure({...config,base_url:'https://another.example/v1',api_key:''}),/不能沿用旧密钥/);
  api.clearSession();assert.equal(api.hasSession(),false);assert.equal(api.getSettings().base_url,config.base_url);
  const reopened=createBrowserApi({store,fetchImpl:async()=>{throw new Error('Must not call');}});await reopened.ready;assert.equal(reopened.getSettings().text_model,'fixture-other');assert.equal(reopened.getSettings().has_api_key,false);
});

test('unsafe provider URLs are rejected before sending credentials',async()=>{
  const api=createBrowserApi({store:memoryStore(),fetchImpl:async()=>{throw new Error('Should not fetch');}});
  for(const base_url of ['http://models.example/v1','https://localhost/v1','https://127.0.0.1/v1','https://[::1]/v1','https://0x7f000001/v1','https://machine.local/v1','https://user:pass@models.example/v1','https://models.example/v1?key=x','https://models.example/v1#key','https://models.example/v1/chat/completions'])await assert.rejects(api.configure({...config,base_url}));
});

test('reading model names uses only the configured provider and protects secret-free error messages',async()=>{
  const mock=mockFetch([]),api=createBrowserApi({store:memoryStore(),fetchImpl:mock.fetchImpl});await api.configure(config);
  assert.deepEqual(await api.listModels({base_url:config.base_url,api_key:''}),['fixture-text','fixture-other']);assert.equal(mock.calls[0].options.headers.Authorization,'Bearer '+SECRET);assert.equal(mock.calls[0].options.redirect,'error');assert.equal(mock.calls[0].options.credentials,'omit');
  await assert.rejects(api.listModels({base_url:'https://other.example/v1',api_key:''}),/当前供应商/);
  const denied=createBrowserApi({store:memoryStore(),fetchImpl:async()=>response({message:SECRET},401)});await assert.rejects(denied.listModels(config),error=>error.message.includes('401')&&!error.message.includes(SECRET));
});

test('actual abstracts produce unverified drafts, never completed full readings, model-supplied verification and locators are overridden',async()=>{
  const mock=mockFetch([paper('10.1234/actual','A real fixture title')]);const {api,project,store}=await setup(mock.fetchImpl);const queued=await start(api,project);const job=await settled(api,queued.id);
  assert.equal(job.mode,'direct');assert.equal(job.status,'completed');assert.equal(job.drafts_analyzed,1);assert.deepEqual(job.checkpoint.completed,[]);assert.equal(job.checkpoint.draft_shortfall,0);assert.equal(job.checkpoint.candidates[0].status,'unverified');
  const records=await api.handle(`/api/projects/${project.id}/papers`);assert.equal(records.length,1);assert.equal(records[0].id,'D001');const a=records[0].analysis;assert.equal(a.verified,false);assert.equal(a.skill_applied,false);assert.deepEqual(a.visuals,[]);assert.deepEqual(a.evidence[0].source_block_ids,['ABSTRACT-1']);assert.match(a.actions[0].sample_size_basis,/先导实验/);assert.doesNotMatch(a.actions[0].sample_size_basis,/999/);
  const detail=await api.handle(`/api/jobs/${job.id}/candidates/0`);assert.equal(detail.artifacts.pdf_available,false);assert.equal(detail.artifacts.source_available,true);const source=await api.handle(`/api/jobs/${job.id}/candidates/0/source`);assert.equal(source.blocks[0].text,'Actual fixture abstract: method and finding are described here.');
  const svg=await api.handle(`/api/papers/D001/assets/research-flow.svg`,{binary:true});assert.match(await svg.text(),/分析者绘制/);
  for(const call of mock.calls){assert.equal(call.options.redirect,'error');if(call.url.startsWith('https://api.crossref.org'))assert.equal(call.options.headers?.Authorization,undefined);else assert.equal(new URL(call.url).origin,'https://models.example');}
  assert.equal(JSON.stringify(store.snapshot()).includes(SECRET),false);
});

test('no abstract means no model analysis, real shortage, and progressive search ranges',async()=>{
  const mock=mockFetch([paper('10.1234/no-abstract','Title without an abstract','')]);const {api,project}=await setup(mock.fetchImpl);const job=await settled(api,(await start(api,project,5)).id);
  assert.equal(job.drafts_analyzed,0);assert.equal(job.checkpoint.draft_shortfall,5);assert.equal(job.checkpoint.candidates[0].status,'no_fulltext');assert.equal(mock.calls.filter(x=>x.url.endsWith('/chat/completions')).length,0);assert.equal(job.checkpoint.search_log.length,3);assert.match(mock.calls[0].url,/from-pub-date/);assert.equal(new URL(mock.calls.at(-1).url).searchParams.has('filter'),false);
});

test('repeated runs and another project reuse stored drafts without another paid analysis or another draft number',async()=>{
  const mock=mockFetch([paper('10.1234/reuse','Reusable fixture')]);const {api,project,store}=await setup(mock.fetchImpl);await settled(api,(await start(api,project)).id);const paid=mock.calls.filter(x=>x.url.endsWith('/chat/completions')).length;
  const second=await settled(api,(await start(api,project)).id);assert.equal(second.drafts_analyzed,0);assert.deepEqual(second.checkpoint.reused,['D001']);assert.equal(second.checkpoint.draft_shortfall,1);assert.equal(mock.calls.filter(x=>x.url.endsWith('/chat/completions')).length,paid);
  const other=await api.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'Second topic'})});await api.handle(`/api/projects/${other.id}/scope`,{method:'PUT',body:JSON.stringify({research_question:'Related question',inferred:false})});
  const third=await settled(api,(await start(api,other)).id);assert.deepEqual(third.checkpoint.reused,['D001']);assert.equal((await api.handle(`/api/projects/${other.id}/papers`))[0].id,'D001');assert.equal(store.snapshot().counter,1);assert.equal(mock.calls.filter(x=>x.url.endsWith('/chat/completions')).length,paid);
});

test('failed analysis preserves pending candidate and resumes only unfinished work',async()=>{
  const mock=mockFetch([paper('10.1234/retry','Retry fixture')],{failAnalysis:1});const {api,project}=await setup(mock.fetchImpl);const first=await settled(api,(await start(api,project)).id);
  assert.equal(first.status,'failed');assert.match(first.error,/余额不足/);assert.equal(first.error.includes(SECRET),false);assert.equal(first.checkpoint.candidates[0].status,'pending');
  const resumed=await api.handle(`/api/jobs/${first.id}/retry`,{method:'POST'});assert.equal(resumed.id,first.id);const final=await settled(api,first.id);assert.equal(final.status,'completed');assert.equal(final.drafts_analyzed,1);assert.equal((await api.handle(`/api/projects/${project.id}/papers`)).length,1);assert.deepEqual(final.checkpoint.completed,[]);
});

test('cancellation aborts an in-flight model request and does not register its unfinished analysis',async()=>{
  let startedResolve;const started=new Promise(resolve=>{startedResolve=resolve;});
  const mock=mockFetch([paper('10.1234/cancel','Cancellation fixture')],{analysisGate:signal=>new Promise((resolve,reject)=>{startedResolve();signal.addEventListener('abort',()=>reject(Object.assign(new Error('Stopped'),{name:'AbortError'})),{once:true});})});
  const {api,project}=await setup(mock.fetchImpl);const job=await start(api,project);await started;
  await assert.rejects(start(api,project),/已有/);await api.handle(`/api/jobs/${job.id}/cancel`,{method:'POST'});const final=await settled(api,job.id);assert.equal(final.status,'cancelled');assert.equal(final.drafts_analyzed,0);assert.deepEqual(await api.handle(`/api/projects/${project.id}/papers`),[]);assert.equal(final.checkpoint.candidates.length,1);
});

test('opening an interrupted browser workspace marks jobs recoverable without an automatic paid call',async()=>{
  const store=memoryStore({version:1,projects:[],papers:[],links:[],counter:0,jobs:[{id:'orphan',status:'running',stage:'摘要分析',checkpoint:{candidates:[],completed:[]}}]});let calls=0;
  const api=createBrowserApi({store,fetchImpl:async()=>{calls++;throw new Error('Must not call');}});await api.ready;const job=await api.handle('/api/jobs/orphan');assert.equal(job.status,'failed');assert.match(job.error,/手动继续/);assert.equal(calls,0);
});

test('JSON, Markdown and offline HTML exports share the same draft record and never include API credentials',async()=>{
  const mock=mockFetch([paper('10.1234/export','<script>unsafe</script> Export fixture')]);const {api,project}=await setup(mock.fetchImpl);await settled(api,(await start(api,project)).id);
  for(const kind of ['json','markdown','html']){const blob=await api.handle(`/api/projects/${project.id}/export?kind=${kind}`,{binary:true}),content=await blob.text();assert.equal(content.includes(SECRET),false);assert.equal(content.includes('api_key'),false);assert.match(content,/summary|摘要|总结/);if(kind==='json'){const bundle=JSON.parse(content);assert.equal(bundle.papers[0].analysis.verified,false);assert.equal(bundle.project.name,'Fixture topic');assert.equal(bundle.jobs[0].checkpoint.candidates.length,1);}if(kind==='html'){assert.equal(blob.type,'text/html;charset=utf-8');assert.doesNotMatch(content,/<script>/);assert.match(content,/未执行外部技能/);}}
  await assert.rejects(api.handle(`/api/projects/${project.id}/references`,{method:'POST',body:new FormData()}),/暂不读取参考 PDF/);
});

test('browsers without Web Locks cannot start a batch and do not silently risk a parallel writer',async()=>{
  const store=memoryStore();let calls=0;const api=implementation({store,lockManager:null,fetchImpl:async()=>{calls++;throw new Error('No fetch expected');}});await api.configure(config);
  const project=await api.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'No lock fixture'})});await api.handle(`/api/projects/${project.id}/scope`,{method:'PUT',body:JSON.stringify({research_question:'Question',inferred:false})});
  await assert.rejects(start(api,project),/已阻止运行/);assert.equal(calls,0);assert.equal(store.snapshot().jobs.length,0);
});

test('another tab reads current checkpoints but cannot overwrite a running workspace or pretend to cancel its request',async()=>{
  let startedResolve,finishResolve;const started=new Promise(resolve=>{startedResolve=resolve;}),finish=new Promise(resolve=>{finishResolve=resolve;});
  const mock=mockFetch([paper('10.1234/tabs','Cross-tab fixture')],{analysisGate:async()=>{startedResolve();await finish;}});
  const {api,project,store}=await setup(mock.fetchImpl),other=createBrowserApi({store,fetchImpl:mock.fetchImpl});await other.configure(config);
  const job=await start(api,project);await started;
  const current=await other.handle('/api/workspace/status');assert.equal(current.active_job.id,job.id);assert.equal(current.active_job.stage,'摘要分析');
  await assert.rejects(other.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'Must not overwrite'})}),/另一个标签页正在分析/);
  await assert.rejects(other.handle(`/api/jobs/${job.id}/cancel`,{method:'POST'}),/原标签页取消/);
  await assert.rejects(start(other,project),/已有浏览器分析批次/);
  finishResolve();await settled(api,job.id);
  assert.equal((await other.handle(`/api/projects/${project.id}/papers`)).length,1);assert.equal(store.snapshot().projects.length,1);
  const added=await other.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'After batch'})});assert.equal(store.snapshot().projects.length,2);assert.ok(added.id);assert.equal(store.snapshot().papers.length,1);
});

test('simultaneous idle-tab edits serialize and refresh the persisted baseline instead of dropping a project',async()=>{
  const store=memoryStore(),a=createBrowserApi({store,fetchImpl:async()=>{throw new Error('No fetch expected');}}),b=createBrowserApi({store,fetchImpl:async()=>{throw new Error('No fetch expected');}});await Promise.all([a.ready,b.ready]);
  await Promise.all([a.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'Tab A'})}),b.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'Tab B'})})]);
  assert.deepEqual(store.snapshot().projects.map(p=>p.name).sort(),['Tab A','Tab B']);assert.equal((await a.handle('/api/projects')).length,2);
});

test('a transient storage failure does not permanently poison subsequent saves',async()=>{
  const memory=memoryStore();let fail=true;const store={load:memory.load,save:async value=>{if(fail){fail=false;throw new Error('quota');}await memory.save(value);}};
  const api=createBrowserApi({store,fetchImpl:async()=>{throw new Error('No fetch expected');}});await assert.rejects(api.configure(config),/保存失败/);await api.configure(config);
  const project=await api.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'Recovered storage'})});assert.equal(memory.snapshot().projects[0].id,project.id);assert.equal(JSON.stringify(memory.snapshot()).includes(SECRET),false);
});

test('an end-of-job storage failure stays visible in memory and can be exported without falsely reporting a saved batch',async()=>{
  const memory=memoryStore(),mock=mockFetch([paper('10.1234/storage','Storage failure fixture')]);let failFinal=false;
  const store={load:memory.load,save:async value=>{if(failFinal&&value.jobs.some(j=>!['running','queued'].includes(j.status)))throw new Error('full');await memory.save(value);}};
  const {api,project}=await setup(mock.fetchImpl,store);failFinal=true;const job=await settled(api,(await start(api,project)).id);
  assert.equal(job.status,'failed');assert.equal(job.persistence_error,true);assert.match(job.error,/请勿刷新/);const bundle=JSON.parse(await (await api.handle(`/api/projects/${project.id}/export?kind=json`)).text());assert.equal(bundle.papers.length,1);assert.equal(bundle.jobs[0].persistence_error,true);
  failFinal=false;await api.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'Storage writable again'})});assert.equal(memory.snapshot().papers.length,1);assert.equal(memory.snapshot().jobs[0].status,'failed');
});

test('candidate-only shortages and search reasons remain in every export even when no analysis could run',async()=>{
  const mock=mockFetch([paper('10.1234/gap','Candidate without abstract','')]);const {api,project}=await setup(mock.fetchImpl);await settled(api,(await start(api,project)).id);
  for(const kind of ['json','markdown','html']){const content=await (await api.handle(`/api/projects/${project.id}/export?kind=${kind}`)).text();assert.match(content,/Candidate without abstract/);assert.match(content,/检索源未提供摘要/);assert.match(content,/Fixture research question/);if(kind==='json'){const bundle=JSON.parse(content);assert.equal(bundle.papers.length,0);assert.equal(bundle.jobs[0].checkpoint.draft_shortfall,1);assert.equal(bundle.jobs[0].checkpoint.search_log.length,3);}}
});

test('cross-project reuse shows a scope-transfer boundary in the reader and all exports without mutating the original analysis',async()=>{
  const mock=mockFetch([paper('10.1234/transfer','Scope transfer fixture')]);const {api,project,store}=await setup(mock.fetchImpl);await settled(api,(await start(api,project)).id);
  const second=await api.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'Another research scope'})});await api.handle(`/api/projects/${second.id}/scope`,{method:'PUT',body:JSON.stringify({research_question:'A different research question',inferred:false})});await settled(api,(await start(api,second)).id);
  const [transferred]=await api.handle(`/api/projects/${second.id}/papers`),[original]=await api.handle(`/api/projects/${project.id}/papers`);
  assert.match(transferred.analysis.transfer_notice,/尚未重新评估当前研究范围/);assert.match(transferred.analysis.transfer_notice,/推断与行动需按当前课题核对/);assert.equal(original.analysis.transfer_notice,undefined);assert.equal(store.snapshot().papers[0].analysis.transfer_notice,undefined);assert.deepEqual(transferred.analysis.actions,original.analysis.actions);
  for(const kind of ['json','markdown','html']){const content=await (await api.handle(`/api/projects/${second.id}/export?kind=${kind}`)).text();assert.match(content,/尚未重新评估当前研究范围/);}
});
