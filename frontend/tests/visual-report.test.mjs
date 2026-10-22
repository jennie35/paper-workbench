import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {verifiedOriginals,originalsHtml,reportSections} from '../research-view.js';
import {designMap,evidenceActionMap,researchFlowSvg} from '../research-diagrams.js';
import {recordMarkdown,recordEvidence,exportOfflineHtml} from '../research-export.js';

// A synthetic one-pixel fixture exercises rendering, never a real paper result.
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2T9sAAAAASUVORK5CYII=';
const visual=()=>({page:2,source_page:2,kind:'figure',label:'Figure 2 (synthetic fixture)',locator:'PDF p.2 · Figure 2',explanation:'Synthetic fixture explanation; no scientific result.',inspection_status:'verified',inspection_method:'vision_model',inspection_id:'fixture-image-request',inspected_at:'2026-10-22T10:00:00Z',asset_path:'assets/page-2.png',source_sha256:'a'.repeat(64),image_sha256:createHash('sha256').update(Buffer.from(png,'base64')).digest('hex'),image_data_url:'data:image/png;base64,'+png,source_url:'https://papers.example/article.pdf',axes_units:'Fixture axis / unit',limitations:'Model inspection is not independent human review.'});
const paper=()=>({id:'D001',title:'Synthetic visual report',analysis:{verified:false,source_metadata:{sha256:'a'.repeat(64)},visuals:[visual()],research_logic:{evidence_review:[{locator:'Figure 3',claim:'An unseen result must not enter the report.',verification_status:'verified'}]}}});

test('only actual image receipts with matching paper identity enter the visual report',()=>{
  const p=paper(),before=JSON.stringify(p),html=reportSections(p).find(x=>x[0]==='visuals')?.[2]||'';
  assert.match(html,/Figure 2/);assert.match(html,/data-asset="page-2.png"/);assert.match(html,/Synthetic fixture explanation/);assert.match(html,/Fixture axis/);assert.match(html,/未经人工复核/);assert.match(html,/原文来源/);assert.doesNotMatch(html,/Figure 3|unseen result|尚未核验/);assert.equal(JSON.stringify(p),before);
  for(const patch of [{inspection_status:'unverified'},{inspection_method:'text_model'},{inspection_id:''},{inspected_at:'invalid'},{source_sha256:'b'.repeat(64)},{image_sha256:'not-a-hash'},{label:'PDF page 2',locator:'PDF page 2'},{explanation:'未报告'},{source_page:3},{asset_path:'../../secret.png'}]){
    const record=paper();Object.assign(record.analysis.visuals[0],patch);
    assert.equal(verifiedOriginals(record.analysis).length,0,JSON.stringify(patch));assert.equal(reportSections(record).some(x=>x[0]==='visuals'),false);
  }
});

test('offline HTML embeds the inspected original, omits unavailable originals and preserves raw audit',()=>{
  const p=paper(),html=exportOfflineHtml({papers:[p]}),md=recordMarkdown(p);
  assert.match(html,/src="data:image\/png;base64,/);assert.match(html,/img-src data:/);assert.doesNotMatch(html,/data-asset=|Figure 3|此项核验记录：尚未核验/);
  assert.match(md,/!\[Figure 2/);assert.match(md,/data:image\/png;base64/);
  assert.equal(recordEvidence(p).research_logic.evidence_review[0].locator,'Figure 3','export JSON retains the audit without publishing it as a verified figure');
  const noImage=paper();delete noImage.analysis.visuals[0].image_data_url;
  assert.equal(originalsHtml(noImage.analysis,{mode:'embedded'}),'');assert.doesNotMatch(exportOfflineHtml({papers:[noImage]}),/7\. 原图、表格与公式核验/);
  const hostile=paper();hostile.analysis.visuals[0].image_data_url='data:image/svg+xml,<svg onload="steal()"/>';hostile.analysis.visuals[0].source_url='javascript:steal()';
  assert.equal(originalsHtml(hostile.analysis,{mode:'embedded'}),'');
});

test('diagrams show only saved design and explicit evidence-action references',()=>{
  const a={flow_steps:['Input <script>x()</script>','Observed comparison'],research_logic:{study_design:{fields:{variables:'Recorded variable',experimental_unit:'Independent specimen',controls:'Actual reference'}}},source_blocks:[{id:'B1',text:'Saved source'}],evidence:[{id:'E1',claim:'Recorded claim',source_block_ids:['B1','invented']},{id:'E2',claim:'Unlinked evidence'}],actions:[{id:'A1',title:'Pending validation',evidence_ids:['E1']},{id:'A2',title:'Unrelated action',evidence_ids:['missing']}]};
  const map=evidenceActionMap(a,'D001:');assert.match(map,/E1/);assert.match(map,/A1/);assert.match(map,/source-D001%3AB1/);assert.doesNotMatch(map,/invented|E2|A2|Unrelated action/);assert.match(map,/不表示因果/);
  assert.match(designMap(a),/Independent specimen/);assert.equal(designMap({variables:'Only one item'}),'');assert.equal(evidenceActionMap({evidence:[{id:'E1',claim:'No saved link'}]}),'');
  const flow=researchFlowSvg(a.flow_steps,'fulltext');assert.match(flow,/分析者绘制，非论文原图/);assert.match(flow,/&lt;script&gt;/);assert.doesNotMatch(flow,/<script>/);assert.equal(researchFlowSvg([]),'');
});

test('offline HTML stores native MathML from the packaged renderer while Markdown preserves the checked source equation',()=>{
  const runtime={};vm.runInNewContext(readFileSync(new URL('../vendor/temml.min.js',import.meta.url),'utf8'),runtime);
  const p=paper();Object.assign(p.analysis.visuals[0],{kind:'equation',label:'Equation (3)',latex:'\\frac{a}{b}',symbols:'a and b are synthetic test symbols.'});
  const html=exportOfflineHtml({papers:[p]},{mathRenderer:runtime.temml.renderToString}),md=recordMarkdown(p);
  assert.match(html,/<math[\s>]/);assert.match(html,/<mfrac>/);assert.match(html,/src="data:image\/png;base64,/);assert.doesNotMatch(html,/<script src/);
  assert.match(md,/\\frac\{a\}\{b\}/);assert.match(md,/data:image\/png;base64/);
});
