import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createDirectoryWorkspaceStore} from '../research-storage.js';

const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
function memoryStore(initial=null){let data=clone(initial),clears=0;return {load:async()=>clone(data),save:async value=>{data=clone(value);},clear:async()=>{clears++;data=null;},snapshot:()=>clone(data),clears:()=>clears};}
function metadataStore(){let value=null;return {load:async()=>value,save:async next=>{value=next;},clear:()=>{value=null;}};}
const notFound=()=>Object.assign(new Error('Fixture file not found'),{name:'NotFoundError'});
function directoryFixture(name='research'){
  const state={files:new Map(),folders:new Set(['']),permission:'granted',writes:[],removals:[],beforeWrite:null,afterWrite:null,beforeRead:null};
  const child=(path,part)=>path?path+'/'+part:part;
  function folder(path){return {name:path.split('/').at(-1)||name,kind:'directory',
    async queryPermission(){return state.permission;},async isSameEntry(other){return other.fixtureState===state&&other.fixturePath===path;},fixtureState:state,fixturePath:path,
    async getDirectoryHandle(part,{create=false}={}){const target=child(path,part);if(!state.folders.has(target)){if(!create)throw notFound();state.folders.add(target);}return folder(target);},
    async getFileHandle(part,{create=false}={}){const target=child(path,part);if(!state.files.has(target)){if(!create)throw notFound();state.files.set(target,'');}return {name:part,kind:'file',
      async getFile(){return {async text(){await state.beforeRead?.(target);if(!state.files.has(target))throw notFound();return state.files.get(target);}};},
      async createWritable(){let buffer='',aborted=false;return {async write(value){buffer=String(value);},async close(){if(aborted)throw new Error('Aborted');await state.beforeWrite?.(target,buffer);state.files.set(target,buffer);state.writes.push(target);await state.afterWrite?.(target,buffer);},async abort(){aborted=true;}};}
    };},
    async removeEntry(part,{recursive=false}={}){const target=child(path,part);state.removals.push({path:target,recursive});if(state.files.delete(target))return;if(!state.folders.has(target))throw notFound();const nested=[...state.files.keys()].filter(x=>x.startsWith(target+'/'));if(nested.length&&!recursive)throw new Error('Directory not empty');for(const file of nested)state.files.delete(file);for(const dir of [...state.folders])if(dir===target||dir.startsWith(target+'/'))state.folders.delete(dir);}
  };}
  return {handle:folder(''),...state,state};
}
const workspace=(summary='Source-based summary')=>({version:1,counter:1,projects:[{id:'project1',name:'Synthetic topic',scope:{research_question:'Which difference changes the outcome?',known_resources:''}}],papers:[{id:'D001',title:'Synthetic paper',authors:['A. Example'],doi:'10.1234/fixture',analysis:{analyzed_date:'2026-10-21',summary,source_basis:'abstract',verified:false,skill_applied:false,source_blocks:[{id:'ABSTRACT-1',text:'Actual synthetic source text'}],verification_gaps:['Original figures not visually inspected'],flow_steps:['Reported input','Reported measurement'],actions:[{id:'A1',title:'Obtain original methods',status:'pending'}]}}],links:[{project_id:'project1',paper_id:'D001'}],references:[],jobs:[]});
function setup(initial=workspace(),options={}){const disk=directoryFixture(),fallback=memoryStore(initial),metadata=metadataStore();const create=extra=>createDirectoryWorkspaceStore({fallbackStore:fallback,metadata,cryptoImpl:webcrypto,origin:'https://fixture.example',showDirectoryPicker:async()=>disk.handle,...options,...extra});return {disk,fallback,metadata,create,store:create()};}
const head=disk=>JSON.parse(disk.files.get('paper-workbench.json'));

test('unbound storage uses the existing browser library without requesting directory permission',async()=>{
  const fallback=memoryStore(workspace());let picks=0;const store=createDirectoryWorkspaceStore({fallbackStore:fallback,metadata:metadataStore(),cryptoImpl:webcrypto,showDirectoryPicker:async()=>{picks++;throw new Error('Unexpected picker');}});
  assert.deepEqual(await store.load(),workspace());await store.save(workspace('Changed draft'));assert.equal(fallback.snapshot().papers[0].analysis.summary,'Changed draft');assert.equal(picks,0);assert.equal((await store.getStatus()).kind,'browser');
});

