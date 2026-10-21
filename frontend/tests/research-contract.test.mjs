import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_RESEARCH_CONFIG,REPORT_SECTIONS,DESIGN_FIELDS,PITFALLS,normalizeResearchConfig,normalizeResearchLogic,normalizeSynthesis,buildReportPrompt,buildScopePrompt,buildSynthesisPrompt} from '../research-contract.js';

test('research configuration preserves known constraints, aliases the question and cannot claim an arbitrary storage root',()=>{
  const first=normalizeResearchConfig({core_question:'Which source of error changes the measurement?',known_resources:'Only an existing instrument',constraints:'No additional budget',keywords_zh:['测量'],keywords_en:['measurement'],run_mode:'existing-task',storage_root:'C:/invented',inferred:false},{},'浏览器 IndexedDB');
  assert.equal(first.research_question,first.core_question);assert.equal(first.known_resources,'Only an existing instrument');assert.equal(first.default_count,5);assert.equal(first.output_language,'zh-CN');assert.deepEqual(first.keywords,['测量','measurement']);assert.equal(first.storage_root,'浏览器 IndexedDB');
  const revised=normalizeResearchConfig({research_question:'Revised question',default_count:2},first);assert.equal(revised.known_resources,first.known_resources);assert.equal(revised.constraints,first.constraints);assert.equal(revised.run_mode,'existing-task');assert.equal(revised.storage_root,first.storage_root);
  assert.equal(normalizeResearchConfig({default_count:100}).default_count,5);assert.equal(normalizeResearchConfig({}).known_resources,'');assert.equal(DEFAULT_RESEARCH_CONFIG.run_mode,'manual');assert.equal(REPORT_SECTIONS.length,11);
});

test('all four study types retain their own design checks and unknown study type is not invented',()=>{
  for(const type of Object.keys(DESIGN_FIELDS)){
    const logic=normalizeResearchLogic({research_logic:{paper_type:type,study_design:{fields:{}}}},{summary:'Actual source summary'},{source:{basis:'abstract',blocks:[{id:'ABSTRACT-1'}]}});
    assert.equal(logic.paper_type,type);assert.deepEqual(Object.keys(logic.study_design.fields),DESIGN_FIELDS[type]);assert.ok(Object.values(logic.study_design.fields).every(value=>/未报告|未核验/.test(value)));assert.equal(logic.actions.length,1);assert.equal(logic.actions[0].status,'pending');assert.match(logic.actions[0].method,/获取全文/);
  }
  const unknown=normalizeResearchLogic({},{},{source:{basis:'abstract'}});assert.equal(unknown.paper_type,'unknown');assert.deepEqual(Object.keys(unknown.study_design.fields),['study_type']);
});

test('model claims cannot promote images, scientific conclusions or skill status to verified evidence',()=>{
  const logic=normalizeResearchLogic({research_logic:{reading_scope:{verified:['All images']},evidence_review:[{kind:'figure',locator:'Unspecified figure',verification_status:'verified',source_block_ids:['FAKE','PDF-P1']}],pitfalls:[{kind:PITFALLS[0],assessment:'Only technical replication is reported.',source_block_ids:['FAKE','PDF-P1']}],conclusion_layers:{author_results:'The author reports an improvement.',author_interpretation:'The author proposes a mechanism.',analyst_inference:'Causality is not established.',unverified_hypotheses:'An alternative mechanism may explain it.'}}},{verification_gaps:['Images not checked']},{source:{basis:'fulltext',blocks:[{id:'PDF-P1'}]}});
  assert.deepEqual(logic.reading_scope.verified,[]);assert.equal(logic.evidence_review[0].verification_status,'unverified');assert.deepEqual(logic.evidence_review[0].source_block_ids,['PDF-P1']);assert.deepEqual(logic.pitfalls[0].source_block_ids,['PDF-P1']);assert.equal(logic.pitfalls.length,PITFALLS.length);assert.equal(logic.conclusion_layers.analyst_inference,'Causality is not established.');assert.match(logic.reading_scope.unverified.join(' '),/未执行外部/);
});

