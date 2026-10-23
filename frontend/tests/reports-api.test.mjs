import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserApi,searchQueries} from '../browser-api.js';

const copy=value=>JSON.parse(JSON.stringify(value)),secret='synthetic-secret-not-for-source-services';
const config={base_url:'https://models.example/v1',api_key:secret,text_model:'synthetic-text'};
const doi='10.5555/actual-source-fixture',title='Synthetic open measurement study';
const crossref=(abstract='')=>({DOI:doi,title:[title],abstract,type:'journal-article','container-title':['Fixture Journal'],published:{'date-parts':[[2026]]}});
const openalex=()=>({doi:'https://doi.org/'+doi,title,publication_year:2026,type:'article',primary_location:{is_published:true,is_oa:true,pdf_url:'https://papers.example/fixture.pdf'},abstract_inverted_index:{Actual:[0],source:[1],abstract:[2]}});
function memory(initial){let value=initial||null;return {load:async()=>value&&copy(value),save:async next=>{value=copy(next);},snapshot:()=>copy(value)};}
function locks(){const held=new Set(),queues=new Map();return {query:async()=>({held:[...held].map(name=>({name}))}),async request(name,options,callback){if(typeof options==='function'){callback=options;options={};}if(held.has(name)&&options.ifAvailable)return callback(null);if(held.has(name))await new Promise(resolve=>{const q=queues.get(name)||[];q.push(resolve);queues.set(name,q);});held.add(name);try{return await callback({name});}finally{held.delete(name);queues.get(name)?.shift()?.();}}};}
const answer=value=>Response.json({choices:[{message:{content:JSON.stringify(value)}}]});
async function setup({pdfFails=false,failAnalysis=false,openalexOnly=false,unread=false,gate=null,store=memory()}={}){
  const calls=[];let failures=Number(failAnalysis);
  const fetchImpl=async(url,options={})=>{
    calls.push({url:String(url),options});if(String(url).startsWith('https://api.crossref.org'))return openalexOnly?new Response('{}',{status:503}):Response.json({message:{items:[crossref()]}});
    if(String(url).startsWith('https://api.openalex.org/works/'))return Response.json(openalex());
    if(String(url).startsWith('https://api.openalex.org'))return Response.json({results:[openalex()]});
    if(String(url).startsWith('https://papers.example/')){if(pdfFails)throw new Error('Blocked by CORS');return new Response(new TextEncoder().encode('%PDF-1.7 synthetic PDF bytes'));}
    const request=JSON.parse(options.body),input=JSON.parse(request.messages[1].content);
    if(input.task==='search-plan')return answer({queries:[{query:input.topic.keywords[0]||'measurement controls',language:'en',intent:'Synthetic query fixture'}]});
    if(request.messages[0].content.includes('实质相关性筛选'))return answer({selected:input.candidates.map((_,index)=>({index,reason:'Directly tests the specified controls.',score:0.95}))});
    if(input.blocks)return answer({notes:input.blocks.map(block=>({source_block_ids:[block.id],text:block.text})),required_visual_pages:[]});
    if(gate)await gate(options.signal);if(failures-->0)return new Response('{"error":{"code":"insufficient_quota"}}',{status:429});
    return answer({summary:'This report uses the provided source text.',scientific_question:'Which controls influence measurement?',variables:'The fixture reports a controlled variable.',core_coverage:{question:{summary:'Which controls influence measurement?',source_block_ids:['PDF-P1']},methods:{summary:'Compare matched controls.',source_block_ids:['PDF-P1']},results:{summary:'The fixture reports measured outcomes.',source_block_ids:['PDF-P2']}},required_visual_pages:[],evidence:[null,{id:'E01',claim:'Supported fixture claim',observation:'The supplied text reports measured outcomes.',source_block_ids:['PDF-P1','INVENTED']}],flow_steps:['Identify controls','Compare the reported measurements'],actions:[{title:'Pilot under matched conditions',evidence_ids:['E01'],priority:'P1'}],verified:true,skill_applied:true});
  };
  const extractPdf=async()=>{const text_pages=[{page:1,text:title+' DOI: '+doi+' Methods: matched controls and measured outcomes.'},...unread?[]:[{page:2,text:'Results: the fixture reports measured outcomes under the matched protocol.'}]];return {sha256:'a'.repeat(64),pages:2,text_pages,text_characters:text_pages.reduce((sum,page)=>sum+page.text.length,0),unread_pages:unread?[2]:[],warnings:unread?['第 2 页无可提取文字。']:[]};};
  const api=createBrowserApi({store,lockManager:locks(),fetchImpl,extractPdf});await api.configure(config);let project=(await api.handle('/api/projects'))[0];
  if(!project){project=await api.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'Synthetic topic'})});await api.handle(`/api/projects/${project.id}/scope`,{method:'PUT',body:JSON.stringify({research_question:'A research question longer than required for searching',keywords:['measurement controls'],inferred:false})});}
  return {api,project,calls,store};
}
const start=(api,project)=>api.handle(`/api/projects/${project.id}/jobs`,{method:'POST',body:JSON.stringify({count:1})});
async function settle(api,id){for(let i=0;i<500;i++){const job=await api.handle('/api/jobs/'+id);if(!['queued','running'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,1));}throw new Error('Fixture did not settle');}

