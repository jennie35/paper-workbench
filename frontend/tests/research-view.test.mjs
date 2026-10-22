import test from 'node:test';
import assert from 'node:assert/strict';
import {reportSections,synthesisHtml,hasReportContent,referenceValue} from '../research-view.js';
const paper={id:'D001',title:'Synthetic source report',doi:'10.5555/fixture',year:2026,publication_date:'2026-08',authors:['Fixture author'],analysis:{summary:'Actual source summary.',scientific_question:'A source-grounded question?',flow_steps:['Read actual source','Record gaps'],actions:[{id:'A01',title:'Obtain missing evidence',hypothesis:'A falsifiable proposed check',experimental_unit:'Independent specimen, not repeated sensor reads',stopping_criteria:'Stop if the reference cannot be identified',resources:'Unknown; do not invent devices',sample_size_basis:'Estimate in pilot',evidence_ids:['E01']}],evidence:[{id:'E01',claim:'A checked text claim',observation:'Actually provided text',source_block_ids:['B01'],interpretation:'Analyst inference',limits:'No original figure'}],verification_gaps:['Original figure unavailable'],research_logic:{paper_type:'method',study_design:{type:'method',fields:{train_test_split:'Independent split',data_leakage:'Must be checked',baselines_fairness:'Equal acquisition conditions'}},storyline:{author_question:'Author question',reconstructed_question:'Analyst reconstruction',gap:'Source gap'},design_decisions:[{id:'D01',decision:'Control acquisition',rationale_origin:'analyst',cost:'Lower throughput',alternative:'Separate calibration'}],reading_priorities:[{locator:'Methods 2.1',reason:'Check sample independence',decision_impact:'Whether comparison can transfer',source_block_ids:['B01']}],transfer_insights:{direct:'Preserve units',adapt:'Recalibrate for user system',avoid:'Do not claim measured truth from rendering',judgement_change:'Need an independent reference'}}}};

test('report projection keeps actual analysis and publication-date precision without empty sections',()=>{
  const sections=reportSections(paper),html=sections.map(x=>x[2]).join('');
  assert.deepEqual(sections.map(x=>x[0]),['scope','summary','storyline','flow','design','decisions','evidence','reading','future','actions','sources']);
  assert.match(html,/2026-08/);assert.doesNotMatch(html,/2026-08-01|首次发表日期/);assert.match(html,/Author question/);assert.match(html,/Analyst reconstruction/);assert.match(html,/基线公平性/);assert.match(html,/Lower throughput/);assert.match(html,/停止条件/);assert.match(html,/Independent specimen/);assert.match(html,/Original figure unavailable/);
  assert.doesNotMatch(html,/<dt>面板<\/dt>|<dt>设备<\/dt>|<dd>未报告|尚无专项记录|未提供已实际查看的原图/);
});

test('review design retains real review type and evidence boundary without invented experimental fields',()=>{
  const legacy={...paper,analysis:{summary:'Legacy summary',research_logic:{study_design:{type:'review',fields:{selection_method:'Unreported',review_type:'Narrative review'}}}}};
  const html=reportSections(legacy).map(x=>x[2]).join('');assert.match(html,/不构成新增实验/);assert.match(html,/未实施荟萃分析/);assert.match(html,/Narrative review/);assert.doesNotMatch(html,/>已目视核验<|Unreported|筛选方法|<dt>样本<\/dt>/);
});

test('nested empty and placeholder values do not create fields or report sections',()=>{
  for(const value of [null,undefined,'  ','未报告。','未核验','摘要未报告样本量','Not reported','Not reported in the supplied abstract',[],{},['',null,{},['未知']],{samples:{count:null},devices:[],statistics:'已取得的来源未报告或未核验，需核对原文。'}])assert.equal(hasReportContent(value),false);
  for(const value of [0,false,'Only technical repeats were reported; independence is unresolved.',{count:0},{controls:['Actual reference']}])assert.equal(hasReportContent(value),true);
  const empty={analysis:{summary:' ',flow_steps:['未报告'],actions:[{id:'A01',priority:'P1',method:'未核验'}],research_logic:{study_design:{type:'method',fields:{train_test_split:{description:'未报告'},external_validation:[]}},storyline:{gap:'未核验'},design_decisions:[{id:'D01',decision:'未报告',rationale_origin:'unknown'}],evidence_review:[{locator:'核心图表及公式尚未定位或目视核验',claim:'无法由当前来源完成原图核验。',verification_status:'unverified'}],reading_priorities:[{kind:'section',locator:'未定位；需取得原文确认',reason:'未报告'}],pitfalls:[{kind:'相关性与因果',assessment:'当前来源不足以判断，需在精读中核对。'}],transfer_insights:{direct:'未报告'}}}};
  const sections=reportSections(empty),html=sections.map(x=>x[2]).join('');
  assert.deepEqual(sections.map(x=>x[0]),['scope']);assert.match(html,/核验状态/);assert.doesNotMatch(html,/已目视核验|A01|D01|<dl>|实际资料/);
});