test('legacy author conclusions are not silently reclassified as results and author rationales need valid locators',()=>{
  const logic=normalizeResearchLogic({research_logic:{design_decisions:[{decision:'A choice',rationale:'A supposed author motive',rationale_origin:'author',source_block_ids:['FAKE']},{decision:'A sourced choice',rationale:'Reported rationale',rationale_origin:'author',source_block_ids:['PDF-P1']}]}},{author_conclusions:'An undivided legacy conclusion'},{source:{basis:'fulltext',blocks:[{id:'PDF-P1'}]}});
  assert.match(logic.conclusion_layers.author_results,/未报告|未核验/);assert.doesNotMatch(logic.conclusion_layers.author_results,/undivided/);assert.match(logic.conclusion_layers.author_interpretation,/尚未区分结果与解释/);assert.equal(logic.design_decisions[0].rationale_origin,'unknown');assert.match(logic.design_decisions[0].rationale,/缺少有效来源定位/);assert.equal(logic.design_decisions[1].rationale_origin,'author');
});

test('abstract-level actions require evidence acquisition before experiments and do not accept invented sample-size bases',()=>{
  const logic=normalizeResearchLogic({actions:[{title:'A proposed comparison',method:'Compare protocols',sample_size_basis:'n=999',resources:'A proposed new sensor',stopping_criteria:'Stop when key evidence remains missing'}]},{evidence:[{id:'E1'}]},{config:{known_resources:''},source:{basis:'abstract'}});
  assert.equal(logic.actions[0].status,'pending');assert.match(logic.actions[0].prerequisites,/先取得并核对全文/);assert.doesNotMatch(logic.actions[0].sample_size_basis,/999/);assert.match(logic.actions[0].sample_size_basis,/先导实验/);assert.equal(logic.actions[0].stopping_criteria,'Stop when key evidence remains missing');assert.ok(logic.reading_priorities[0].decision_impact);assert.ok(logic.transfer_insights.adapt);
});

const records=[{id:'D001',analysis:{verified:false,actions:[{id:'A01',gap:'Missing methods'}]}},{id:'D002',analysis:{verified:false,actions:[{id:'A02',gap:'Independent validation'}]}}];
test('cross-paper synthesis rejects invented provenance, impossible action references and single-paper conflicts',()=>{
  const synthesis=normalizeSynthesis({supports:[{record_ids:['D001','FAKE'],claim:'False comparison'},{record_ids:['D001','D002'],claim:'Shared result',reason:'Comparable conditions'}],conflicts:[{record_ids:['D002'],claim:'Single-paper conflict'}],judgement_changes:[{record_ids:['D001'],before:'Unknown',after:'Needs verification',reason:'Missing methods'}],priority_actions:[{record_id:'FAKE',action_id:'A01'},{record_id:'D001',action_id:'FAKE'},{record_id:'D002',action_id:'A02',reason:'Reduce uncertainty'}],route_decisions:[{record_ids:['D001'],route:'Proposed route',decision:'already-completed'}],limitations:[]},records,{known_resources:''},'2026-10-21T00:00:00Z');
  assert.equal(synthesis.supports.length,1);assert.deepEqual(synthesis.supports[0].record_ids,['D001','D002']);assert.equal(synthesis.conflicts.length,0);assert.equal(synthesis.priority_actions.length,1);assert.equal(synthesis.priority_actions[0].record_id,'D002');assert.equal(synthesis.route_decisions[0].decision,'need_evidence');assert.match(synthesis.limitations.join(' '),/不提高原始证据/);assert.equal(synthesis.created_at,'2026-10-21T00:00:00Z');
  const single=normalizeSynthesis({supports:[],priority_actions:[]},records.slice(0,1));assert.match(single.limitations.join(' '),/不足两篇/);assert.equal(single.priority_actions[0].action_id,'A01');assert.throws(()=>normalizeSynthesis({summary:'Not a synthesis'},records),/结构无效/);
});

test('prompts request configured language, actual evidence boundaries and all research deliverables',()=>{
  const prompt=buildReportPrompt({output_language:'en'});assert.match(prompt,/输出语言：en/);for(const field of ['storyline','study_design','design_decisions','evidence_review','conclusion_layers','reading_priorities','transfer_insights','stopping_criteria','experimental_unit'])assert.ok(prompt.includes(field),field);assert.match(prompt,/未执行外部/);assert.match(prompt,/先导实验/);assert.match(buildScopePrompt(),/不可信研究资料/);assert.match(buildSynthesisPrompt(),/不是论文质量排名/);
});

test('cross-project reused actions remain out of this project priority list until transfer is reevaluated',()=>{
  const transferred=[{id:'D009',analysis:{transfer_notice:'Old-topic actions not reassessed',actions:[{id:'A01',gap:'Old-topic gap'}]}}];
  const result=normalizeSynthesis({priority_actions:[{record_id:'D009',action_id:'A01',reason:'Unjustified transfer'}]},transferred);
  assert.deepEqual(result.priority_actions,[]);assert.match(result.limitations.join(' '),/尚未评估当前适用性/);
});
