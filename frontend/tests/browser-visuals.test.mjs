import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {createBrowserApi} from '../browser-api.js';
import {imageSha256} from '../paper-visuals.js';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const secret='fixture-visual-key-never-public';
const title='A synthetic visual evidence measurement study';
const copy=value=>JSON.parse(JSON.stringify(value));
const answer=value=>Response.json({choices:[{message:{content:JSON.stringify(value)}}]});
const locks={query:async()=>({held:[]}),request:async(_name,options,callback)=>(typeof options==='function'?options:callback)({name:'fixture-lock'})};
async function setup({vision='fixture-vision',visualReply=null,failVision=false,gate=null,tamper=false,requiredVisualPages=[2,3,4,5]}={}){
  let saved=null;const calls=[],extractions=[];
  const store={load:async()=>saved&&copy(saved),save:async value=>{saved=copy(value);}};
  const fetchImpl=async(url,options={})=>{
    url=String(url);calls.push({url,options});
    if(url.startsWith('https://api.crossref.org/works'))return Response.json({message:{items:[{DOI:'10.5555/visual-fixture',title:[title],abstract:'Actual fixed fixture abstract.',type:'journal-article','container-title':['Synthetic Fixture Journal'],published:{'date-parts':[[2026,1]]},link:[{'content-type':'application/pdf',URL:'https://papers.example/fixture.pdf'}]}]}});
    if(url.startsWith('https://api.openalex.org/works'))return Response.json({results:[]});
    if(url==='https://papers.example/fixture.pdf')return new Response('%PDF-1.7 fixed public synthetic fixture bytes');
    assert.equal(url,'https://models.example/v1/chat/completions');
    const body=JSON.parse(options.body),user=body.messages[1].content;
    if(Array.isArray(user)){
      if(gate)await gate(options.signal);
      if(failVision)return Response.json({error:{code:'insufficient_quota',message:secret}},{status:429});
      return answer(visualReply??{items:[{type:'figure',label:'Figure 2',readable:true,explanation:'The visible synthetic panel compares treatment and control.',comparison:'Treatment and control',axes_units:'Time (s); displacement (mm)',page:99,inspection_id:'model-forgery',source_sha256:'model-forgery'}]});
    }
    const input=JSON.parse(user);
    if(input.task==='search-plan')return answer({queries:[{query:input.topic.keywords[0]||'measurement controls',language:'en',intent:'Synthetic query fixture'}]});
    if(input.candidates)return answer({selected:input.candidates.map((_,index)=>({index,reason:'Directly addresses the fixture question.',score:0.95})),excluded:[]});
    if(input.blocks)return answer({notes:input.blocks.map(block=>({source_block_ids:[block.id],text:block.text})),required_visual_pages:requiredVisualPages});
    return answer({summary:'Fixed text-grounded synthetic report.',verified:true,core_coverage:{question:{summary:'How do treatment and control compare?',source_block_ids:['PDF-P1']},methods:{summary:'Measure matched treatment and control.',source_block_ids:['PDF-P2']},results:{summary:'The panel reports different outcomes.',source_block_ids:['PDF-P2']}},required_visual_pages:requiredVisualPages,evidence:[{id:'E01',claim:'A text-located comparison',observation:'The supplied caption compares treatment and control.',source_block_ids:['PDF-P2']}],visuals:[{page:99,label:'Model-only fabricated figure',inspection_status:'verified'}],flow_steps:['Source input','Measured output']});
  };
  const extractPdf=async(file,options)=>{
    extractions.push(options);const sha256=createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex'),image_sha256=await imageSha256(png,webcrypto);
    const text_pages=[{page:1,text:title},{page:2,text:'Figure 2. Treatment and control; time (s), displacement (mm).'}];
    return {sha256,pages:6,text_pages,text_characters:text_pages.reduce((sum,page)=>sum+page.text.length,0),unread_pages:[],warnings:[],...(options.captureVisualPages?{page_images:[2,3,4,5].map(page=>({page,mime:'image/png',source_sha256:sha256,image_sha256:tamper&&page===2?'f'.repeat(64):image_sha256,image_data_url:png}))}:{})};
  };
  const api=createBrowserApi({store,fetchImpl,extractPdf,cryptoImpl:webcrypto,lockManager:locks});
  await api.configure({base_url:'https://models.example/v1',api_key:secret,text_model:'fixture-text',vision_model:vision});
  const project=await api.handle('/api/projects',{method:'POST',body:JSON.stringify({name:'Synthetic visual topic'})});
  await api.handle(`/api/projects/${project.id}/scope`,{method:'PUT',body:JSON.stringify({research_question:'Compare measured treatment and control.',keywords:['fixture'],inferred:false})});
  const job=await api.handle(`/api/projects/${project.id}/jobs`,{method:'POST',body:JSON.stringify({count:1})});
  return {api,project,job,calls,extractions,snapshot:()=>saved};
}
async function finish(fixture){
  for(let n=0;n<1000;n++){
    const job=await fixture.api.handle(`/api/jobs/${fixture.job.id}`);
    if(!['queued','running'].includes(job.status))return job;
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  throw new Error('Synthetic visual job did not finish');
}
const imageCalls=fixture=>fixture.calls.filter(call=>call.options.body&&Array.isArray(JSON.parse(call.options.body).messages[1].content));

test('optional image analysis sends actual bounded source pages to the selected vision model and stamps only actual results',async()=>{
  const fixture=await setup(),job=await finish(fixture),[paper]=await fixture.api.handle(`/api/projects/${fixture.project.id}/papers`),a=paper.analysis;
  assert.equal(job.status,'completed');assert.equal(fixture.extractions[0].captureVisualPages,false);assert.equal(fixture.extractions[1].captureVisualPages,true);assert.deepEqual(fixture.extractions[1].visualPages,[2,3,4,5]);assert.equal(imageCalls(fixture).length,4);assert.equal(a.visuals.length,4);assert.deepEqual(a.coverage.visual_pages_checked,[2,3,4,5]);
  for(const call of imageCalls(fixture)){
    const body=JSON.parse(call.options.body);assert.equal(body.model,'fixture-vision');assert.equal(body.messages[1].content[1].type,'image_url');assert.equal(body.messages[1].content[1].image_url.url,png);assert.equal(body.messages[1].content[1].image_url.detail,'high');
  }
  for(const visual of a.visuals){assert.notEqual(visual.inspection_id,'model-forgery');assert.notEqual(visual.page,99);assert.equal(visual.inspection_status,'verified');assert.equal(visual.inspection_method,'vision_model');assert.equal(visual.source_sha256,a.source_metadata.sha256);assert.match(visual.inspected_at,/^202\d-/);assert.match(visual.inspection_note,/未经人工复核/);assert.equal(visual.image_data_url,png);}
  assert.equal(a.verified,false);assert.equal(a.skill_applied,false);assert.match(a.verification_status,/关键原页已有视觉模型查看记录/);assert.equal(a.visuals.some(item=>item.label.includes('fabricated')),false);
  const original=await fixture.api.handle(`/api/papers/${paper.id}/assets/page-2.png`);assert.equal(original.type,'image/png');assert.ok((await original.arrayBuffer()).byteLength>8);
  const detail=await fixture.api.handle(`/api/jobs/${job.id}/candidates/0`);assert.deepEqual(detail.artifacts.checked_visual_pages,[2,3,4,5]);const candidateImage=await fixture.api.handle(`/api/jobs/${job.id}/candidates/0/assets/page-2.png`);assert.equal(candidateImage.type,'image/png');
  assert.equal(paper.reading_source.page_images,undefined);assert.equal(JSON.stringify(fixture.snapshot()).includes(secret),false);assert.equal(fixture.calls.filter(call=>!call.url.startsWith('https://models.example')).every(call=>!call.options.headers?.Authorization),true);
});

test('an empty vision model leaves required originals processing and never promotes text-model verification claims',async()=>{
  const fixture=await setup({vision:''}),job=await finish(fixture);assert.deepEqual(await fixture.api.handle(`/api/projects/${fixture.project.id}/papers`),[]);const detail=await fixture.api.handle(`/api/jobs/${job.id}/candidates/0`);
  assert.equal(job.status,'waiting_sources');assert.equal(job.core_reports,0);assert.equal(fixture.extractions[0].captureVisualPages,false);assert.equal(imageCalls(fixture).length,0);assert.deepEqual(detail.analysis.visuals,[]);assert.equal(detail.analysis.verified,false);assert.equal(fixture.api.getSettings().visual_verification,false);assert.match(detail.analysis.completion_gaps.join(' '),/核心图表/);
  const optional=await setup({vision:'',requiredVisualPages:[]}),finished=await finish(optional);assert.equal(finished.core_reports,1,'a text-grounded report that genuinely requires no original image can complete');
});

test('reading scope and source notices reflect only successfully inspected source pages while keeping remaining limits',async()=>{
  const fixture=await setup();await finish(fixture);const [paper]=await fixture.api.handle(`/api/projects/${fixture.project.id}/papers`),scope=paper.analysis.research_logic.reading_scope;
  assert.match(scope.acquired.join(' '),/PDF 第 2、3、4、5 页原始页图/);assert.equal(scope.verified.length,4);assert.match(scope.verified[0],/第 2 页.*Figure 2.*未经人工复核/);
  assert.doesNotMatch(scope.unverified.join(' '),/原图、表格及公式尚未视觉核验/);assert.match(scope.unverified.join(' '),/其他图表与公式未核验/);assert.match(scope.unverified.join(' '),/norman-paper-reading/);assert.match(scope.unverified.join(' '),/出版社页面/);
  const source=await fixture.api.handle(`/api/papers/${paper.id}/source`),detail=await fixture.api.handle(`/api/jobs/${fixture.job.id}/candidates/0`);assert.match(source.notice,/仅 PDF 第 2、3、4、5 页/);assert.match(detail.notice,/关键原页已有视觉模型查看记录/);assert.equal(paper.analysis.verified,false);
  const plain=await setup({vision:'',requiredVisualPages:[]});await finish(plain);const [textPaper]=await plain.api.handle(`/api/projects/${plain.project.id}/papers`);assert.deepEqual(textPaper.analysis.research_logic.reading_scope.verified,[]);assert.match(textPaper.analysis.research_logic.reading_scope.unverified.join(' '),/原图、表格及公式尚未视觉核验/);assert.match((await plain.api.handle(`/api/papers/${textPaper.id}/source`)).notice,/尚未视觉核验/);
});

test('vision provider errors retain usable text in a processing candidate without false records or leaked provider bodies',async()=>{
  const fixture=await setup({failVision:true}),job=await finish(fixture),detail=await fixture.api.handle(`/api/jobs/${job.id}/candidates/0`),a=detail.analysis;
  assert.equal(job.status,'waiting_sources');assert.equal(job.reports_generated,0);assert.equal(job.core_reports,0);assert.match(a.summary,/Fixed text/);assert.deepEqual(a.visuals,[]);assert.equal(a.verified,false);assert.equal(a.visual_inspection_audit.length,4);assert.ok(a.visual_inspection_audit.every(row=>row.status==='failed'));assert.equal(JSON.stringify(fixture.snapshot()).includes(secret),false);await assert.rejects(fixture.api.handle(`/api/jobs/${job.id}/candidates/0/assets/page-2.png`),/原图尚未获取或核验/);
});

test('tampered page bytes are never sent and unreadable model results never become inspection stamps',async()=>{
  const fixture=await setup({tamper:true,visualReply:{items:[{type:'figure',label:'Figure 2',readable:false,explanation:'Cannot read'},{type:'figure',label:'Figure',readable:true,explanation:'Generic placeholder'}]}}),job=await finish(fixture),detail=await fixture.api.handle(`/api/jobs/${job.id}/candidates/0`),a=detail.analysis;
  assert.equal(job.core_reports,0);assert.equal(imageCalls(fixture).length,3);assert.deepEqual(a.visuals,[]);assert.equal(a.visual_inspection_audit[0].status,'failed');assert.match(a.visual_inspection_audit[0].reason,/指纹不匹配/);assert.ok(a.visual_inspection_audit.slice(1).every(row=>row.status==='no_readable_items'));
});

test('cancelling an image request registers no unfinished report or asset while preserving the candidate checkpoint',async()=>{
  let signalStarted;const started=new Promise(resolve=>{signalStarted=resolve;});
  const fixture=await setup({gate:signal=>new Promise((_,reject)=>{signalStarted();signal.addEventListener('abort',()=>reject(Object.assign(new Error('Fixture aborted'),{name:'AbortError'})),{once:true});})});
  await started;await fixture.api.handle(`/api/jobs/${fixture.job.id}/cancel`,{method:'POST'});const job=await finish(fixture);
  assert.equal(job.status,'cancelled');assert.equal(job.reports_generated,0);assert.deepEqual(await fixture.api.handle(`/api/projects/${fixture.project.id}/papers`),[]);assert.equal(job.checkpoint.candidates.length,1);assert.equal(job.checkpoint.candidates[0].status,'pending');
});