test('binding verifies the single directory library, clears the browser copy and writes per-paper artifacts and relative offline pages',async()=>{
  const {store,disk,fallback,create}=setup();const progress=[];const result=await store.selectDirectory({workspace:workspace(),onProgress:value=>progress.push(value.message)});
  assert.equal(result.status.kind,'directory');assert.equal(result.status.permission,'granted');assert.equal(result.reused,false);assert.equal(fallback.snapshot(),null);assert.equal(fallback.clears(),1);assert.ok(progress.length>=2);
  assert.match(disk.files.get('2026-10-21/D001/reading-note.md'),/Source-based summary/);assert.equal(JSON.parse(disk.files.get('2026-10-21/D001/source/source_map.json')).pdf_saved,false);assert.match(disk.files.get('2026-10-21/D001/assets/research-flow.svg'),/分析者绘制/);assert.match(disk.files.get('index.html'),/\.\/projects\/project1\/index\.html/);assert.ok(disk.files.get('projects/project1/index.html'));
  assert.deepEqual(await create().load(),workspace());assert.equal(head(disk).paper_locations.D001,'2026-10-21/D001');assert.equal([...disk.files.keys()].filter(x=>x.startsWith('.paper-workbench/staging/')).length,0);
});

test('permission loss or a corrupt snapshot never silently falls back to a stale browser library',async()=>{
  const {store,disk,fallback}=setup();await store.selectDirectory({workspace:workspace()});await fallback.save(workspace('Stale browser data'));disk.state.permission='denied';
  assert.equal((await store.getStatus()).needs_reconnect,true);await assert.rejects(store.load(),/授权已失效.*未退回/);await assert.rejects(store.save(workspace('Must not write')),/授权已失效/);
  disk.state.permission='granted';disk.files.set(head(disk).current.path,'{"tampered":true}');await assert.rejects(store.load(),/指纹不符/);assert.equal(fallback.snapshot().papers[0].analysis.summary,'Stale browser data');
});

test('different origin and different nonempty libraries cannot be silently merged or overwritten',async()=>{
  const {store,disk,create}=setup();await store.selectDirectory({workspace:workspace()});const manifest=disk.files.get('paper-workbench.json');
  await assert.rejects(create({origin:'https://other.example'}).load(),/另一个网页来源/);await assert.rejects(create().selectDirectory({workspace:workspace('Different local library')}),/已有不同研究库/);assert.equal(disk.files.get('paper-workbench.json'),manifest);
  const reopened=await create().selectDirectory({workspace:{projects:[],papers:[],references:[],jobs:[]}});assert.equal(reopened.reused,true);assert.equal(reopened.workspace.papers[0].analysis.summary,'Source-based summary');
});

test('manual notes block a revision before publication and are never removed by cleanup',async()=>{
  const {store,disk}=setup();await store.selectDirectory({workspace:workspace()});const previousHead=disk.files.get('paper-workbench.json'),previousIndex=disk.files.get('projects/project1/index.html');disk.files.set('2026-10-21/D001/reading-note.md','User annotation and original notes');disk.files.set('personal-notes.txt','Unique user source');
  await assert.rejects(store.save(workspace('A proposed revision')),/手工编辑/);assert.equal(disk.files.get('2026-10-21/D001/reading-note.md'),'User annotation and original notes');assert.equal(disk.files.get('personal-notes.txt'),'Unique user source');assert.equal(disk.files.get('paper-workbench.json'),previousHead);assert.equal(disk.files.get('projects/project1/index.html'),previousIndex);assert.equal(disk.removals.some(x=>x.path==='personal-notes.txt'),false);
});

test('a snapshot write failure rolls back published notes and offline pages while preserving the old verified library',async()=>{
  const {store,disk}=setup();await store.selectDirectory({workspace:workspace()});const oldManifest=disk.files.get('paper-workbench.json'),oldFiles=new Map(disk.files);let failed=false;
  disk.state.beforeWrite=async path=>{if(!failed&&path.startsWith('.paper-workbench/snapshots/')){failed=true;throw new Error('Synthetic disk full');}};
  await assert.rejects(store.save(workspace('Attempted revision')),/Synthetic disk full/);assert.equal(disk.files.get('paper-workbench.json'),oldManifest);for(const path of ['2026-10-21/D001/reading-note.md','2026-10-21/D001/evidence.json','projects/project1/index.html','index.html'])assert.equal(disk.files.get(path),oldFiles.get(path),path);assert.deepEqual(await store.load(),workspace());assert.equal((await store.getStatus()).warning,'');
});

