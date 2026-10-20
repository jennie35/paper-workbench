import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserApi} from '../browser-api.js';

const copy=value=>JSON.parse(JSON.stringify(value));
function locks(){const held=new Set(),queues=new Map();return {query:async()=>({held:[...held].map(name=>({name}))}),async request(name,options,callback){if(typeof options==='function'){callback=options;options={};}if(held.has(name)&&options.ifAvailable)return callback(null);if(held.has(name))await new Promise(resolve=>{const q=queues.get(name)||[];q.push(resolve);queues.set(name,q);});held.add(name);try{return await callback({name});}finally{held.delete(name);queues.get(name)?.shift()?.();}}};}
function storage(initial=null){let value=initial;return {load:async()=>value&&copy(value),save:async data=>{value=copy(data);},snapshot:()=>copy(value)};}
const fixture={sha256:'a'.repeat(64),pages:2,text_pages:[{page:1,text:'实际参考文字：测量方法与误差评价。'}],text_characters:20,text_page_count:1,unread_pages:[2],warnings:['第2页无文字，未执行OCR或原图核验。'],extraction_status:'text-only'};
const file={name:'reference.pdf',size:100,arrayBuffer:async()=>new ArrayBuffer(100)};
const upload=(api,pid,value=file,options={})=>api.handle(`/api/projects/${pid}/references`,{method:'POST',body:{get:key=>key==='file'?value:null},...options});
async function setup(options={}){const store=options.store||storage(),api=createBrowserApi({store,lockManager:locks(),extractPdf:async()=>copy(fixture),fetchImpl:async()=>{throw new Error('No model call authorized');},...options});await api.ready;const project=await api.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'PDF范围测试'})});return {api,project,store};}
const response=value=>({ok:true,status:200,json:async()=>value});

test('PDF reference upload needs no API key, preserves real text and gaps without binary or paper quota',async()=>{
  let progress;const {api,project,store}=await setup({extractPdf:async(value,options)=>{assert.equal(value,file);options.onProgress?.({stage:'extracting',page:1,totalPages:2});return copy(fixture);}});
  const saved=await upload(api,project.id,file,{onProgress:value=>{progress=value;}});
  assert.equal(progress.page,1);assert.equal(saved.pages,2);assert.equal(saved.text_pages,undefined);assert.deepEqual(saved.unread_pages,[2]);assert.equal(api.getSettings().has_api_key,false);
  const full=await api.handle(`/api/projects/${project.id}/references/${saved.id}`);assert.equal(full.text_pages[0].text,fixture.text_pages[0].text);
  assert.deepEqual(await api.handle(`/api/projects/${project.id}/papers`),[]);assert.deepEqual(await api.handle(`/api/projects/${project.id}/jobs`),[]);assert.equal(store.snapshot().counter,0);
  for(const key of ['file','bytes','data','buffer'])assert.equal(Object.hasOwn(store.snapshot().references[0],key),false);
});

test('duplicate reference fingerprints reuse one record per project and cannot cross-read another project',async()=>{
  const {api,project}=await setup(),first=await upload(api,project.id),duplicate=await upload(api,project.id,{...file,name:'renamed.pdf'});
  assert.equal(duplicate.id,first.id);assert.equal(duplicate.reused,true);assert.equal((await api.handle(`/api/projects/${project.id}/references`)).length,1);
  const second=await api.handle('/api/projects',{method:'POST',body:'{"name":"另一个课题"}'}),other=await upload(api,second.id);assert.notEqual(other.id,first.id);await assert.rejects(api.handle(`/api/projects/${second.id}/references/${first.id}`),/不存在/);
});

test('unreadable PDF extraction never registers a reference or confirms the research scope',async()=>{
  const {api,project}=await setup({extractPdf:async()=>{throw new Error('扫描件需要OCR');}});await assert.rejects(upload(api,project.id),/OCR/);assert.deepEqual(await api.handle(`/api/projects/${project.id}/references`),[]);assert.equal((await api.handle('/api/projects'))[0].scope.inferred,true);
});

