import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {recordEvidence,recordMarkdown,researchFlowSvg,exportResearchMarkdown,exportOfflineHtml} from '../research-export.js';
const paper={id:'D001',title:'Synthetic <script>not-executable()</script>',authors:['Fixture author'],publication_date:'2026-08',url:'https://papers.example/fixture',themes:['Measurement'],analysis:{summary:'Saved source summary',source_basis:'abstract',verified:false,skill_applied:false,analyzed_date:'2026-10-21',verification_gaps:['No original figure'],source_blocks:[{id:'ABSTRACT-1',text:'Actual text only'}],flow_steps:['Author model','Author measurement'],project_context:{scope_snapshot:{known_resources:'Known resources only'}},research_logic:{storyline:{reconstructed_question:'Reconstructed, not author fact'},reading_priorities:[{locator:'Methods, location unverified',reason:'Check independence',decision_impact:'Whether evidence transfers'}]},actions:[{id:'A01',title:'Check independent reference',priority:'P0',stopping_criteria:'Stop if source is unavailable'}]}};
const bundle={notice:'未执行外部技能；原图与公式未视觉核验。',project:{name:'Synthetic offline project',scope:{research_question:'A specific question',known_resources:'Known resources only'}},papers:[paper],references:[{sha256:'synthetic-fingerprint',text_pages:[{page:1,text:'Reference text actually supplied'}]}],jobs:[{id:'job1',status:'completed',requested:5,reports_generated:1,created_at:'2026-10-21',checkpoint:{candidates:[{paper_id:'D001',title:paper.title,reason:'Source-limited analysis'}],report_shortfall:4,search_log:[{query:'Synthetic query'}],synthesis:{status:'completed',record_ids:['D001'],limitations:['One paper cannot establish cross-paper agreement'],priority_actions:[{record_id:'D001',action_id:'A01',reason:'Reduce uncertainty'}]}}}]};

test('Markdown, evidence and HTML project identical saved content with eleven sections and source boundaries',()=>{
  const note=recordMarkdown(paper),evidence=recordEvidence(paper),md=exportResearchMarkdown(bundle),html=exportOfflineHtml(bundle);
  for(const item of [note,md,html]){assert.match(item,/Saved source summary/);assert.match(item,/Actual text only/);assert.match(item,/Known resources only/);assert.match(item,/Stop if source is unavailable/);for(let i=1;i<=11;i++)assert.match(item,new RegExp(`${i}\\. `));}
  assert.deepEqual(evidence.actions,paper.analysis.actions);assert.equal(evidence.verified,false);assert.equal(evidence.skill_applied,false);assert.deepEqual(evidence.source_blocks,paper.analysis.source_blocks);
  for(const item of [md,html]){assert.match(item,/Reference text actually supplied/);assert.match(item,/synthetic-fingerprint/);assert.match(item,/Synthetic query/);assert.match(item,/Source-limited analysis/);assert.match(item,/One paper cannot establish/);}
});

test('offline artifact has local controls and no remote executable dependencies or interpolated script content',()=>{
  const html=exportOfflineHtml(bundle);assert.match(html,/data-latest="true"/);assert.match(html,/id="keyword"/);assert.match(html,/id="date"/);assert.match(html,/id="theme"/);assert.match(html,/id="priority"/);
  assert.doesNotMatch(html,/<script\s+src|<link\s|<img|fetch\(|import\s/);assert.doesNotMatch(html,/<script>not-executable/);assert.match(html,/&lt;script&gt;not-executable/);assert.equal((html.match(/<script /g)||[]).length,1);
  const svg=researchFlowSvg(['<image href="https://unsafe.example"/>','实际来源'],'abstract');assert.match(svg,/分析者绘制，非论文原图/);assert.doesNotMatch(svg,/<image /);assert.match(svg,/&lt;image/);
});

test('offline filters work without network, retaining separate evidence and pending-action views',()=>{
  const html=exportOfflineHtml(bundle),script=html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1],listeners=new Map();
  const input=id=>({value:'',addEventListener:(kind,fn)=>listeners.set(id,fn)}),fields={'#keyword':input('keyword'),'#date':input('date'),'#theme':input('theme'),'#priority':input('priority'),'#count':{textContent:''},'#empty':{hidden:true}};
  const sections=['scope','summary','visuals','evidence','reading','future','actions','sources'].map(id=>({dataset:{section:id},hidden:false})),detail={open:false};
  const card={dataset:{latest:'true',search:'synthetic independent reference',date:'2026-10-21',themes:'Measurement',priorities:'P0'},hidden:false,querySelectorAll:()=>sections,querySelector:()=>detail};
  const buttons=['latest','all','evidence','actions'].map(view=>({dataset:{view},setAttribute(){},addEventListener:(kind,fn)=>listeners.set(view,fn)}));
  const document={querySelector:key=>fields[key],querySelectorAll:key=>key==='[data-paper]'?[card]:key==='[data-view]'?buttons:key==='.filters input,.filters select'?Object.entries(fields).filter(([k])=>['#keyword','#date','#theme','#priority'].includes(k)).map(([,v])=>v):[]};
  vm.runInNewContext(script,{document});assert.equal(card.hidden,false);listeners.get('evidence')();assert.equal(sections.find(x=>x.dataset.section==='summary').hidden,true);assert.equal(sections.find(x=>x.dataset.section==='visuals').hidden,false);
  listeners.get('actions')();assert.equal(detail.open,true);assert.equal(sections.find(x=>x.dataset.section==='actions').hidden,false);assert.equal(sections.find(x=>x.dataset.section==='evidence').hidden,true);
  fields['#keyword'].value='missing';listeners.get('keyword')();assert.equal(card.hidden,true);assert.equal(fields['#empty'].hidden,false);
  fields['#keyword'].value='reference';fields['#theme'].value='Measurement';fields['#priority'].value='P0';fields['#date'].value='2026-10-21';listeners.get('date')();assert.equal(card.hidden,false);
  fields['#priority'].value='P1';listeners.get('priority')();assert.equal(card.hidden,true);
});
