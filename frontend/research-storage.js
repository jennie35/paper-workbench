// User-authorized directory storage. A verified manifest is the commit point.
// Never reads outside the selected handle or recursively clears a user folder.
import {recordMarkdown,recordEvidence,researchFlowSvg,exportOfflineHtml} from './research-export.js?v=20261022-reference';
const HEAD='paper-workbench.json',MAGIC='paper-workbench-directory-v1';
const copy=value=>value==null?null:JSON.parse(JSON.stringify(value));
const safe=value=>{const name=String(value);if(!/^[A-Za-z0-9_.-]{1,160}$/.test(name)||name==='.'||name==='..')throw new Error('研究库文件名无效，未写入目录。');return name;};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function metadataStore(){
  let opened;const open=()=>opened||=new Promise((resolve,reject)=>{const r=indexedDB.open('paper-workbench-directory-binding',1);r.onupgradeneeded=()=>r.result.createObjectStore('binding');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('无法读取目录授权记录。'));});
  return {async load(){const db=await open();return new Promise((resolve,reject)=>{const r=db.transaction('binding').objectStore('binding').get('root');r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(new Error('无法读取目录授权记录。'));});},async save(value){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('binding','readwrite');tx.objectStore('binding').put(value,'root');tx.oncomplete=resolve;tx.onerror=()=>reject(new Error('目录授权记录未能保存。'));tx.onabort=tx.onerror;});}};
}
async function directory(root,parts,create){let folder=root;for(const part of parts)folder=await folder.getDirectoryHandle(safe(part),{create});return folder;}
async function read(root,path){try{const parts=path.split('/'),folder=await directory(root,parts.slice(0,-1),false),handle=await folder.getFileHandle(safe(parts.at(-1)));return await (await handle.getFile()).text();}catch(error){if(error.name==='NotFoundError')return null;throw error;}}
async function put(root,path,text){const parts=path.split('/'),folder=await directory(root,parts.slice(0,-1),true),file=await folder.getFileHandle(safe(parts.at(-1)),{create:true}),stream=await file.createWritable();try{await stream.write(text);await stream.close();}catch(error){await stream.abort?.().catch(()=>{});throw error;}}
async function removeFile(root,path){const parts=path.split('/'),folder=await directory(root,parts.slice(0,-1),false);await folder.removeEntry(safe(parts.at(-1)));}
async function removeSnapshot(root,snapshot,hash){const path=snapshot?.path;if(!/^\.paper-workbench\/snapshots\/[A-Za-z0-9_-]+\.json$/.test(path||'')||!/^[a-f0-9]{64}$/.test(snapshot?.sha256||''))return;const parts=path.split('/');try{const text=await read(root,path);if(text==null||await hash(text)!==snapshot.sha256)return;const parent=await directory(root,parts.slice(0,-1),false);await parent.removeEntry(parts.at(-1));}catch{/* A retained older snapshot is safer than removing an unknown or edited file. */}}
function parseHead(text){if(text==null)return null;let head;try{head=JSON.parse(text);}catch{throw new Error('目录清单损坏，未覆盖已有研究库。');}if(head.format!==MAGIC||!/^\.paper-workbench\/snapshots\/[A-Za-z0-9_-]+\.json$/.test(head.current?.path||''))throw new Error('该目录包含不兼容的研究库清单，未覆盖。');return head;}
const containsWork=value=>['projects','papers','references','jobs'].some(key=>Array.isArray(value?.[key])&&value[key].length);