test('a failure after writing the manifest restores both the prior manifest and prior published artifacts',async()=>{
  const {store,disk}=setup();await store.selectDirectory({workspace:workspace()});const oldManifest=disk.files.get('paper-workbench.json'),oldNote=disk.files.get('2026-10-21/D001/reading-note.md');let failed=false;
  disk.state.afterWrite=async path=>{if(path==='paper-workbench.json'&&!failed){failed=true;throw new Error('Synthetic close error after commit');}};
  await assert.rejects(store.save(workspace('Attempted changed note')),/Synthetic close error/);assert.equal(disk.files.get('paper-workbench.json'),oldManifest);assert.equal(disk.files.get('2026-10-21/D001/reading-note.md'),oldNote);assert.deepEqual(await store.load(),workspace());
});

test('a failure while publishing a later artifact restores artifacts already changed and does not advance the manifest',async()=>{
  const {store,disk}=setup();await store.selectDirectory({workspace:workspace()});const oldManifest=disk.files.get('paper-workbench.json'),oldNote=disk.files.get('2026-10-21/D001/reading-note.md'),oldEvidence=disk.files.get('2026-10-21/D001/evidence.json');let failed=false;
  disk.state.afterWrite=async path=>{if(path==='2026-10-21/D001/evidence.json'&&!failed){failed=true;throw new Error('Synthetic evidence close failure');}};
  const changed=workspace('Attempted revision');changed.papers[0].analysis.source_blocks[0].text='Revised source extraction';
  await assert.rejects(store.save(changed),/Synthetic evidence close failure/);assert.equal(disk.files.get('paper-workbench.json'),oldManifest);assert.equal(disk.files.get('2026-10-21/D001/reading-note.md'),oldNote);assert.equal(disk.files.get('2026-10-21/D001/evidence.json'),oldEvidence);assert.deepEqual(await store.load(),workspace());
});

test('edits introduced during preparation are checked again before publication',async()=>{
  const {store,disk}=setup();await store.selectDirectory({workspace:workspace()});const oldManifest=disk.files.get('paper-workbench.json');let edited=false;
  disk.state.afterWrite=async path=>{if(!edited&&path.startsWith('.paper-workbench/staging/')){edited=true;disk.files.set('2026-10-21/D001/reading-note.md','A note changed during preparation');}};
  await assert.rejects(store.save(workspace('Attempted revision')),/保存期间文件改变/);assert.equal(disk.files.get('2026-10-21/D001/reading-note.md'),'A note changed during preparation');assert.equal(disk.files.get('paper-workbench.json'),oldManifest);
});

test('rollback preserves an edit made after publication and reports that recovery needs attention',async()=>{
  const {store,disk}=setup();await store.selectDirectory({workspace:workspace()});const oldManifest=disk.files.get('paper-workbench.json');let failed=false;
  disk.state.beforeWrite=async path=>{if(!failed&&path.startsWith('.paper-workbench/snapshots/')){failed=true;disk.files.set('2026-10-21/D001/reading-note.md','Annotation made during save');throw new Error('Synthetic late failure');}};
  await assert.rejects(store.save(workspace('Attempted revision')),/Synthetic late failure/);assert.equal(disk.files.get('paper-workbench.json'),oldManifest);assert.equal(disk.files.get('2026-10-21/D001/reading-note.md'),'Annotation made during save');assert.match((await store.getStatus()).warning,/保留用户更改/);assert.equal(disk.removals.some(x=>x.path==='2026-10-21/D001/reading-note.md'),false);
});

