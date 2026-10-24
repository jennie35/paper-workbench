import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserApi as implementation} from '../browser-api.js';
import {createHash} from 'node:crypto';

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
async function fixtureExtractPdf(file){
  const bytes=Buffer.from(await file.arrayBuffer()),metadata=JSON.parse(bytes.toString());
  const text_pages=[{page:1,text:`${metadata.title.replace(/<[^>]*>/g,'')}\n${metadata.doi}\nAda Example\nIntroduction: this study asks how matched protocols affect measured outcomes.`},{page:2,text:'Methods: compare matched conditions using independent experimental units and a fixed reference protocol.'},{page:3,text:'Results: the supplied fixture reports a measured difference under the stated conditions. Discussion: transfer requires matching conditions.'}];
  return {sha256:createHash('sha256').update(bytes).digest('hex'),pages:3,text_pages,text_characters:text_pages.reduce((sum,page)=>sum+page.text.length,0),unread_pages:[],warnings:[]};
}
const createBrowserApi=options=>implementation({lockManager:testLocks,extractPdf:fixtureExtractPdf,...options});

const SECRET='fixture-only-secret-must-not-be-exported';
const config={base_url:'https://models.example/v1',api_key:SECRET,text_model:'fixture-text'};
const copy=value=>JSON.parse(JSON.stringify(value));
function memoryStore(initial=null){let value=initial;return {load:async()=>value&&copy(value),save:async data=>{value=copy(data);},snapshot:()=>copy(value)};}
function response(value,status=200){return {ok:status>=200&&status<300,status,json:async()=>copy(value)};}
const paper=(doi,title,abstract='Actual fixture abstract: method and finding are described here.')=>({DOI:doi,title:[title],abstract,author:[{given:'Ada',family:'Example'}],type:'journal-article','container-title':['Fixture Journal'],published:{'date-parts':[[2026,1,1]]},link:abstract?[{'content-type':'application/pdf',URL:`https://papers.example/fixture.pdf?title=${encodeURIComponent(title)}&doi=${encodeURIComponent(doi)}`}]:[]});
function modelAnswer(value){return response({choices:[{message:{content:JSON.stringify(value)}}]});}
function mockFetch(items,{failAnalysis=0,analysisGate=null,fulltext=true}={}){
  const calls=[];let failures=failAnalysis;
  const fetchImpl=async(url,options={})=>{
    calls.push({url:String(url),options});
    if(String(url).startsWith('https://api.crossref.org/works')){const results=typeof items==='function'?items(String(url)):items;return response({message:{items:fulltext?results:results.map(item=>({...item,link:[]}))}});}
    if(String(url).startsWith('https://papers.example/fixture.pdf')){const address=new URL(url);return new Response(JSON.stringify({title:address.searchParams.get('title'),doi:address.searchParams.get('doi')}),{headers:{'Content-Type':'application/pdf'}});}
    if(String(url).startsWith('https://api.openalex.org/works/'))return response({},404);
    if(String(url).startsWith('https://api.openalex.org/works'))return response({results:[]});
    if(String(url).endsWith('/models'))return response({data:[{id:'fixture-text'},{id:'fixture-text'},{id:'fixture-other'}]});
    const body=JSON.parse(options.body),system=body.messages[0].content,input=JSON.parse(body.messages[1].content);
    if(input.task==='search-plan')return modelAnswer({queries:[{query:input.topic.keywords[0]||'fixture measurement',language:'en',intent:'Synthetic query fixture'}]});
    if(system.includes('实质相关性筛选'))return modelAnswer({selected:input.candidates.map((_,index)=>({index,reason:'This fixture directly addresses the specified research question.',score:0.95})),excluded:[]});
    if(system.includes('阅读所有提供的正文块'))return modelAnswer({notes:input.blocks.map(block=>({source_block_ids:[block.id],text:block.text})),required_visual_pages:[]});
    if(system.includes('跨论文'))return modelAnswer({supports:[],conflicts:[],judgement_changes:[],priority_actions:[],route_decisions:[],limitations:['Fixed fixture synthesis; does not raise evidence strength.']});
    if(analysisGate)await analysisGate(options.signal);
    if(failures>0){failures-=1;return response({error:{code:'insufficient_quota',message:'unsafe body '+SECRET}},429);}
    return modelAnswer({summary:'A summary grounded in the supplied full text.',scientific_question:'A testable question.',verified:true,skill_applied:true,visuals:[{page:1,label:'Invented figure'}],core_coverage:{question:{summary:'How does protocol choice affect outcomes?',source_block_ids:['PDF-P1']},methods:{summary:'Compare matched independent units.',source_block_ids:['PDF-P2']},results:{summary:'A difference was reported under specified conditions.',source_block_ids:['PDF-P3']}},required_visual_pages:[],evidence:[{id:'E01',claim:'A located text observation.',observation:'The results text reports a difference under the matched protocol.',source_block_ids:['PDF-P3','MADE-UP-FULLTEXT'],limits:'Limited to the reported protocol.'}],flow_steps:['Define the research question','Compare protocols','Measure and report outcomes'],actions:[{title:'A proposed pilot study',evidence_ids:['E01','FAKE'],method:'Compare matched conditions',sample_size_basis:'n = 999 fabricated'}]});
  };
  return {calls,fetchImpl};
}
async function setup(fetchImpl,store=memoryStore(),options={}){
  const api=createBrowserApi({store,fetchImpl,...options});await api.configure(config);
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

test('abstracts remain candidate previews and never consume a new core-report quota or a paper-analysis request',async()=>{
  const mock=mockFetch([paper('10.1234/actual','A real fixture title')],{fulltext:false});const {api,project,store}=await setup(mock.fetchImpl);const queued=await start(api,project);const job=await settled(api,queued.id);
  assert.equal(job.mode,'direct');assert.equal(job.status,'waiting_sources');assert.equal(job.core_reports,0);assert.equal(job.drafts_analyzed,0);assert.deepEqual(job.checkpoint.completed,[]);assert.equal(job.checkpoint.draft_shortfall,1);assert.equal(job.checkpoint.candidates[0].status,'no_fulltext');
  const records=await api.handle(`/api/projects/${project.id}/papers`);assert.deepEqual(records,[]);assert.equal(store.snapshot().counter,0);assert.match(job.checkpoint.candidates[0].abstract_preview,/Actual fixture abstract/);
  const detail=await api.handle(`/api/jobs/${job.id}/candidates/0`);assert.equal(detail.artifacts.pdf_available,false);assert.equal(detail.artifacts.source_available,true);const source=await api.handle(`/api/jobs/${job.id}/candidates/0/source`);assert.equal(source.blocks[0].text,'Actual fixture abstract: method and finding are described here.');
  assert.equal(mock.calls.filter(call=>call.url.endsWith('/chat/completions')&&JSON.parse(JSON.parse(call.options.body).messages[1].content).paper).length,0);
  assert.equal(JSON.stringify(store.snapshot()).includes(SECRET),false);
});

test('located full-text core reports count once while model-supplied image and skill claims stay unverified',async()=>{
  const mock=mockFetch([paper('10.1234/core','A fulltext fixture title')]),{api,project,store}=await setup(mock.fetchImpl),job=await settled(api,(await start(api,project)).id);
  assert.equal(job.status,'completed');assert.equal(job.core_reports,1);assert.equal(job.checkpoint.draft_shortfall,0);
  const [record]=await api.handle(`/api/projects/${project.id}/papers`),a=record.analysis;assert.equal(record.id,'D001');assert.equal(a.report_status,'completed');assert.equal(a.verified,false);assert.equal(a.skill_applied,false);assert.deepEqual(a.visuals,[]);assert.deepEqual(a.evidence[0].source_block_ids,['PDF-P3']);assert.deepEqual(a.actions[0].evidence_ids,['E01']);assert.match(a.actions[0].sample_size_basis,/先导实验/);assert.doesNotMatch(a.actions[0].sample_size_basis,/999/);assert.equal(a.coverage.text_groups_read,a.coverage.text_groups_total);
  const svg=await api.handle('/api/papers/D001/assets/research-flow.svg',{binary:true});assert.match(await svg.text(),/分析者绘制/);
  for(const call of mock.calls){assert.equal(call.options.redirect,'error');if(/^https:\/\/(?:api\.(?:crossref|openalex)\.org|papers\.example)/.test(call.url))assert.equal(call.options.headers?.Authorization,undefined);else assert.equal(new URL(call.url).origin,'https://models.example');}
  assert.equal(JSON.stringify(store.snapshot()).includes(SECRET),false);
});

test('no abstract means no model analysis, real shortage, and progressive search ranges',async()=>{
  const mock=mockFetch([paper('10.1234/no-abstract','Title without an abstract','')]);const {api,project}=await setup(mock.fetchImpl);const job=await settled(api,(await start(api,project,5)).id);
  assert.equal(job.drafts_analyzed,0);assert.equal(job.checkpoint.draft_shortfall,5);assert.equal(job.checkpoint.candidates[0].status,'no_fulltext');assert.equal(mock.calls.filter(x=>x.url.endsWith('/chat/completions')&&!JSON.parse(x.options.body).messages[0].content.includes('实质相关性筛选')&&JSON.parse(JSON.parse(x.options.body).messages[1].content).task!=='search-plan').length,0);assert.equal(job.checkpoint.search_log.length,6);const searches=mock.calls.filter(x=>x.url.startsWith('https://api.crossref.org'));assert.match(searches[0].url,/from-pub-date/);assert.equal(new URL(searches.at(-1).url).searchParams.has('filter'),false);
});

test('unsupported report fields and absent research steps stay empty instead of generating placeholder findings',async()=>{
  const mock=mockFetch([paper('10.1234/limited','A limited source fixture')]),fetchImpl=async(url,options={})=>{
    if(String(url).endsWith('/chat/completions')&&JSON.parse(JSON.parse(options.body).messages[1].content).paper)return modelAnswer({summary:'Only the supplied observation can be summarized.'});
    return mock.fetchImpl(url,options);
  };
  const {api,project,store}=await setup(fetchImpl);const job=await settled(api,(await start(api,project)).id);assert.equal(job.status,'waiting_sources');assert.equal(job.core_reports,0);assert.deepEqual(await api.handle(`/api/projects/${project.id}/papers`),[]);const record=store.snapshot().jobs[0].checkpoint.candidates[0];
  for(const key of ['scientific_question','equipment','samples','parameters','future_insights','transfer_conditions','roadmap'])assert.equal(record.analysis[key],'',key);
  assert.deepEqual(record.analysis.flow_steps,[]);assert.equal(record.analysis.verified,false);assert.equal(record.analysis.source_basis,'fulltext');assert.equal(record.analysis.report_status,'processing');
});

test('repeated runs and another project exclude stored studies without another paid analysis or a new association',async()=>{
  const mock=mockFetch([paper('10.1234/reuse','Reusable fixture')]);const {api,project,store}=await setup(mock.fetchImpl);await settled(api,(await start(api,project)).id);const paid=mock.calls.filter(x=>x.url.endsWith('/chat/completions')&&JSON.parse(JSON.parse(x.options.body).messages[1].content).task!=='search-plan').length;
  const second=await settled(api,(await start(api,project)).id);assert.equal(second.drafts_analyzed,0);assert.deepEqual(second.checkpoint.reused,[]);assert.equal(second.checkpoint.draft_shortfall,1);assert.equal(second.checkpoint.candidates[0].status,'duplicate');assert.equal(second.checkpoint.candidates[0].paper_id,undefined);assert.equal(mock.calls.filter(x=>x.url.endsWith('/chat/completions')&&JSON.parse(JSON.parse(x.options.body).messages[1].content).task!=='search-plan').length,paid);
  assert.equal(mock.calls.filter(x=>x.url.endsWith('/chat/completions')&&JSON.parse(JSON.parse(x.options.body).messages[1].content).task==='search-plan').length,1,'same-scope batches reuse the planned queries without another model request');
  const other=await api.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'Second topic'})});await api.handle(`/api/projects/${other.id}/scope`,{method:'PUT',body:JSON.stringify({research_question:'Related question',inferred:false})});
  const third=await settled(api,(await start(api,other)).id);assert.deepEqual(third.checkpoint.reused,[]);assert.equal((await api.handle(`/api/projects/${other.id}/papers`)).length,0);assert.equal(store.snapshot().links.length,1);assert.equal(store.snapshot().counter,1);assert.equal(mock.calls.filter(x=>x.url.endsWith('/chat/completions')&&JSON.parse(JSON.parse(x.options.body).messages[1].content).task!=='search-plan').length,paid);
});