export function createDirectoryWorkspaceStore({fallbackStore,showDirectoryPicker=globalThis.showDirectoryPicker?.bind(globalThis),metadata=undefined,cryptoImpl=globalThis.crypto,origin=globalThis.location?.origin||'test-origin'}={}){
  const binding=metadata||metadataStore();let root=null,head=null,loaded=false,lastWarning='';
  const hash=async text=>{if(!cryptoImpl?.subtle)throw new Error('需要 HTTPS 或本机安全页面才能核对保存指纹。');return [...new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');};
  const permission=async handle=>handle.queryPermission?await handle.queryPermission({mode:'readwrite'}):'granted';
  async function loadBinding(){const meta=await binding.load(),chosen=meta?.handle||null;if(loaded&&root&&!chosen){lastWarning='主目录授权记录已被移除。当前页仍使用已授权目录；请重新选择同一保存目录，以便下次打开时恢复，未退回浏览器旧草稿。';return meta;}if(!loaded||Boolean(chosen)!==Boolean(root)||chosen&&root&&root.isSameEntry&&!await root.isSameEntry(chosen)){root=chosen;head=null;loaded=true;}return meta;}
  async function status(){await loadBinding();const granted=root?await permission(root):'prompt';return {kind:root?'directory':'browser',supported:typeof showDirectoryPicker==='function',selected:Boolean(root),name:root?.name||'',permission:granted,needs_reconnect:Boolean(root&&granted!=='granted'),path_notice:'浏览器只提供已授权目录句柄，不暴露绝对路径。',last_saved_at:head?.updated_at||null,revision:head?.revision||null,warning:lastWarning};}
  async function readWorkspace(handle){
    if(await permission(handle)!=='granted')throw new Error('主目录授权已失效，请点击「保存目录」重新选择并授权；未退回浏览器旧草稿。');
    const current=parseHead(await read(handle,HEAD));if(!current)return {head:null,workspace:null};
    if(current.origin!==origin)throw new Error('此主目录已绑定另一个网页来源。请在原来源打开，避免两个页面相互覆盖。');
    const text=await read(handle,current.current.path);if(text==null||await hash(text)!==current.current.sha256)throw new Error('主目录研究库快照缺失或指纹不符；保留旧文件，请从备份恢复。');
    let workspace;try{workspace=JSON.parse(text);}catch{throw new Error('主目录研究库快照不可读取，未覆盖。');}return {head:current,workspace};
  }
  async function load(){await loadBinding();if(!root)return fallbackStore.load();const result=await readWorkspace(root);if(!result.head)throw new Error('已绑定主目录的清单缺失，未使用浏览器旧草稿替代。');head=result.head;return copy(result.workspace);}
  function projectBundle(workspace,project){const links=(workspace.links||[]).filter(x=>x.project_id===project.id),ids=new Set(links.map(x=>x.paper_id));return {schema_version:1,project,papers:(workspace.papers||[]).filter(x=>ids.has(x.id)),jobs:(workspace.jobs||[]).filter(x=>x.project_id===project.id),references:(workspace.references||[]).filter(x=>x.project_id===project.id),notice:'本目录是已授权研究库。浏览器分析未执行外部技能；全文文字、摘要及图表核验边界以每篇记录为准。'};}
  async function commit(handle,workspace,previous,onProgress){
    const id=cryptoImpl.randomUUID().replaceAll('-',''),files={},locations={...(previous?.paper_locations||{})},managed={...(previous?.managed_files||{})};
    const progress=message=>{try{onProgress?.({message});}catch{}};
    for(const paper of workspace.papers||[]){
      const pid=safe(paper.id),date=/^\d{4}-\d{2}-\d{2}$/.test(paper.analysis?.analyzed_date||'')?paper.analysis.analyzed_date:'undated';
      const base=locations[pid]||`${date}/${pid}`;if(!/^(?:\d{4}-\d{2}-\d{2}|undated)\/[A-Za-z0-9_-]+$/.test(base))throw new Error('论文位置清单无效，未写入。');locations[pid]=base;
      files[base+'/reading-note.md']=recordMarkdown(paper);files[base+'/evidence.json']=JSON.stringify(recordEvidence(paper),null,2);
      files[base+'/assets/research-flow.svg']=researchFlowSvg(paper.analysis?.flow_steps||[],paper.analysis?.source_basis||'abstract');
      files[base+'/source/source_map.json']=JSON.stringify({paper_id:paper.id,source_metadata:paper.analysis?.source_metadata||{},blocks:paper.analysis?.source_blocks||[],coverage:paper.analysis?.coverage||{},pdf_saved:false,notice:'此适配器保留实际提取文字和来源指纹，原始 PDF 与原图未持久保存；不得据此假称已取得原图。'},null,2);
    }
    const entries=[];for(const project of workspace.projects||[]){const pid=safe(project.id),path=`projects/${pid}/index.html`;files[path]=exportOfflineHtml(projectBundle(workspace,project));entries.push(`<li><a href="./${path}">${escape(project.name)}</a></li>`);}
    files['index.html']=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"><title>研究主目录</title><h1>研究主目录</h1><p>选择课题查看报告、跨论文综合与待执行行动。核验边界以保存记录为准。</p><ul>${entries.join('')}</ul></html>`;
    // Validate all existing managed targets before changing any published file.
    for(const [path,text] of Object.entries(files)){
      const existing=await read(handle,path),digest=await hash(text);if(existing!=null){const actual=await hash(existing);if(actual!==digest&&actual!==managed[path])throw new Error(`检测到手工编辑或未登记文件：${path}。已保留原文件；请先合并批注或选择新目录，未覆盖。`);}
    }
    progress('正在主目录临时区准备笔记、证据与离线看板…');
    const stage=`.paper-workbench/staging/${id}`;let number=0;
    for(const [path,text] of Object.entries(files)){const staged=stage+'/'+String(number++)+'.txt';await put(handle,staged,text);if(await hash(await read(handle,staged))!==await hash(text))throw new Error('临时成果指纹校验失败，旧版已保留。');}
    const priorHeadText=await read(handle,HEAD),latest=parseHead(priorHeadText);
    if(JSON.stringify(latest)!==JSON.stringify(previous||null))throw new Error('保存期间主目录版本改变，请刷新后重试，未更新台账。');
    const written=[];let next, nextHeadText;
    try{
      for(const [path,text] of Object.entries(files)){
        // Recheck immediately before publishing: staging does not authorize
        // overwriting edits made while this operation was preparing its files.
        if(await read(handle,HEAD)!==priorHeadText)throw new Error('保存期间主目录版本改变，已停止写入。');
        const existing=await read(handle,path),digest=await hash(text);if(existing===text){managed[path]=digest;continue;}
        if(existing!=null&&await hash(existing)!==managed[path])throw new Error(`保存期间文件改变：${path}。已保留更改，未覆盖。`);
        if(existing!=null&&managed[path]){const parts=path.split('/'),archive=`.paper-workbench/file-revisions/${managed[path]}/${parts.at(-1)}`;const prior=await read(handle,archive);if(prior==null)await put(handle,archive,existing);else if(await hash(prior)!==await hash(existing))throw new Error('修订归档冲突，未覆盖既有历史。');}
        written.push({path,oldText:existing,newHash:digest});
        await put(handle,path,text);if(await hash(await read(handle,path))!==digest)throw new Error('正式文件核对失败；未更新台账，请保留页面重试。');managed[path]=digest;
      }
      const snapshot=JSON.stringify(workspace),path=`.paper-workbench/snapshots/${id}.json`;await put(handle,path,snapshot);const digest=await hash(snapshot);if(await hash(await read(handle,path))!==digest)throw new Error('研究库快照核对失败，旧台账未替换。');
      next={format:MAGIC,origin,revision:id,updated_at:new Date().toISOString(),current:{path,sha256:digest},previous:previous?.current||null,paper_locations:locations,managed_files:managed};
      nextHeadText=JSON.stringify(next,null,2);
      if(await read(handle,HEAD)!==priorHeadText)throw new Error('提交前主目录版本改变，已停止更新台账。');
      await put(handle,HEAD,nextHeadText);const checked=await readWorkspace(handle);if(checked.head?.revision!==id)throw new Error('主目录提交核对失败，请保留页面。');
    }catch(error){
      // Restore only bytes this operation wrote. If another page/user changed
      // either the manifest or an artifact, retain that change for recovery.
      let restoreFiles=true,rollbackIncomplete=false;
      try{
        const actualHead=await read(handle,HEAD);
        if(nextHeadText&&actualHead===nextHeadText){
          if(priorHeadText==null)await removeFile(handle,HEAD);else await put(handle,HEAD,priorHeadText);
        }else if(actualHead!==priorHeadText){restoreFiles=false;rollbackIncomplete=true;}
      }catch{restoreFiles=false;rollbackIncomplete=true;}
      if(restoreFiles)for(const changed of written.reverse()){
        try{
          // A newly-created empty file can remain after createWritable fails;
          // it is deliberately not removed without a matching committed hash.
          const actual=await read(handle,changed.path);
          if(actual===changed.oldText)continue;
          if(actual==null||await hash(actual)!==changed.newHash){rollbackIncomplete=true;continue;}
          if(changed.oldText==null)await removeFile(handle,changed.path);else await put(handle,changed.path,changed.oldText);
        }catch{rollbackIncomplete=true;}
      }
      if(rollbackIncomplete)lastWarning='保存未完成，部分文件在保存期间改变或无法恢复；已保留用户更改、旧快照及临时文件，请检查目录后重试。';
      throw error;
    }
    // Remove only this operation's staged data and an obsolete managed snapshot.
    try{const staging=await directory(handle,['.paper-workbench','staging'],false);await staging.removeEntry(id,{recursive:true});}catch{/* Retain recoverable temporary files on cleanup failure. */}
    if(previous?.previous?.path)await removeSnapshot(handle,previous.previous,hash);
    progress('笔记、证据、离线看板和台账已核对保存。');return next;
  }
  async function save(value){await loadBinding();if(!root)return fallbackStore.save(value);const current=await readWorkspace(root);if(head&&current.head?.revision!==head.revision)throw new Error('主目录已被其他页面更新，请刷新研究库后重试。');head=await commit(root,copy(value),current.head);}
  async function selectDirectory({workspace,onProgress}={}){
    if(typeof showDirectoryPicker!=='function')throw new Error('当前浏览器不支持本机目录授权，请使用现代 Chrome/Edge 或私人后台。');
    const chosen=await showDirectoryPicker({id:'paper-workbench',mode:'readwrite'});if(await permission(chosen)!=='granted')throw new Error('未获得目录读写授权，原研究库未改变。');
    const saved=await readWorkspace(chosen);let next;
    if(saved.workspace){if(workspace&&containsWork(workspace)&&JSON.stringify(workspace)!==JSON.stringify(saved.workspace))throw new Error('该目录已有不同研究库。为保护两份资料，没有自动合并或覆盖；请先导出当前草稿，再从空浏览器库打开原目录。');next=saved.workspace;}
    else{if(!workspace)throw new Error('所选目录没有可恢复研究库，原授权目录未替换。');saved.head=await commit(chosen,copy(workspace),null,onProgress);next=copy(workspace);}
    await binding.save({handle:chosen});root=chosen;head=saved.head;loaded=true;
    // The browser keeps only the directory handle, never a second live library.
    try{if(fallbackStore.clear)await fallbackStore.clear();else await fallbackStore.save(null);if(await fallbackStore.load()!=null)throw new Error();lastWarning='';}catch{lastWarning='目录已成为正式来源，但旧浏览器草稿清理失败；请重新绑定同目录重试，不要把它当作第二个正式台账。';}
    return {workspace:copy(next),status:await status(),reused:Boolean(saved.workspace)};
  }
  return {load,save,getStatus:status,selectDirectory};
}
