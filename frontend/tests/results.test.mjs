import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {summarizeBatch, batchOutcome, candidateMatches, paperIdsForBatch} from '../results.js';

test('the browser entry script parses before any private workspace request', () => {
  const code=readFileSync(new URL('../app.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'');
  assert.doesNotThrow(()=>new vm.Script(code,{filename:'app.js'}));
});

test('switching projects cannot apply an older project response to the current library', async () => {
  const code=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const fn=code.slice(code.indexOf('async function loadProject()'),code.indexOf('function enterDemo()'));
  const pending=new Map(),state={demo:false,project:{id:'A'}};
  const context=vm.createContext({state,api:path=>new Promise(resolve=>pending.set(path,resolve)),localStorage:{setItem(){}},render(){}});
  vm.runInContext(fn,context);
  const first=context.loadProject();state.project={id:'B'};const second=context.loadProject();
  pending.get('/api/projects/B/papers')([{id:'B-paper'}]);pending.get('/api/projects/B/jobs')([{id:'B-job'}]);await second;
  pending.get('/api/projects/A/papers')([{id:'A-paper'}]);pending.get('/api/projects/A/jobs')([{id:'A-job'}]);await first;
  assert.equal(state.papers[0].id,'B-paper');assert.equal(state.jobs[0].id,'B-job');
});

test('a registered candidate opens the official record without downgrading it to a draft', async () => {
  const code=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const fn=code.slice(code.indexOf('async function showCandidate('),code.indexOf('function connectionForm()'));
  const opened=[];
  const state={papers:[{id:'R001'}],jobs:[{id:'batch',checkpoint:{candidates:[{paper_id:'R001'}]}}]};
  const context=vm.createContext({state,showPaper:id=>opened.push(id)});
  vm.runInContext(fn,context);await context.showCandidate('batch',0);
  assert.deepEqual(opened,['R001']);
});

test('a finished batch with a shortfall never presents as completed deep reading', () => {
  const job = {status:'completed',requested:5,checkpoint:{completed:[],candidates:[{status:'unverified'},{status:'no_fulltext'},{status:'excluded'}],diagnostics:['Source unavailable','Source unavailable']}};
  const result = summarizeBatch(job);
  assert.equal(result.full,false);
  assert.equal(result.shortfall,5);
  assert.equal(result.unverified,1);
  assert.equal(result.missingFulltext,1);
  assert.deepEqual(result.diagnostics,['Source unavailable']);
  assert.match(batchOutcome(job),/仍缺 5 篇/);
});

test('reused evidence does not count as newly completed papers', () => {
  const job = {status:'completed',requested:2,checkpoint:{completed:['R003'],reused:['R001'],shortfall:0}};
  assert.equal(summarizeBatch(job).shortfall,1);
  assert.equal(summarizeBatch(job).full,false);
  assert.deepEqual([...paperIdsForBatch(job)],['R003','R001']);
});

test('candidate filters expose partial reading by default and allow excluded reasons', () => {
  const draft = {status:'unverified',title:'A Color Study',authors:['Example Author'],doi:'10.1/test'};
  assert.equal(candidateMatches(draft,'needs','color'),true);
  assert.equal(candidateMatches(draft,'needs','other'),false);
  assert.equal(candidateMatches({...draft,status:'excluded'},'needs'),false);
  assert.equal(candidateMatches({...draft,status:'excluded'},'excluded','author'),true);
  assert.equal(candidateMatches(draft,'all','10.1/TEST'),true);
});

test('running and failed batches preserve distinct outcomes', () => {
  assert.match(batchOutcome({status:'running',requested:5}),/正在/);
  assert.match(batchOutcome({status:'failed',requested:5}),/中断/);
  assert.match(batchOutcome({status:'completed',requested:1,checkpoint:{completed:['R001']}}),/已完成 1 篇/);
});