test('failed analysis preserves pending candidate and resumes only unfinished work',async()=>{
  const mock=mockFetch([paper('10.1234/retry','Retry fixture')],{failAnalysis:1});const {api,project}=await setup(mock.fetchImpl);const first=await settled(api,(await start(api,project)).id);
  assert.equal(first.status,'failed');assert.match(first.error,/余额不足/);assert.equal(first.error.includes(SECRET),false);assert.equal(first.checkpoint.candidates[0].status,'pending');
  const resumed=await api.handle(`/api/jobs/${first.id}/retry`,{method:'POST'});assert.equal(resumed.id,first.id);const final=await settled(api,first.id);assert.equal(final.status,'completed');assert.equal(final.drafts_analyzed,1);assert.equal(final.core_reports,1);assert.equal((await api.handle(`/api/projects/${project.id}/papers`)).length,1);assert.deepEqual(final.checkpoint.completed,['D001']);
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

test('completed direct runs retain measured time and export it without counting later idle time',async()=>{
  const initial=Date.parse('2026-10-24T01:00:00Z');let clock=initial;const updates=[];
  const mock=mockFetch([paper('10.1234/timed','Timed source fixture')],{analysisGate:async()=>{clock+=75000;}});
  const {api,project}=await setup(mock.fetchImpl,memoryStore(),{clockImpl:()=>clock,onChange:job=>updates.push(job)});
  const job=await settled(api,(await start(api,project)).id),timing=job.checkpoint.run_timing;
  assert.equal(job.status,'completed');assert.equal(timing.elapsed_ms,75000);assert.equal(timing.run_elapsed_ms,75000);assert.equal(timing.run_initial_completed,0);assert.equal(timing.running,false);
  assert.equal(timing.run_started_at,new Date(initial).toISOString());assert.equal(timing.stopped_at,new Date(initial+75000).toISOString());
  assert.ok(updates.some(row=>row.status==='running'&&row.checkpoint.run_timing.running&&row.checkpoint.run_timing.elapsed_ms===0));
  clock+=86400000;assert.deepEqual((await api.handle(`/api/jobs/${job.id}`)).checkpoint.run_timing,timing);
  const bundle=JSON.parse(await (await api.handle(`/api/projects/${project.id}/export?kind=json`)).text());
  assert.deepEqual(bundle.jobs[0].checkpoint.run_timing,timing);
});

test('resuming a partially completed run excludes paused days and records the existing report baseline',async()=>{
  let clock=Date.parse('2026-10-24T02:00:00Z'),reads=0;
  const first=paper('10.1234/part-a','First timed source'),second=paper('10.1234/part-b','Second timed source');
  const mock=mockFetch([first,second],{analysisGate:async()=>{clock+=4000;reads+=1;if(reads===2)throw new Error('Synthetic interrupted second analysis');}});
  const {api,project}=await setup(mock.fetchImpl,memoryStore(),{clockImpl:()=>clock});
  const waiting=await settled(api,(await start(api,project,2)).id);
  assert.equal(waiting.status,'failed');assert.equal(waiting.core_reports,1);assert.equal(waiting.checkpoint.run_timing.elapsed_ms,8000);assert.equal(waiting.checkpoint.run_timing.running,false);
  clock+=2*86400000;await api.handle(`/api/jobs/${waiting.id}/retry`,{method:'POST'});
  const final=await settled(api,waiting.id),timing=final.checkpoint.run_timing;
  assert.equal(final.status,'completed');assert.equal(final.core_reports,2);assert.equal(timing.run_initial_completed,1);assert.equal(timing.run_elapsed_ms,4000);assert.equal(timing.elapsed_ms,12000);
});

test('waiting for unavailable sources stops the elapsed clock',async()=>{
  let clock=Date.parse('2026-10-24T02:30:00Z');const mock=mockFetch([paper('10.1234/wait-time','Waiting source fixture','')]);
  const {api,project}=await setup(async(...args)=>{clock+=100;return mock.fetchImpl(...args);},memoryStore(),{clockImpl:()=>clock});
  const waiting=await settled(api,(await start(api,project)).id),timing=waiting.checkpoint.run_timing;
  assert.equal(waiting.status,'waiting_sources');assert.ok(timing.elapsed_ms>0);assert.equal(timing.running,false);assert.equal(timing.run_initial_completed,0);
  clock+=86400000;assert.deepEqual((await api.handle(`/api/jobs/${waiting.id}`)).checkpoint.run_timing,timing);
});

test('failed direct runs stop timing and a retry accumulates only its actual work',async()=>{
  let clock=Date.parse('2026-10-24T03:00:00Z');
  const mock=mockFetch([paper('10.1234/fail-time','Failure timing source')],{failAnalysis:1,analysisGate:async()=>{clock+=3000;}});
  const {api,project}=await setup(mock.fetchImpl,memoryStore(),{clockImpl:()=>clock});
  const failed=await settled(api,(await start(api,project)).id);
  assert.equal(failed.status,'failed');assert.equal(failed.checkpoint.run_timing.running,false);assert.equal(failed.checkpoint.run_timing.elapsed_ms,3000);
  clock+=86400000;await api.handle(`/api/jobs/${failed.id}/retry`,{method:'POST'});const final=await settled(api,failed.id);
  assert.equal(final.status,'completed');assert.equal(final.checkpoint.run_timing.elapsed_ms,6000);assert.equal(final.checkpoint.run_timing.run_elapsed_ms,3000);
});

test('cancelling a direct request freezes the active-run timing',async()=>{
  let clock=Date.parse('2026-10-24T04:00:00Z'),signalStarted;const started=new Promise(resolve=>{signalStarted=resolve;});
  const mock=mockFetch([paper('10.1234/cancel-time','Cancellation timing source')],{analysisGate:signal=>new Promise((_,reject)=>{
    clock+=6000;signalStarted();signal.addEventListener('abort',()=>reject(new Error('Cancelled test request')),{once:true});
  })});
  const {api,project}=await setup(mock.fetchImpl,memoryStore(),{clockImpl:()=>clock});const submitted=await start(api,project);await started;
  await api.handle(`/api/jobs/${submitted.id}/cancel`,{method:'POST'});const cancelled=await settled(api,submitted.id);
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.checkpoint.run_timing.elapsed_ms,6000);assert.equal(cancelled.checkpoint.run_timing.running,false);
});

test('interrupted timing stops at the last saved checkpoint instead of the browser reopen date',async()=>{
  const started='2026-10-20T01:00:00.000Z',updated='2026-10-20T01:00:12.000Z';let calls=0;
  const store=memoryStore({version:1,projects:[],papers:[],links:[],counter:0,jobs:[{id:'timed-orphan',status:'running',updated_at:updated,checkpoint:{candidates:[],completed:[],run_timing:{elapsed_ms:5000,run_started_at:started,run_initial_completed:2,run_elapsed_ms:0,running:true}}}]});
  const api=createBrowserApi({store,clockImpl:()=>Date.parse('2026-10-24T01:00:00Z'),fetchImpl:async()=>{calls++;throw new Error('No recovery model calls');}});await api.ready;
  const job=await api.handle('/api/jobs/timed-orphan');assert.equal(job.status,'failed');assert.equal(job.checkpoint.run_timing.elapsed_ms,17000);assert.equal(job.checkpoint.run_timing.run_elapsed_ms,12000);assert.equal(job.checkpoint.run_timing.stopped_at,updated);assert.equal(job.checkpoint.run_timing.running,false);assert.equal(calls,0);
});

test('JSON, Markdown and offline HTML exports share the same draft record and never include API credentials',async()=>{
  const mock=mockFetch([paper('10.1234/export','<script>unsafe</script> Export fixture')]);const {api,project}=await setup(mock.fetchImpl);await settled(api,(await start(api,project)).id);
  for(const kind of ['json','markdown','html']){const blob=await api.handle(`/api/projects/${project.id}/export?kind=${kind}`,{binary:true}),content=await blob.text();assert.equal(content.includes(SECRET),false);assert.equal(content.includes('api_key'),false);assert.match(content,/summary|摘要|总结/);if(kind==='json'){const bundle=JSON.parse(content);assert.equal(bundle.papers[0].analysis.verified,false);assert.equal(bundle.project.name,'Fixture topic');assert.equal(bundle.jobs[0].checkpoint.candidates.length,1);}if(kind==='html'){assert.equal(blob.type,'text/html;charset=utf-8');assert.doesNotMatch(content,/<script>/);assert.match(content,/未执行外部技能/);}}
  await assert.rejects(api.handle(`/api/projects/${project.id}/references`,{method:'POST',body:new FormData()}),/请选择参考 PDF/);
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
  const current=await other.handle('/api/workspace/status');assert.equal(current.active_job.id,job.id);assert.equal(current.active_job.stage,'生成全文文字报告');
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

test('candidate archives survive JSON and Markdown while offline HTML omits empty retrieval logs',async()=>{
  const mock=mockFetch([paper('10.1234/gap','Candidate without abstract','')]);const {api,project}=await setup(mock.fetchImpl);await settled(api,(await start(api,project)).id);
  for(const kind of ['json','markdown','html']){const content=await (await api.handle(`/api/projects/${project.id}/export?kind=${kind}`)).text();if(kind==='html'){assert.doesNotMatch(content,/Candidate without abstract|检索来源与筛选记录|跨论文综合/);}else{assert.match(content,/Candidate without abstract/);assert.match(content,/等待论文正文|补充摘要与开放全文|检索源未提供摘要/);}assert.match(content,/Fixture research question/);if(kind==='json'){const bundle=JSON.parse(content);assert.equal(bundle.papers.length,0);assert.equal(bundle.jobs[0].checkpoint.draft_shortfall,1);assert.equal(bundle.jobs[0].checkpoint.search_log.length,6);}}
});

test('an explicit retry refreshes exhausted source admissions while retaining query, relevance and report caches',async()=>{
  let sourceAvailable=false;
  const old=paper('10.1234/refresh-pdf','An actual source later gaining public PDF','');
  const available=paper('10.1234/refresh-pdf','An actual source later gaining public PDF');
  const mock=mockFetch(()=>[sourceAvailable?available:old]);const {api,project,store}=await setup(mock.fetchImpl);
  const first=await settled(api,(await start(api,project)).id);
  assert.equal(first.status,'waiting_sources');assert.equal(first.core_reports,0);assert.equal(first.checkpoint.searched_sources.length,6);
  const firstPlan=first.checkpoint.search_plan,searchCount=()=>mock.calls.filter(call=>call.url.startsWith('https://api.crossref.org/works')).length,
    modelRequests=()=>mock.calls.filter(call=>call.url.endsWith('/chat/completions')).map(call=>JSON.parse(call.options.body));
  const before=searchCount();sourceAvailable=true;await api.handle(`/api/jobs/${first.id}/retry`,{method:'POST'});
  const second=await settled(api,first.id);
  assert.equal(second.status,'completed');assert.equal(second.core_reports,1);assert.ok(searchCount()>before);
  assert.deepEqual(second.checkpoint.search_plan,firstPlan);assert.equal(second.checkpoint.candidates.length,1);assert.equal(store.snapshot().counter,1);
  assert.equal(modelRequests().filter(body=>JSON.parse(body.messages[1].content).task==='search-plan').length,1);
  assert.equal(modelRequests().filter(body=>body.messages[0].content.includes('实质相关性筛选')).length,1);
  assert.equal(modelRequests().filter(body=>JSON.parse(body.messages[1].content).paper).length,1);
  const analyzed=modelRequests().length,refreshed=searchCount();await api.handle(`/api/jobs/${first.id}/retry`,{method:'POST'});
  const third=await settled(api,first.id);assert.equal(third.core_reports,1);assert.equal(store.snapshot().counter,1);
  assert.equal(modelRequests().length,analyzed);assert.equal(searchCount(),refreshed);assert.deepEqual(third.checkpoint.completed,['D001']);
});

test('cross-project version matches are skipped and wider search fills the requested number with new studies',async()=>{
  let nextBatch=false,searches=0;const old=paper('10.1234/original','Existing source study'),version={...paper('10.1234/formal','Different published title'),relation:{'is-preprint-of':[{id:'https://doi.org/10.1234/ORIGINAL'}]}},fresh=[paper('10.1234/new-a','New study A'),paper('10.1234/new-b','New study B')];
  const mock=mockFetch(()=>!nextBatch?[old]:++searches===1?[version]:[version,...fresh]);const {api,project,store}=await setup(mock.fetchImpl);await settled(api,(await start(api,project)).id);nextBatch=true;
  const second=await api.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'Another research scope'})});await api.handle(`/api/projects/${second.id}/scope`,{method:'PUT',body:JSON.stringify({research_question:'A different research question',inferred:false})});let job=await settled(api,(await start(api,second,2)).id);
  assert.equal(job.reports_generated,2);assert.deepEqual(job.checkpoint.reused,[]);assert.equal(job.checkpoint.candidates.find(item=>item.doi==='10.1234/formal').status,'duplicate');assert.equal(searches,2);
  const records=await api.handle(`/api/projects/${second.id}/papers`);assert.deepEqual(records.map(item=>item.id),['D002','D003']);assert.equal(records.some(item=>item.doi==='10.1234/original'),false);assert.equal(store.snapshot().counter,3);
  // A retry of this batch must keep its already generated records and IDs.
  await api.handle(`/api/jobs/${job.id}/retry`,{method:'POST'});job=await settled(api,job.id);assert.equal(job.reports_generated,2);assert.equal(store.snapshot().counter,3);assert.deepEqual((await api.handle(`/api/projects/${second.id}/papers`)).map(item=>item.id),['D002','D003']);
  const requests=mock.calls.filter(item=>item.url.endsWith('/chat/completions')).map(item=>JSON.parse(item.options.body));const ranked=requests.filter(item=>item.messages[0].content.includes('实质相关性筛选')).flatMap(item=>JSON.parse(item.messages[1].content).candidates);assert.equal(ranked.some(item=>item.title===version.title[0]),false);
});