test('substantive uncertainty, zero counts and actual unverified evidence remain visible',()=>{
  const limited={analysis:{verified:false,reading_basis:'实际摘要',research_logic:{study_design:{type:'experiment',fields:{samples:0,equipment:'未报告',controls:{reference:'An independent reference'}}},conclusion_layers:{analyst_inference:'Only technical repeats were reported; independence is unresolved.'},evidence_review:[{locator:'Figure 2',claim:'The reported trend comes from simulations, not measured parts.',verification_status:'unverified',uncertainty:'No independent specimen-level uncertainty was provided.'}]}}};
  const html=reportSections(limited).map(x=>x[2]).join('');
  assert.match(html,/实际摘要/);assert.match(html,/<dd>0<\/dd>/);assert.match(html,/independence is unresolved/);assert.match(html,/simulations, not measured parts/);assert.match(html,/此项核验记录：尚未核验/);assert.match(html,/No independent specimen-level uncertainty/);assert.doesNotMatch(html,/>已目视核验<|<dt>设备<\/dt>/);
});

test('reference value suppresses only exact legacy placeholders and keeps concrete limitations',()=>{
  for(const value of ['已提供的来源未报告足够信息，需核对原文。',' 已提供的来源未报告足够信息, 需核对原文！ ','已提供的来源未报告足够信息；需核对原文','证据不足时保留原判断。']){
    assert.equal(hasReportContent(value),false,value);
    assert.equal(referenceValue({future_insights:value,research_logic:{transfer_insights:{judgement_change:value}}}),'');
  }
  const caveat='已提供的来源未报告足够信息，需核对原文；但可借鉴重复测量分层，在本课题区分设备漂移与独立样本差异。';
  assert.equal(hasReportContent(caveat),true);
  assert.equal(referenceValue({future_insights:caveat}),caveat);
  assert.equal(referenceValue({future_insights:'可借鉴其校准协议，但该结论只有模拟证据，迁移前须在实物上验证。'}),'可借鉴其校准协议，但该结论只有模拟证据，迁移前须在实物上验证。');
});

test('reference value projects supplied transferable insights when future text is unavailable',()=>{
  const a={future_insights:'已提供的来源未报告足够信息，需核对原文。',research_logic:{transfer_insights:{direct:['沿用独立样本与技术重复分层'],adapt:{method:'将校准协议用于本课题的测量流程',condition:'先核对设备量程'},judgement_change:'证据不足时保留原判断'}}};
  const value=referenceValue(a);
  assert.match(value,/可以借鉴：沿用独立样本与技术重复分层/);
  assert.match(value,/修改后验证：method：将校准协议用于本课题的测量流程/);
  assert.match(value,/先核对设备量程/);assert.doesNotMatch(value,/\[object Object\]|未报告足够信息|证据不足时保留原判断/);
  const future=reportSections({analysis:a}).find(([id])=>id==='future')[2];
  assert.match(future,/对本课题的参考借鉴/);assert.match(future,/沿用独立样本/);assert.match(future,/先核对设备量程/);assert.doesNotMatch(future,/未报告足够信息|证据不足时保留原判断/);
});

