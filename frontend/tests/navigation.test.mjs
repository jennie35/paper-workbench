import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const code=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const extract=(start,end)=>code.slice(code.indexOf(start),code.indexOf(end,code.indexOf(start)));
function renderContext(nav='home',project={id:'A',name:'Topic A'}){
  const fields=new Map(),calls=[];
  const $=id=>{if(!fields.has(id))fields.set(id,{hidden:false,value:'',classList:{toggle(){}},setAttribute(){},removeAttribute(){}});return fields.get(id);};
  const state={nav,project,projects:project?[project]:[],papers:[{id:'R001',analysis:{verified:true,actions:[]}}],jobs:[{id:'A-job',checkpoint:{candidates:[]}}],view:'latest',demo:false};
  const context=vm.createContext({state,$,esc:String,document:{querySelectorAll:()=>[]},connection(){},renderWorkflow(){calls.push('workflow');},renderPapers(){calls.push('papers');},renderJobs(){calls.push('jobs');},renderProjects(){calls.push('home');}});
  vm.runInContext(extract('function render(){','function tags('),context);
  return {context,state,$,calls};
}

test('home hides all project results even when private papers and batches are already loaded',()=>{
  const {context,$,calls}=renderContext();context.render();
  for(const id of ['topicStrip','projectSidebarNav','workflowGuide','stats','workspace','batchSummary','candidatePanel'])assert.equal($(id).hidden,true,id);
  assert.deepEqual(calls,['home']);assert.equal($('newBatch').textContent,'＋ 创建课题');assert.equal($('breadcrumbName').textContent,'课题首页');
});

test('project results and batches stay within the opened project and disappear on returning home',()=>{
  const {context,state,$,calls}=renderContext('library');context.render();
  assert.equal($('workspace').hidden,false);assert.equal($('breadcrumbName').textContent,'Topic A');assert.ok(calls.includes('papers'));
  state.nav='jobs';context.render();assert.equal(state.nav,'library');assert.equal($('workspace').hidden,false);assert.equal($('alternate').hidden,true);assert.equal($('stats').hidden,true);assert.equal(calls.at(-1),'papers');
  state.nav='home';context.render();assert.equal($('projectSidebarNav').hidden,true);assert.equal($('stats').hidden,true);assert.equal(calls.at(-1),'home');
});

test('a missing project cannot expose batch or library views',()=>{
  const {context,state,calls}=renderContext('jobs',null);context.render();assert.equal(state.nav,'home');assert.deepEqual(calls,['home']);
});

test('saving model configuration from home cannot replace the create-project action with batch controls',()=>{
  const context=vm.createContext({state:{nav:'home'},$(){throw new Error('Home must not render project workflow');},workflowState(){throw new Error('No project workflow on home');}});
  vm.runInContext(extract('function renderWorkflow(){','function connection(){'),context);assert.doesNotThrow(()=>context.renderWorkflow());
});

test('opening a project fetches only that project and enters its content',async()=>{
  const state={nav:'home',demo:false,base:'https://fixture.invalid',token:'fixture',projects:[{id:'A'},{id:'B'}],project:{id:'A'},papers:[],jobs:[]},paths=[];
  let closed=0;
  const context=vm.createContext({state,render(){},closeModal(){closed++;},resetFilters(){},toast(){},localStorage:{setItem(){}},api:async path=>{paths.push(path);return [{id:path.includes('/papers')?'B-paper':'B-job'}];}});
  vm.runInContext(extract('async function selectProject(','async function openActiveJob('),context);await context.selectProject('B');
  assert.deepEqual(paths,['/api/projects/B/papers','/api/projects/B/jobs']);assert.equal(state.nav,'library');assert.equal(state.project.id,'B');assert.equal(state.papers[0].id,'B-paper');assert.equal(state.jobs[0].id,'B-job');
  assert.equal(closed,1);
});

test('switching projects hides stale report and candidate actions while the new project loads',()=>{
  const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,{});return fields.get(id);};
  const context=vm.createContext({state:{projectLoading:true,papers:[],jobs:[{id:'A-job'}]},$});
  vm.runInContext(extract('function renderPapers(){','function clearFilters('),context);context.renderPapers();
  assert.equal($('batchSummary').hidden,true);assert.equal($('candidatePanel').hidden,true);
  assert.match($('cards').innerHTML,/正在读取文献与批次/);assert.doesNotMatch($('cards').innerHTML,/data-retry|data-results|A-job/);
});

test('returning home cancels pending navigation so a late project response cannot reopen results',async()=>{
  const state={nav:'jobs',project:{id:'A'},projects:[{id:'A'},{id:'B'}],demo:false,base:'https://fixture.invalid',token:'fixture',jobs:[{id:'A-job'}],papers:[]},pending=[];
  const context=vm.createContext({state,closeModal(){},render(){},resetFilters(){},toast(){},$:()=>({scrollIntoView(){}}),api:()=>new Promise(resolve=>pending.push(resolve)),localStorage:{setItem(){}}});
  vm.runInContext(extract('async function selectProject(','async function openActiveJob('),context);
  const switching=context.selectProject('B');assert.equal(state.projectLoading,true);context.goHome();pending.forEach(resolve=>resolve([]));await switching;
  assert.equal(state.nav,'home');assert.equal(state.project.id,'A');assert.equal(state.projectLoading,false);
});

test('failed cross-project active-job navigation cannot show another project as its owner',async()=>{
  const state={project:{id:'A'},activeJob:{project_id:'B'},nav:'library'};
  const context=vm.createContext({state,selectProject:async()=>{},render(){throw new Error('Must not expose wrong project jobs');},$:()=>({scrollIntoView(){}})});
  vm.runInContext(extract('async function openActiveJob(','function renderWorkflow('),context);await context.openActiveJob();assert.equal(state.nav,'library');
});

test('switching to demo clears a pending private selection and returns to the project home',()=>{
  const state={projectLoading:true,nav:'jobs'},demoProject={id:'demo'},demoPapers=[];
  const context=vm.createContext({state,demoProject,demoPapers,clearInterval(){},render(){},resetFilters(){}});
  vm.runInContext(extract('function enterDemo()','function requireService('),context);context.enterDemo();
  assert.equal(state.projectLoading,false);assert.equal(state.nav,'home');assert.equal(state.project.id,'demo');assert.equal(state.activeJob,null);
});
