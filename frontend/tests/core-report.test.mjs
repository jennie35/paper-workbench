import test from 'node:test';
import assert from 'node:assert/strict';
import {coreReportStatus,sourceGroups} from '../core-report.js';
const source={basis:'fulltext',sha256:'f'.repeat(64),pages:12,characters_sent:70000,characters_available:70000,blocks:[{id:'P1',text:'Question',section:'introduction'},{id:'P7',text:'Method',section:'methods'},{id:'P12',text:'Result',section:'results'}]};
const report=()=>({core_coverage:{question:{summary:'Actual question',source_block_ids:['P1']},methods:{summary:'Actual method',source_block_ids:['P7']},results:{summary:'Actual result',source_block_ids:['P12']}},evidence:[{claim:'Finding',observation:'Observed result',source_block_ids:['P12']}],required_visual_pages:[],visuals:[]});
test('only actual complete body coverage with core source locators qualifies',()=>{
  assert.equal(coreReportStatus(report(),source).status,'completed');
  assert.equal(coreReportStatus({...report(),verified:true},{...source,basis:'abstract'}).status,'processing');
  assert.equal(coreReportStatus(report(),{...source,characters_sent:60000}).status,'processing');
  const a=report();a.core_coverage.results.source_block_ids=['invented'];assert.equal(coreReportStatus(a,source).status,'processing');
});
test('metadata and abstracts cannot stand in for methods and results',()=>{
  const a=report();a.core_coverage.methods.source_block_ids=['P1'];a.core_coverage.results.source_block_ids=['P1'];
  assert.equal(coreReportStatus(a,{...source,blocks:source.blocks.map(b=>b.id==='P1'?{...b,section:'abstract'}:b)}).status,'processing');
});
test('core page requires actual matching image receipt and a completed request',()=>{
  const a=report();a.required_visual_pages=[12];assert.equal(coreReportStatus(a,source).status,'processing');
  a.visuals=[{page:12,inspection_status:'verified'}];assert.equal(coreReportStatus(a,source).status,'processing');
  Object.assign(a.visuals[0],{image_supplied:true,source_sha256:source.sha256,inspection_id:'actual-request'});assert.equal(coreReportStatus(a,source).status,'completed');
});
test('reading groups preserve the tail of long pages and all source IDs',()=>{
  const blocks=[{id:'P1',text:'a'.repeat(61000)},{id:'P9',text:'Tail result'}],groups=sourceGroups(blocks);
  assert.ok(groups.every(g=>g.reduce((n,b)=>n+b.text.length,0)<=45000));
  assert.equal(groups.flat().filter(b=>b.id==='P1').map(b=>b.text).join(''),blocks[0].text);
  assert.equal(groups.flat().at(-1).text,'Tail result');
});