test('reference value prioritizes real future insight and report preserves unique transfer content',()=>{
  const explanation='借鉴分层误差预算，用于本课题区分制造波动与测量重复性，独立样本单位须先确认。';
  const a={future_insights:explanation,research_logic:{transfer_insights:{direct:explanation,adapt:'迁移前核对当前仪器量程',avoid:'渲染结果不能直接等同于实物测量',judgement_change:'证据不足时保留原判断'}}};
  assert.equal(referenceValue(a),explanation);
  const future=reportSections({analysis:a}).find(([id])=>id==='future')[2];
  assert.equal(future.split(explanation).length-1,1);assert.match(future,/迁移前核对当前仪器量程/);assert.match(future,/渲染结果不能直接等同于实物测量/);
  assert.equal(referenceValue({project_reference:{borrow:'分层校准',use:'用于当前测量协议'},future_insights:'A different saved paragraph'}),'borrow：分层校准\nuse：用于当前测量协议');
  assert.equal(referenceValue({future_insights:[],research_logic:{transfer_insights:{direct:{detail:'未报告'},adapt:['unknown',null],judgement_change:'证据不足时保留原判断'}}}),'');
});

test('saved topic-reference aliases and nested values work without acquisition-only filler',()=>{
  for(const key of ['reference_value','topic_reference_value','topic_relevance','research_relevance','research_implications']){
    assert.equal(referenceValue({[key]:'借鉴分层取样，应用于当前稳定性比较。'}),'借鉴分层取样，应用于当前稳定性比较。');
    assert.equal(referenceValue({research_logic:{[key]:'借鉴分层取样，应用于当前稳定性比较。'}}),'借鉴分层取样，应用于当前稳定性比较。');
  }
  for(const value of ['先取得全文再判断能否迁移','需核对原文。','待取得全文后判断适用性'])assert.equal(referenceValue({future_insights:value}),'');
  const a={future_insights:[{direct:'借鉴独立样本分层，用于当前误差预算。',adapt:'先取得全文再判断能否迁移'},{conditions:'现有模型仅支持模拟，实物验证待执行。'}]};
  assert.match(referenceValue(a),/独立样本分层/);assert.match(referenceValue(a),/仅支持模拟/);assert.doesNotMatch(referenceValue(a),/先取得全文/);
  const legacy={research_logic:{transfer:{direct:'借鉴统计单位分层，用于当前重复性比较。'}}};
  assert.match(referenceValue(legacy),/借鉴统计单位分层/);assert.match(reportSections({analysis:legacy}).find(([id])=>id==='future')[2],/借鉴统计单位分层/);
});

test('empty synthesis omits invented support, conflicts, priorities and boilerplate',()=>{
  assert.equal(synthesisHtml({supports:[{}],conflicts:[{claim:'未报告'}],priority_actions:[{priority:'P0'}],limitations:['未报告']}),'');
  const html=synthesisHtml({supports:[{claim:'Independent cohorts point in the same direction.'}],conflicts:[],judgement_changes:[{before:'Not reported',after:'No causal claim follows from correlation.'}]});
  assert.match(html,/same direction/);assert.match(html,/No causal claim/);assert.doesNotMatch(html,/冲突及可能原因|优先验证|原判断|当前证据不足/);
});

test('scientific prose and URLs are escaped without evaluating research-material instructions',()=>{
  const malicious={...paper,analysis:{...paper.analysis,summary:'<script>stealKey()</script>',sources:['javascript:alert(1)','https://papers.example/a?x=1&y=2']}};
  const html=reportSections(malicious).map(x=>x[2]).join('');assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|href="javascript/);assert.match(html,/papers.example/);
});

test('synthesis distinguishes support, conflicts, judgement changes and at most three pending priorities',()=>{
  const s={record_ids:['D001','D002'],supports:[{record_ids:['D001','D002'],claim:'A shared pattern',reason:'Compatible units'}],conflicts:[{record_ids:['D001','D002'],claim:'Protocol difference',possible_causes:'Different statistical unit',needed_evidence:'Raw independent data'}],priority_actions:Array.from({length:4},(_,i)=>({record_id:'D001',action_id:'A'+i,reason:'Reduce uncertainty',validation_cost:'Must be estimated'})),route_decisions:[{route:'Rendering as physical truth',decision:'abandon',reason:'No independent reference'}]};
  const html=synthesisHtml(s);assert.match(html,/不同|Different statistical unit/);assert.match(html,/论文质量排名/);assert.match(html,/放弃/);assert.equal((html.match(/class="synthesis-action"/g)||[]).length,3);assert.match(html,/待执行/);
});