test('short language-specific search queries use scope keywords instead of concatenating the entire question',()=>{
  const queries=searchQueries({research_question:'Do not search this long question',keywords:['色差测量','三维模型','color difference','measurement controls','surface geometry','extra English phrase']});assert.equal(queries.length,2);assert.match(queries[0],/^color difference/);assert.doesNotMatch(queries.join(' '),/Do not search|extra English/);assert.equal(queries[1],'色差测量 三维模型');assert.deepEqual(searchQueries({keywords:[]},'Fallback topic'),['Fallback topic']);
});

test('one run enriches missing Crossref abstract, obtains matching PDF text, and saves a directly readable report with real locators',async()=>{
  const {api,project,calls}=await setup();const job=await settle(api,(await start(api,project)).id),[paper]=await api.handle(`/api/projects/${project.id}/papers`);
  assert.equal(job.status,'completed');assert.equal(job.core_reports,1);assert.equal(job.reports_generated,1);assert.equal(job.fulltext_reports,1);assert.equal(job.abstract_reports,0);assert.equal(job.report_shortfall,0);assert.deepEqual(job.checkpoint.completed,['D001']);assert.equal(paper.analysis.source_basis,'fulltext');assert.equal(paper.analysis.report_label,'正文核心报告');assert.equal(paper.analysis.verified,false);assert.equal(paper.analysis.skill_applied,false);assert.deepEqual(paper.analysis.evidence[0].source_block_ids,['PDF-P1']);assert.deepEqual(paper.analysis.coverage.unread_pages,[]);assert.equal(paper.analysis.source_metadata.sha256,'a'.repeat(64));
  const source=await api.handle('/api/papers/'+paper.id+'/source'),candidateSource=await api.handle('/api/jobs/'+job.id+'/candidates/0/source');assert.deepEqual(source,candidateSource);assert.equal(source.basis,'fulltext');assert.match(source.blocks[0].text,/Methods: matched controls/);assert.equal(source.source_url,'https://papers.example/fixture.pdf');
  for(const call of calls.filter(c=>!c.url.startsWith(config.base_url))){assert.equal(call.options.headers?.Authorization,undefined);assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'error');}
  for(const kind of ['json','markdown','html']){const content=await (await api.handle(`/api/projects/${project.id}/export?kind=${kind}`)).text();assert.match(content,/PDF-P1/);assert.match(content,/Methods: matched controls/);assert.match(content,/正文核心报告/);assert.match(content,/papers.example\/fixture.pdf/);assert.equal(content.includes(secret),false);}
});

