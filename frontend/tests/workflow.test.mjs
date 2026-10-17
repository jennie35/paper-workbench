import test from 'node:test';
import assert from 'node:assert/strict';
import {apiOrigin, configurationComplete, scopeConfirmed, workflowState} from '../workflow.js';

const project = {id:'project-a',name:'测试课题',scope:{inferred:false,research_question:'可检验的研究问题',keywords:['研究关键词']}};
const settings = {configured:true,has_api_key:true,base_url:'https://models.example/v1',text_model:'text-example',vision_model:'vision-example'};
const state = overrides => workflowState({demo:false,project,settings,...overrides});

test('setup follows connection, project, scope and model without allowing demo data to unlock a batch', () => {
  const demo = state({demo:true});
  assert.equal(demo.action,'connect');
  assert.ok(demo.steps.every(step => !step.complete));
  assert.deepEqual(demo.steps.map(step => step.key),['connection','project','scope','model']);
  assert.equal(state({project:null,settings:null}).action,'create');
  assert.equal(state({project:{...project,scope:{...project.scope,inferred:true}},settings:null}).action,'scope');
  assert.equal(state({settings:null}).action,'settings');
  assert.equal(state().action,'batch');
});

test('configuration requires saved credentials and both trimmed model names, not merely configured flag', () => {
  assert.equal(configurationComplete(settings),true);
  for (const field of ['base_url','text_model','vision_model']) {
    for (const value of ['', '   ', null, undefined]) {
      assert.equal(configurationComplete({...settings,[field]:value}),false,`${field} = ${String(value)}`);
      assert.equal(state({settings:{...settings,[field]:value}}).action,'settings');
    }
  }
  assert.equal(configurationComplete({...settings,has_api_key:false}),false);
  assert.equal(configurationComplete({...settings,configured:false}),false);
  assert.equal(configurationComplete(null),false);
});

test('inferred or empty scopes cannot launch a batch, but a confirmed question or keyword is enough', () => {
  assert.equal(scopeConfirmed(null),false);
  assert.equal(scopeConfirmed({...project,scope:{...project.scope,inferred:true}}),false);
  assert.equal(scopeConfirmed({...project,scope:{research_question:'question',keywords:[]}}),false);
  assert.equal(scopeConfirmed({...project,scope:{inferred:false,research_question:'  ',keywords:['', ' ']}}),false);
  assert.equal(scopeConfirmed({...project,scope:{inferred:false,research_question:'question',keywords:[]}}),true);
  assert.equal(scopeConfirmed({...project,scope:{inferred:false,research_question:'',keywords:[' keyword ']}}),true);
  assert.equal(scopeConfirmed({...project,scope:{inferred:false,research_question:'',keywords:'keyword'}}),false);
});

test('an instance-wide active job takes precedence even when it belongs to a different project', () => {
  const activeJob = {id:'job-b',project_id:'project-b',status:'running'};
  assert.equal(state({activeJob}).action,'active');
  assert.equal(state({activeJob,project:null,settings:null}).action,'active');
  assert.equal(state({activeJob,demo:true}).action,'connect');
  assert.equal(state({activeJob:null}).action,'batch');
});

test('preflight status informs the UI without requiring an extra paid probe before batch submission', () => {
  const unchecked = state();
  assert.equal(unchecked.action,'batch');
  assert.match(unchecked.steps.at(-1).description,/自动检查/);
  const checked = state({settings:{...settings,preflight:{ready:true,checked_at:'2026-10-16T12:00:00Z'}}});
  assert.equal(checked.action,'batch');
  assert.match(checked.steps.at(-1).description,/已通过/);
  assert.equal(state({settings:{...settings,preflight:{ready:false,checked_at:'2026-10-16T12:00:00Z'}}}).action,'batch');
});

test('service origin comparison normalizes paths, host case and default ports but separates services', () => {
  assert.equal(apiOrigin(' HTTPS://Example.COM:443/api/ '),'https://example.com');
  assert.equal(apiOrigin('http://127.0.0.1:8095/api'),apiOrigin('http://127.0.0.1:8095/'));
  assert.notEqual(apiOrigin('http://127.0.0.1:8095'),apiOrigin('http://127.0.0.1:8096'));
  assert.notEqual(apiOrigin('http://example.com'),apiOrigin('https://example.com'));
  for (const value of ['', ' ', null, undefined, '/api', 'invalid', 'file:///tmp/data', 'javascript:alert(1)', 'ftp://example.com']) {
    assert.equal(apiOrigin(value),'');
  }
});

test('workflow helpers do not mutate saved project or model settings', () => {
  const projectSnapshot = JSON.stringify(project), settingsSnapshot = JSON.stringify(settings);
  state();
  scopeConfirmed(project);
  configurationComplete(settings);
  assert.equal(JSON.stringify(project),projectSnapshot);
  assert.equal(JSON.stringify(settings),settingsSnapshot);
});