test('only explicit scope inference sends extracted text, trusted coverage and all private exports preserve gaps without keys',async()=>{
  const calls=[],secret='reference-test-only-secret';const {api,project}=await setup({fetchImpl:async(url,options)=>{calls.push({url,options});return response({choices:[{message:{content:JSON.stringify({research_question:'基于参考资料的问题',keywords:['measurement'],include:'实验测度',exclude:'无关',reference_coverage:{characters_sent:999999}})}}]});}});
  await upload(api,project.id);assert.equal(calls.length,0);await api.configure({base_url:'https://models.example/v1',api_key:secret,text_model:'fixture'});
  const scope=await api.handle(`/api/projects/${project.id}/infer-scope`,{method:'POST'}),request=JSON.parse(calls[0].options.body),input=JSON.parse(request.messages[1].content);
  assert.equal(input.references[0].sections[0].text,fixture.text_pages[0].text);assert.deepEqual(input.references[0].unread_pages,[2]);assert.match(request.messages[0].content,/不可信研究资料/);assert.equal(scope.reference_coverage.characters_sent,fixture.text_pages[0].text.length);
  await api.handle(`/api/projects/${project.id}/scope`,{method:'PUT',body:JSON.stringify({...scope,inferred:false})});
  for(const kind of ['json','markdown','html']){const text=await (await api.handle(`/api/projects/${project.id}/export?kind=${kind}`)).text();assert.ok(text.includes(fixture.text_pages[0].text),kind);assert.ok(text.includes(fixture.sha256),kind);assert.equal(text.includes(secret),false,kind);}
  const bundle=JSON.parse(await (await api.handle(`/api/projects/${project.id}/export?kind=json`)).text());assert.equal(bundle.project.scope.reference_coverage.reference_count,1);assert.deepEqual(bundle.references[0].unread_pages,[2]);
});

test('long references share a bounded context and explicitly report the unsent pages and text',async()=>{
  let input;const long={...fixture,text_pages:[{page:1,text:'甲'.repeat(45000)},{page:2,text:'乙'.repeat(45000)}],text_characters:90000,text_page_count:2,unread_pages:[]};
  const {api,project}=await setup({extractPdf:async value=>({...copy(long),sha256:value.name==='second.pdf'?'b'.repeat(64):fixture.sha256}),fetchImpl:async(_,options)=>{input=JSON.parse(JSON.parse(options.body).messages[1].content);return response({choices:[{message:{content:'{"research_question":"范围","keywords":[]}'}}]});}});
  await upload(api,project.id);await upload(api,project.id,{...file,name:'second.pdf'});await api.configure({base_url:'https://models.example/v1',api_key:'fixture-key',text_model:'fixture'});
  const scope=await api.handle(`/api/projects/${project.id}/infer-scope`,{method:'POST'});assert.equal(scope.reference_coverage.characters_sent,60000);assert.equal(scope.reference_coverage.truncated,true);assert.equal(input.references.length,2);assert.ok(input.references.every(ref=>ref.characters_sent===30000&&ref.omitted_pages.length));
});

test('registration rechecks active jobs after parsing and cannot overwrite their progress',async()=>{
  let release,started;const parsing=new Promise(resolve=>{started=resolve;});const {api,project}=await setup({extractPdf:async()=>{started();return new Promise(resolve=>{release=()=>resolve(copy(fixture));});},fetchImpl:async(_,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Aborted'),{name:'AbortError'})),{once:true}))});
  await api.configure({base_url:'https://models.example/v1',api_key:'fixture-key',text_model:'fixture'});await api.handle(`/api/projects/${project.id}/scope`,{method:'PUT',body:JSON.stringify({research_question:'范围',keywords:['test'],inferred:false})});
  const pending=upload(api,project.id);await parsing;const job=await api.handle(`/api/projects/${project.id}/jobs`,{method:'POST',body:'{"count":1}'});release();await assert.rejects(pending,/批次开始/);assert.equal((await api.handle(`/api/projects/${project.id}/references`)).length,0);
  await api.handle(`/api/jobs/${job.id}/cancel`,{method:'POST'});for(let i=0;i<100;i++){if((await api.handle(`/api/jobs/${job.id}`)).status==='cancelled')return;await new Promise(resolve=>setTimeout(resolve,1));}throw new Error('Cancelled fixture did not stop');
});