test('a Crossref outage still retains OpenAlex candidates while inaccessible full text does not count as a core report',async()=>{
  const {api,project}=await setup({pdfFails:true,openalexOnly:true});const job=await settle(api,(await start(api,project)).id),papers=await api.handle(`/api/projects/${project.id}/papers`);
  assert.equal(job.status,'waiting_sources');assert.equal(job.core_reports,0);assert.equal(job.reports_generated,0);assert.equal(job.abstract_reports,0);assert.deepEqual(papers,[]);const candidate=job.checkpoint.candidates[0];assert.equal(candidate.reading_source.basis,'abstract');assert.equal(candidate.abstract_preview,'Actual source abstract');assert.match(candidate.source_gaps.join(' '),/开放全文/);assert.equal(job.checkpoint.search_log.some(log=>log.source==='Crossref'&&log.error),true);assert.equal(job.checkpoint.search_log.some(log=>log.source==='OpenAlex'&&!log.error),true);
});

test('unread result pages retain a processing report in the candidate panel instead of counting a completed paper',async()=>{
  const {api,project}=await setup({unread:true}),job=await settle(api,(await start(api,project)).id);
  assert.equal(job.status,'waiting_sources');assert.equal(job.core_reports,0);assert.deepEqual(await api.handle(`/api/projects/${project.id}/papers`),[]);
  const detail=await api.handle(`/api/jobs/${job.id}/candidates/0`);assert.equal(detail.analysis.report_status,'processing');assert.deepEqual(detail.analysis.coverage.unread_pages,[2]);assert.match(detail.analysis.completion_gaps.join(' '),/不可读页面|关键结果/);
});

test('supplementing candidate full text resumes the same batch and registers exactly one newly completed report',async()=>{
  const {api,project,store}=await setup({pdfFails:true}),first=await settle(api,(await start(api,project)).id);assert.equal(first.status,'waiting_sources');
  const form=new FormData();form.append('file',new Blob(['%PDF synthetic fixed fixture'],{type:'application/pdf'}),'supplied-paper.pdf');
  const attached=await api.handle(`/api/jobs/${first.id}/candidates/0/pdf`,{method:'POST',body:form});assert.equal(attached.job_id,first.id);assert.equal(attached.reading_source.basis,'fulltext');
  await api.handle(`/api/jobs/${first.id}/retry`,{method:'POST'});const completed=await settle(api,first.id);assert.equal(completed.status,'completed');assert.equal(completed.core_reports,1);assert.equal(store.snapshot().counter,1);assert.equal((await api.handle(`/api/projects/${project.id}/papers`))[0].id,'D001');
});

test('supplementing an existing report preserves its identifier and revision history without counting a new paper',async()=>{
  const first=await setup();const original=await settle(first.api,(await start(first.api,first.project)).id),baseline=first.store.snapshot();baseline.papers[0].analysis.source_basis='abstract';baseline.papers[0].analysis.report_status='legacy';baseline.papers[0].analysis.summary='Preserved previous analysis';
  const {api,project,store}=await setup({store:memory(baseline)}),form=new FormData();form.append('file',new Blob(['%PDF supplemented fixed fixture'],{type:'application/pdf'}),'supplemented.pdf');
  const originalBatch=await api.handle(`/api/jobs/${original.id}`),attached=await api.handle('/api/papers/D001/source',{method:'POST',body:form});assert.notEqual(attached.job_id,original.id);
  assert.deepEqual(await api.handle(`/api/jobs/${original.id}`),originalBatch,'attaching a revision must not mutate its original batch');
  await api.handle(`/api/jobs/${attached.job_id}/retry`,{method:'POST'});const revised=await settle(api,attached.job_id),records=await api.handle(`/api/projects/${project.id}/papers`);
  assert.equal(revised.status,'completed');assert.equal(revised.requested,0);assert.equal(revised.revision_only,true);assert.equal(revised.core_reports,0);assert.equal(records.length,1);assert.equal(records[0].id,'D001');assert.equal(store.snapshot().counter,1);assert.equal(records[0].analysis.report_status,'completed');assert.equal(records[0].revisions.length,1);assert.equal(records[0].revisions[0].analysis.summary,'Preserved previous analysis');
  const unchanged=await api.handle(`/api/jobs/${original.id}`);assert.equal(unchanged.core_reports,originalBatch.core_reports);assert.equal(unchanged.status,originalBatch.status);assert.deepEqual(unchanged.checkpoint.candidates,originalBatch.checkpoint.candidates);
});

