import test from 'node:test';
import assert from 'node:assert/strict';
import {batchProgress,batchProgressHtml,formatDuration,updateBatchProgressTimes} from '../research-progress.js';

const start=Date.parse('2026-10-24T01:00:00Z');
const job=(overrides={})=>({id:'batch',requested:5,status:'running',stage:'分组阅读全文',checkpoint:{core_reports:0,run_timing:{elapsed_ms:0,run_started_at:new Date(start).toISOString(),run_initial_completed:0,run_elapsed_ms:0,running:true}},...overrides});

test('zero completed reports remain at zero while actual activity and elapsed time are shown',()=>{
  const source=job(),view=batchProgress(source,{now:start+90000}),html=batchProgressHtml(source,{now:start+90000});
  assert.equal(view.done,0);assert.equal(view.percent,0);assert.equal(view.etaMs,null);assert.equal(view.elapsedText,'1分30秒');
  assert.match(html,/<progress[^>]*max="5" value="0"/);assert.match(html,/当前阶段：分组阅读全文/);assert.match(html,/本次完成首篇后估算/);
  assert.doesNotMatch(html,/请保持本页打开，报告生成后会自动显示|width:.*%/);
});

test('ETA uses this run measured speed only after a newly completed report',()=>{
  const source=job();source.checkpoint.core_reports=1;
  const view=batchProgress(source,{now:start+120000});
  assert.equal(view.percent,20);assert.equal(view.etaMs,480000);assert.equal(view.etaText,'约 8分0秒');
  assert.equal(view.elapsedMs,120000);
});

test('resumed old completed papers do not establish a new-run ETA or count idle time',()=>{
  const source=job();source.created_at='2026-09-01T00:00:00Z';source.checkpoint.core_reports=2;
  Object.assign(source.checkpoint.run_timing,{elapsed_ms:600000,run_initial_completed:2});
  let view=batchProgress(source,{now:start+30000});
  assert.equal(view.elapsedMs,630000);assert.equal(view.etaMs,null);assert.match(view.etaText,/本次完成首篇/);
  source.checkpoint.core_reports=3;view=batchProgress(source,{now:start+60000});
  assert.equal(view.elapsedMs,660000);assert.equal(view.etaMs,120000);
});

test('finished, interrupted and waiting jobs freeze elapsed clocks and remove ETA',()=>{
  for(const status of ['completed','cancelled','failed','waiting_sources']){
    const source=job({status});source.checkpoint.core_reports=status==='completed'?5:1;
    Object.assign(source.checkpoint.run_timing,{running:false,elapsed_ms:180000,run_elapsed_ms:120000,stopped_at:new Date(start+120000).toISOString()});
    const first=batchProgress(source,{now:start+3600000}),later=batchProgress(source,{now:start+7200000});
    assert.equal(first.elapsedMs,180000);assert.equal(later.elapsedMs,180000);assert.equal(first.etaMs,null);assert.equal(first.clockActive,false);
    if(status==='completed'){assert.equal(first.percent,100);assert.equal(first.etaText,'已完成');}
  }
});

test('legacy batches have unknown elapsed duration rather than a created-at estimate',()=>{
  const source=job({created_at:'2020-01-01T00:00:00Z',checkpoint:{core_reports:2}});
  const view=batchProgress(source,{now:start});assert.equal(view.elapsedMs,null);assert.equal(view.etaMs,null);assert.equal(view.elapsedText,'耗时记录准备中');
  source.checkpoint.run_timing={};assert.equal(batchProgress(source,{now:start}).elapsedMs,null);
});

test('revision and imported tasks use known material count instead of pretending zero of zero is complete',()=>{
  const source=job({requested:0,checkpoint:{candidates:[{status:'completed'},{status:'pending'}]}});
  const view=batchProgress(source,{now:start}),html=batchProgressHtml(source,{now:start});
  assert.equal(view.target,2);assert.equal(view.done,1);assert.equal(view.percent,50);assert.match(view.countText,/1\/2 份指定资料/);assert.doesNotMatch(html,/0\/0|正文报告完成进度/);
  source.checkpoint.candidates=[];assert.equal(batchProgress(source).target,null);assert.doesNotMatch(batchProgressHtml(source),/max="0"|value="0"/);
});

test('visual count is based on supplied actual report count and labels escape untrusted stage text',()=>{
  const source=job({stage:'<script>alert(1)</script>'});source.checkpoint.core_reports=20;
  const view=batchProgress(source,{completed:2,now:start+60000}),html=batchProgressHtml(source,{completed:2,now:start+60000});
  assert.equal(view.done,2);assert.equal(view.percent,40);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});

test('local time refresh updates only existing text nodes without model or network calls',()=>{
  const source=job(),nodes=new Map([['[data-progress-elapsed]',{textContent:''}],['[data-progress-eta]',{textContent:''}]]);
  updateBatchProgressTimes({querySelector:key=>nodes.get(key)},source,{now:start+61000});
  assert.equal(nodes.get('[data-progress-elapsed]').textContent,'1分1秒');assert.equal(nodes.get('[data-progress-eta]').textContent,'本次完成首篇后估算');
  assert.equal(formatDuration(3660000),'1小时1分');
});
