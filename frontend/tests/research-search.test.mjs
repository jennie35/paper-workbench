import test from 'node:test';
import assert from 'node:assert/strict';
import {searchTopic,normalizeSearchPlan,selectedCandidates,compareCandidates,searchDiagnosis} from '../research-search.js';

test('bilingual query planning is bounded and never consumes missing resources or model supplied citations',()=>{
  const topic=searchTopic({research_question:'全彩打印的颜色测量如何关联几何与表面特征？',keywords:['full color 3D printing'],known_resources:'PRIVATE INSTRUMENT',reference_materials:'C:/private/file.pdf',storage_root:'C:/private',constraints:'PRIVATE BUDGET'},'科研课题');
  assert.equal('known_resources' in topic,false);assert.doesNotMatch(JSON.stringify(topic),/PRIVATE|C:\//);
  const plan=normalizeSearchPlan({queries:[{query:'full color 3D printing measurement',intent:'Direct colour measurement'},{query:'全彩三维打印 颜色测量'},...Array.from({length:8},(_,i)=>({query:'measurement '+i}))],papers:[{doi:'10.1234/invented'}]},['fallback']);
  assert.equal(plan.queries.length,4);assert.equal(plan.origin,'configured_text_model');assert.equal(plan.queries[1].language,'zh');assert.equal('papers' in plan,false);
  assert.deepEqual(normalizeSearchPlan({queries:[{query:'https://fake.example/paper'}]},['actual topic']).queries.map(x=>x.query),['actual topic']);
});

test('shortlisting only indexes actual metadata and prioritizes readable relevant sources without an arbitrary score cut',()=>{
  const candidates=[{title:'Actual closed work',relevance_score:.99,relevance_class:'direct',pdf_urls:[]},{title:'Actual open work',relevance_score:.65,relevance_class:'direct',pdf_urls:['https://papers.example/a.pdf']}];
  const chosen=selectedCandidates({selected:[{index:0,reason:'A directly relevant method',score:.65},{index:99,reason:'Invented source',doi:'10.1/fake'},{index:1,reason:'Only background',relevance_class:'background'}]},candidates);
  assert.deepEqual([...chosen.keys()],[0]);assert.equal(chosen.get(0).score,.65);assert.deepEqual(candidates.slice().sort(compareCandidates).map(x=>x.title),['Actual open work','Actual closed work']);
});

test('a concise search diagnosis distinguishes relevant paywalls, pending analysis and connection failures',()=>{
  const diagnosis=searchDiagnosis({requested:5,checkpoint:{core_reports:0,candidates:[{status:'no_fulltext',relevance_reason:'Direct measurement',source_gaps:['开放全文：连接失败；接口跨域限制。']},{status:'unverified',relevance_reason:'Applicable method'}],search_log:[{source:'Crossref',error:'HTTP 429'}]}});
  assert.equal(diagnosis.relevant,2);assert.equal(diagnosis.fulltext_unavailable,1);assert.equal(diagnosis.analysis_pending,1);assert.equal(diagnosis.completed,0);assert.match(diagnosis.next_steps.join(' '),/PDF/);assert.equal(diagnosis.source_errors.length,2);
});