test('a committed record with a stale pending checkpoint is recovered only for its original batch',async()=>{
  const mock=mockFetch([paper('10.1234/checkpoint-recovery','Own batch recovery')]);const {api,project,store}=await setup(mock.fetchImpl);const first=await settled(api,(await start(api,project)).id),snapshot=store.snapshot();
  const saved=snapshot.jobs.find(item=>item.id===first.id);saved.status='failed';saved.drafts_analyzed=0;saved.reports_generated=0;saved.checkpoint.drafts_analyzed=0;saved.checkpoint.reports_generated=0;saved.checkpoint.candidates[0].status='pending';delete saved.checkpoint.candidates[0].paper_id;
  const restoredStore=memoryStore(snapshot),restored=createBrowserApi({store:restoredStore,fetchImpl:mock.fetchImpl});await restored.configure(config);const analysisCalls=()=>mock.calls.filter(item=>item.url.endsWith('/chat/completions')&&JSON.parse(JSON.parse(item.options.body).messages[1].content).paper).length,analyzed=analysisCalls();
  await restored.handle(`/api/jobs/${first.id}/retry`,{method:'POST'});const result=await settled(restored,first.id);assert.equal(result.reports_generated,1);assert.equal(result.drafts_analyzed,1);assert.equal(restoredStore.snapshot().counter,1);assert.equal((await restored.handle(`/api/projects/${project.id}/papers`)).length,1);assert.equal(analysisCalls(),analyzed);
});