test('a failed report resumes the saved source without another PDF download or duplicate registration',async()=>{
  const {api,project,calls}=await setup({failAnalysis:true});let job=await settle(api,(await start(api,project)).id);assert.equal(job.status,'failed');assert.equal(job.checkpoint.candidates[0].reading_source.basis,'fulltext');assert.equal(job.reports_generated,0);
  await api.handle('/api/jobs/'+job.id+'/retry',{method:'POST'});job=await settle(api,job.id);assert.equal(job.reports_generated,1);assert.equal(job.fulltext_reports,1);assert.equal(calls.filter(call=>call.url.startsWith('https://papers.example/')).length,1);assert.equal((await api.handle(`/api/projects/${project.id}/papers`)).length,1);
});

test('retrying a legacy no-fulltext batch now supplements sources and generates a report',async()=>{
  const store=memory({version:1,counter:0,papers:[],links:[],references:[],publicSettings:{},projects:[{id:'legacy-project',name:'Legacy scope',scope:{research_question:'Legacy research scope',keywords:['measurement controls'],inferred:false}}],jobs:[{id:'legacy-job',project_id:'legacy-project',mode:'direct',requested:1,status:'completed',stage:'完成',drafts_analyzed:0,checkpoint:{scope_snapshot:{research_question:'Legacy research scope',keywords:['measurement controls'],inferred:false},completed:[],reused:[],drafts_analyzed:0,candidates:[{doi,title,source:'Crossref',status:'no_fulltext',abstract:'',enrichment_attempted:true,pdf_urls:[],publication_status:'published'}],searched_ranges:['2024','2021','all'],diagnostics:[],search_log:[]}}]});
  const {api}=await setup({store});await api.handle('/api/jobs/legacy-job/retry',{method:'POST'});const job=await settle(api,'legacy-job');assert.equal(job.status,'completed');assert.equal(job.reports_generated,1);assert.equal(job.fulltext_reports,1);assert.equal((await api.handle('/api/projects/legacy-project/papers'))[0].id,'D001');
});

test('deleting a project preserves deduplication identity without attaching its report to another topic',async()=>{
  const {api,project,store}=await setup();await settle(api,(await start(api,project)).id);const second=await api.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'Second scope'})});await api.handle(`/api/projects/${second.id}/scope`,{method:'PUT',body:JSON.stringify({research_question:'Different scope',inferred:false})});await settle(api,(await start(api,second)).id);
  const result=await api.handle('/api/projects/'+project.id,{method:'DELETE'});assert.equal(result.deleted,true);assert.equal((await api.handle('/api/projects')).length,1);assert.equal(store.snapshot().counter,1);assert.equal(store.snapshot().papers.length,1);assert.equal(store.snapshot().links.length,0);assert.equal(store.snapshot().jobs.every(job=>job.project_id===second.id),true);assert.deepEqual(await api.handle(`/api/projects/${second.id}/papers`),[]);await assert.rejects(api.handle(`/api/projects/${project.id}/papers`),/不存在/);await settle(api,(await start(api,second)).id);assert.equal(store.snapshot().counter,1);assert.equal((await api.handle(`/api/projects/${second.id}/papers`)).length,0);
});

test('deletion waits for its active batch to actually stop',async()=>{
  let started;const gateStarted=new Promise(resolve=>{started=resolve;});const {api,project}=await setup({gate:signal=>new Promise((resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(new Error('cancelled fixture')),{once:true});})});const job=await start(api,project);await gateStarted;await assert.rejects(api.handle('/api/projects/'+project.id,{method:'DELETE'}),/先取消/);await api.handle('/api/jobs/'+job.id+'/cancel',{method:'POST'});await settle(api,job.id);assert.equal((await api.handle('/api/projects/'+project.id,{method:'DELETE'})).deleted,true);
});