test('a new target from a failed save is removed only when its bytes still match the failed operation',async()=>{
  const {store,disk}=setup();await store.selectDirectory({workspace:workspace()});const changed=workspace('Revision'),extra=clone(changed.papers[0]);extra.id='D002';changed.papers.push(extra);let failed=false;
  disk.state.beforeWrite=async path=>{if(!failed&&path.startsWith('.paper-workbench/snapshots/')){failed=true;throw new Error('Synthetic snapshot failure');}};
  await assert.rejects(store.save(changed),/Synthetic snapshot failure/);assert.equal([...disk.files.keys()].some(path=>path.startsWith('2026-10-21/D002/')),false);assert.deepEqual(await store.load(),workspace());
});

test('unsafe project, record and stored-location paths are rejected inside the selected handle',async()=>{
  for(const mutate of [value=>{value.projects[0].id='../outside';},value=>{value.papers[0].id='../../outside';}]){const {store,disk}=setup(),bad=workspace();mutate(bad);await assert.rejects(store.selectDirectory({workspace:bad}),/文件名无效/);assert.equal(disk.files.has('paper-workbench.json'),false);assert.equal(disk.files.size,0);}
  const {store,disk}=setup();await store.selectDirectory({workspace:workspace()});const manifest=head(disk);manifest.paper_locations.D001='../outside';disk.files.set('paper-workbench.json',JSON.stringify(manifest));const reopened=createDirectoryWorkspaceStore({fallbackStore:memoryStore(),metadata:{load:async()=>({handle:disk.handle})},cryptoImpl:webcrypto,origin:'https://fixture.example'});await reopened.load();await assert.rejects(reopened.save(workspace('Change')),/位置清单无效/);assert.equal([...disk.files.keys()].some(path=>path.includes('../')),false);
});

test('successful revisions preserve original paper locations and only current and previous managed snapshots',async()=>{
  const {store,disk}=setup();await store.selectDirectory({workspace:workspace()});disk.files.set('.paper-workbench/snapshots/user-backup.txt','A unique manual backup');const firstNote=disk.files.get('2026-10-21/D001/reading-note.md');
  for(let i=1;i<=4;i++){const value=workspace('Revision '+i);value.papers[0].analysis.analyzed_date='2026-10-22';await store.save(value);}
  const manifest=head(disk),snapshots=[...disk.files.keys()].filter(path=>/^\.paper-workbench\/snapshots\/[A-Za-z0-9_-]+\.json$/.test(path));assert.equal(snapshots.length,2);assert.ok(snapshots.includes(manifest.current.path));assert.ok(snapshots.includes(manifest.previous.path));assert.equal(manifest.paper_locations.D001,'2026-10-21/D001');assert.ok([...disk.files.values()].includes(firstNote));assert.equal(disk.files.get('.paper-workbench/snapshots/user-backup.txt'),'A unique manual backup');assert.ok(disk.removals.filter(x=>x.recursive).every(x=>/^\.paper-workbench\/staging\/[A-Za-z0-9_-]+$/.test(x.path)));
});

test('obsolete snapshots with manual changes are retained instead of being deleted by retention cleanup',async()=>{
  const {store,disk}=setup();await store.selectDirectory({workspace:workspace()});const original=head(disk).current.path;await store.save(workspace('Revision one'));disk.files.set(original,'Unique manually retained historical information');await store.save(workspace('Revision two'));
  assert.equal(disk.files.get(original),'Unique manually retained historical information');assert.equal(disk.removals.some(x=>x.path===original),false);assert.deepEqual(await store.load(),workspace('Revision two'));
});

test('loss of the metadata binding during an open session does not switch to a stale fallback library',async()=>{
  const {store,disk,fallback,metadata}=setup();await store.selectDirectory({workspace:workspace()});await fallback.save(workspace('Stale fallback'));metadata.clear();
  assert.deepEqual(await store.load(),workspace());const status=await store.getStatus();assert.equal(status.selected,true);assert.match(status.warning,/未退回浏览器旧草稿/);assert.equal(disk.files.has('paper-workbench.json'),true);
});

test('unserializable input fails before any directory writes or binding replacement',async()=>{
  const {store,disk,metadata,fallback}=setup();const invalid=workspace();invalid.circular=invalid;await assert.rejects(store.selectDirectory({workspace:invalid}),/circular/i);assert.equal(disk.files.size,0);assert.equal(await metadata.load(),null);assert.deepEqual(fallback.snapshot(),workspace());
});