test('a legacy exhausted batch refreshes real metadata under the new search strategy and preserves its ID',async()=>{
  const item=paper('10.1234/exhausted','Recovered exhausted fixture'),year=new Date().getUTCFullYear(),oldAttempts=[year-2,year-5,'all'].flatMap(from=>['Crossref','OpenAlex'].map(source=>`${source}:${from}:fixture`));
  const legacy={version:1,counter:0,papers:[],links:[],references:[],publicSettings:{},projects:[{id:'legacy-refresh',name:'Fixture topic',scope:{research_question:'Fixture research question',keywords:['fixture'],inferred:false}}],jobs:[{id:'exhausted-refresh',project_id:'legacy-refresh',mode:'direct',requested:1,status:'waiting_sources',checkpoint:{scope_snapshot:{research_question:'Fixture research question',keywords:['fixture'],inferred:false},candidates:[{title:item.title[0],doi:item.DOI,authors:['Ada Example'],year:2026,publication_status:'published',source:'Crossref',status:'excluded',reason:'Legacy broad query lacked useful text',pdf_urls:[]}],completed:[],reused:[],searched_sources:oldAttempts,search_log:[],diagnostics:[]}}]};
  const mock=mockFetch([item]),store=memoryStore(legacy),api=createBrowserApi({store,fetchImpl:mock.fetchImpl});await api.configure(config);await api.handle('/api/jobs/exhausted-refresh/retry',{method:'POST'});const job=await settled(api,'exhausted-refresh');
  assert.equal(job.id,'exhausted-refresh');assert.equal(job.core_reports,1);assert.equal(job.status,'completed');assert.equal(job.checkpoint.search_plan.version,2);assert.equal(job.checkpoint.search_diagnosis.completed,1);assert.ok(mock.calls.some(call=>call.url.startsWith('https://api.crossref.org')));assert.equal(store.snapshot().counter,1);
});
