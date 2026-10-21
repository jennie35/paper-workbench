import test from 'node:test';
import assert from 'node:assert/strict';
import {reportSections,synthesisHtml} from '../research-view.js';
const paper={id:'D001',title:'Synthetic source report',doi:'10.5555/fixture',year:2026,publication_date:'2026-08',authors:['Fixture author'],analysis:{summary:'Actual source summary.',scientific_question:'A source-grounded question?',flow_steps:['Read actual source','Record gaps'],actions:[{id:'A01',title:'Obtain missing evidence',hypothesis:'A falsifiable proposed check',experimental_unit:'Independent specimen, not repeated sensor reads',stopping_criteria:'Stop if the reference cannot be identified',resources:'Unknown; do not invent devices',sample_size_basis:'Estimate in pilot',evidence_ids:['E01']}],evidence:[{id:'E01',claim:'A checked text claim',observation:'Actually provided text',source_block_ids:['B01'],interpretation:'Analyst inference',limits:'No original figure'}],verification_gaps:['Original figure unavailable'],research_logic:{paper_type:'method',study_design:{type:'method',fields:{train_test_split:'Independent split',data_leakage:'Must be checked',baselines_fairness:'Equal acquisition conditions'}},storyline:{author_question:'Author question',reconstructed_question:'Analyst reconstruction',gap:'Source gap'},design_decisions:[{id:'D01',decision:'Control acquisition',rationale_origin:'analyst',cost:'Lower throughput',alternative:'Separate calibration'}],reading_priorities:[{locator:'Methods 2.1',reason:'Check sample independence',decision_impact:'Whether comparison can transfer',source_block_ids:['B01']}],transfer_insights:{direct:'Preserve units',adapt:'Recalibrate for user system',avoid:'Do not claim measured truth from rendering',judgement_change:'Need an independent reference'}}}};

test('report projection contains all eleven sections and retains publication date precision',()=>{
  const sections=reportSections(paper),html=sections.map(x=>x[2]).join('');
  assert.equal(sections.length,12);for(let i=0;i<11;i++)assert.match(sections[i][1],new RegExp(`^${i+1}\\. `));
  assert.match(html,/2026-08/);assert.doesNotMatch(html,/2026-08-01/);assert.match(html,/Author question/);assert.match(html,/Analyst reconstruction/);assert.match(html,/基线公平性/);assert.match(html,/Lower throughput/);assert.match(html,/停止条件/);assert.match(html,/Independent specimen/);assert.match(html,/无法|未提供已实际查看的原图/);
});

test('review and legacy reports remain visibly incomplete rather than fabricating experimental design',()=>{
  const legacy={...paper,analysis:{summary:'Legacy summary',research_logic:{study_design:{type:'review',fields:{selection_method:'Unreported',review_type:'Narrative review'}}}}};
  const html=reportSections(legacy).map(x=>x[2]).join('');assert.match(html,/不构成新增实验/);assert.match(html,/未实施荟萃分析/);assert.match(html,/未记录|未报告/);assert.doesNotMatch(html,/>已目视核验</);
});

test('scientific prose and URLs are escaped without evaluating research-material instructions',()=>{
  const malicious={...paper,analysis:{...paper.analysis,summary:'<script>stealKey()</script>',sources:['javascript:alert(1)','https://papers.example/a?x=1&y=2']}};
  const html=reportSections(malicious).map(x=>x[2]).join('');assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|href="javascript/);assert.match(html,/papers.example/);
});

test('synthesis distinguishes support, conflicts, judgement changes and at most three pending priorities',()=>{
  const s={record_ids:['D001','D002'],supports:[{record_ids:['D001','D002'],claim:'A shared pattern',reason:'Compatible units'}],conflicts:[{record_ids:['D001','D002'],claim:'Protocol difference',possible_causes:'Different statistical unit',needed_evidence:'Raw independent data'}],priority_actions:Array.from({length:4},(_,i)=>({record_id:'D001',action_id:'A'+i,reason:'Reduce uncertainty',validation_cost:'Must be estimated'})),route_decisions:[{route:'Rendering as physical truth',decision:'abandon',reason:'No independent reference'}]};
  const html=synthesisHtml(s);assert.match(html,/不同|Different statistical unit/);assert.match(html,/论文质量排名/);assert.match(html,/放弃/);assert.equal((html.match(/class="synthesis-action"/g)||[]).length,3);assert.match(html,/待执行/);
});
