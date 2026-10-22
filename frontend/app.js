import {demoProject, demoPapers} from './demo.js?v=20261022-visuals1';
import {activeStatuses, needsEvidence, summarizeBatch, candidateMatches, paperIdsForBatch} from './results.js';
import {apiOrigin, configurationComplete, scopeConfirmed, workflowState} from './workflow.js?v=20261022-visuals1';
import {createBrowserApi} from './browser-api.js?v=20261022-visuals1';
import {reportSections, synthesisHtml, hasReportContent, referenceValue, verifiedOriginals} from './research-view.js?v=20261022-visuals1';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = {mode:localStorage.getItem('pw-mode')==='direct'?'direct':'backend',demo:true,projects:[demoProject],project:demoProject,papers:demoPapers,jobs:[],activeJob:null,uploads:{},view:'latest',nav:'home',batchId:'',candidateFilter:'needs',candidateLimit:12,base:localStorage.getItem('pw-base')||'',token:sessionStorage.getItem('pw-token')||'',settings:{},poll:null,urls:[]};
const directApi=createBrowserApi();
directApi.ready.catch(()=>{});
const statusNames = {queued:'等待执行',running:'正在分析',completed:'批次结束',failed:'运行失败',cancelled:'已取消',pending:'待处理',excluded:'已排除',duplicate:'已分析，不计新增',no_fulltext:'待补全文',unverified:'未核验',reused:'已有记录'};
const stages = ['接口预检','检索','去重','获取全文','分析','图表核验','校验','完成'];
const watermark = '分析采用 norman-paper-reading 技能｜作者：N同学｜小红书：N同学｜B站/抖音：耐心的N同学\nAnalysis performed using the norman-paper-reading skill | Author: N同学 | Xiaohongshu: N同学 | Bilibili/Douyin: 耐心的N同学';

function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,5500);}
async function api(path,options={}){
  if(state.mode==='direct'&&!state.demo)return directApi.handle(path,options);
  const {onProgress,...backendOptions}=options;
  const token=state.token,base=state.base;
  const headers = {Authorization:`Bearer ${token}`,...options.headers};
  if(options.body && !(options.body instanceof FormData)) headers['Content-Type']='application/json';
  const res=await fetch(base+path,{...backendOptions,headers});
  if(!res.ok){let detail;try{detail=(await res.json()).detail;}catch{detail=`HTTP ${res.status}`;}if(res.status===401&&state.token===token&&state.base===base){state.token='';sessionStorage.removeItem('pw-token');}throw new Error(apiErrorMessage(detail,res.status));}
  return options.binary?res.blob():res.json();
}
function apiErrorMessage(detail,status){
  if(typeof detail==='string')return detail;
  if(Array.isArray(detail)){
    const names={text_model:'文本模型名称',vision_model:'视觉模型名称',api_key:'模型 API 密钥',base_url:'API 基础地址',count:'本批目标数量',name:'课题名称',password:'登录密码'};
    return detail.map(e=>{const label=names[e.loc?.at(-1)]||'输入内容';return ['string_too_short','missing'].includes(e.type)?`请填写${label}`:`${label}格式不正确，请检查后重试`;}).join('；');
  }
  return `请求失败（HTTP ${status}），请稍后重试`;
}
function providerFormValues(){
  for(const [id,label] of [['modelBase','API 基础地址'],['textModel','文本模型名称'],['visionModel','视觉模型名称']]){
    if(!$(id).value.trim()){$(id).focus();throw new Error(`请填写${label}。模型名称请从 API 供应商的模型列表复制；密钥不会自动填入模型名称。`);}
  }
  let url;try{url=new URL($('modelBase').value.trim());}catch{throw new Error('请填写有效的 HTTPS 模型基础地址。');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('模型地址应为不带凭据、查询参数或片段的 HTTPS 根地址。');
  if((!state.settings.has_api_key||apiOrigin(url.href)!==apiOrigin(state.settings.base_url))&&!$('apiKey').value.trim()){$('apiKey').focus();throw new Error('请填写当前供应商的 API 密钥。更换服务地址时不能沿用另一供应商的密钥。');}
  return {base_url:url.href.replace(/\/$/,''),api_key:$('apiKey').value.trim(),text_model:$('textModel').value.trim(),vision_model:$('visionModel').value.trim(),openalex_key:$('alexKey').value.trim()};
}
function jsonBody(value){return JSON.stringify(value);}
function showModal(title,body,wide=false){state.modalVersion=(state.modalVersion||0)+1;clearAssets();$('modalBody').inert=false;$('modalBody').removeAttribute('aria-busy');$('modal').classList.remove('api-connect');$('modal').classList.toggle('wide',wide);$('dialogLabel').textContent=title;$('modalBody').innerHTML=body;if(!$('modal').open)$('modal').showModal();}
function clearAssets(){state.urls.forEach(URL.revokeObjectURL);state.urls=[];}
function closeModal(){state.modalVersion=(state.modalVersion||0)+1;$('modal').close();clearAssets();}
$('closeModal').onclick=closeModal;
$('modal').addEventListener('close',clearAssets);
function field(label,id,value='',type='text',help=''){return `<label class="field">${esc(label)}<input id="${id}" type="${type}" value="${esc(value)}" ${type==='password'?'autocomplete="new-password"':''}>${help?`<small>${esc(help)}</small>`:''}</label>`;}
function area(label,id,value=''){return `<label class="field">${esc(label)}<textarea id="${id}">${esc(value)}</textarea></label>`;}
function choice(label,id,options,value,help=''){return `<label class="field">${esc(label)}<select id="${id}">${options.map(([key,title])=>`<option value="${esc(key)}" ${key===value?'selected':''}>${esc(title)}</option>`).join('')}</select>${help?`<small>${esc(help)}</small>`:''}</label>`;}
function researchConfigFields(scope){return `<details class="research-config" open><summary>课题条件 · 资源与约束</summary><div class="config-grid">${choice('当前研究阶段','scopeStage',[['exploration','探索'],['design','方案设计'],['experiment','实验开展'],['validation','方法验证'],['writing','论文撰写']],scope.research_stage||'exploration')}${field('每次目标新增篇数','scopeCount',scope.default_count||5,'number','默认 5 篇；可设为 1–20。')}${area('研究对象','scopeObject',scope.research_object)}${area('应用场景','scopeContext',scope.application_context)}${area('已有方法、模型或系统','scopeMethods',scope.existing_methods)}${area('已知设备、材料、数据与资源','scopeResources',scope.known_resources)}${area('预算、周期、样本、设备、伦理等约束','scopeConstraints',scope.constraints)}${area('参考资料及来源说明','scopeMaterials',scope.reference_materials)}${area('资料版本差异与待确认条件','scopeVersions',scope.version_differences)}${field('中文主题与同义词（逗号分隔）','scopeKeywordsZh',(scope.keywords_zh||[]).join(', '))}${field('English keywords / synonyms','scopeKeywordsEn',(scope.keywords_en||[]).join(', '))}${choice('输出语言','scopeLanguage',[['zh-CN','中文'],['en','English']],scope.output_language||'zh-CN')}${choice('运行方式','scopeRunMode',[['manual','立即执行一次 · 手动启动'],['existing-task','由已有定时任务触发']],scope.run_mode||'manual','此项记录运行偏好，不创建定时任务。在线直连需保持页面打开；已有定时任务由部署者接入后台。')}</div><p class="reader-meta">未知条件留空；论文中的设备与实验结果不会自动成为你的资源或已完成工作。参考路径与历史对话说明仅作为资料，不触发文件读取或执行命令。</p></details><label class="field">唯一长期保存位置<input id="scopeStorageRoot" readonly value="${esc(state.mode==='direct'?'请通过顶部「保存目录」选择并授权本机目录':state.settings.storage_root||scope.storage_root||'由部署者配置 DATA_DIR')}"><small>${state.mode==='direct'?'浏览器不能凭手填绝对路径访问磁盘。选择目录后才可确认已保存至该主目录；未绑定时只是浏览器草稿。':'后台主目录由部署配置控制；课题配置不能改写服务器存储位置。'}</small></label>`;}
function readResearchConfigFields(){
  const count=Number($('scopeCount').value);if(!Number.isInteger(count)||count<1||count>20)throw new Error('每次目标新增篇数应为 1–20 的整数。');
  const value={default_count:count,research_stage:$('scopeStage').value,output_language:$('scopeLanguage').value,run_mode:$('scopeRunMode').value};
  for(const [key,id] of [['research_object','scopeObject'],['application_context','scopeContext'],['existing_methods','scopeMethods'],['known_resources','scopeResources'],['constraints','scopeConstraints'],['reference_materials','scopeMaterials'],['version_differences','scopeVersions']])value[key]=$(id).value.trim();
  for(const [key,id] of [['keywords_zh','scopeKeywordsZh'],['keywords_en','scopeKeywordsEn']])value[key]=$(id).value.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean);
  return value;
}
function modalError(error){const el=$('formMessage');if(el){el.textContent=error.message;el.className='error';el.setAttribute('role','alert');}else toast(error.message);}
function modalContext(){const version=state.modalVersion;return ()=>$('modal').open&&state.modalVersion===version;}
function busy(handler,label='处理中…'){return async event=>{
  const button=event.currentTarget,inside=Boolean(button.closest?.('#modal')),current=modalContext(),body=$('modalBody');
  if(inside&&body.inert)return;
  const original=button.innerHTML;button.disabled=true;button.setAttribute('aria-busy','true');button.textContent=label;if(inside){body.inert=true;body.setAttribute('aria-busy','true');}
  try{await handler(event);}catch(error){if(!inside||current())modalError(error);}
  finally{if(button.isConnected){if(button.dataset.idleLabel){button.textContent=button.dataset.idleLabel;delete button.dataset.idleLabel;}else button.innerHTML=original;button.disabled=false;button.removeAttribute('aria-busy');}if(inside&&current()){body.inert=false;body.removeAttribute('aria-busy');}}
};}
function flowProgress(step){return `<div class="flow-progress" aria-label="启动分析步骤">${['建立课题','确认研究范围','配置模型','确认运行'].map((label,i)=>`<span class="${i===step?'is-current':''}">${i+1}. ${label}</span>`).join('')}</div>`;}
function pdfProgress(progress){return progress.stage==='extracting'?`正在提取 PDF 文字：第 ${Number(progress.page)||0} / ${Number(progress.totalPages)||0} 页…`:'正在本机打开参考 PDF…';}
function resetFilters(){for(const id of ['search','tagFilter','dateFilter','priorityFilter','statusFilter'])$(id).value='';state.batchId='';state.candidateFilter='needs';state.candidateLimit=12;}
async function selectProject(id){
  const next=state.projects.find(p=>p.id===id);if(!next)return;
  closeModal();
  const revision=state.selectionRevision=(state.selectionRevision||0)+1,identity=state.base+'|'+state.token;
  state.loadRevision=(state.loadRevision||0)+1;state.projectLoading=true;render();
  try{
    const [papers,jobs]=state.demo?[demoPapers,[]]:await Promise.all([api(`/api/projects/${id}/papers`),api(`/api/projects/${id}/jobs`)]);
    if(revision!==state.selectionRevision||identity!==state.base+'|'+state.token)return;
    state.project=next;state.papers=papers;state.jobs=jobs;resetFilters();state.nav='library';localStorage.setItem('pw-project',id);return true;
  }catch(error){if(revision===state.selectionRevision)toast('课题读取失败，已保留原课题：'+error.message);}
  finally{if(revision===state.selectionRevision){state.projectLoading=false;render();}}
}
function goHome(){if(state.projectLoading){state.selectionRevision=(state.selectionRevision||0)+1;state.projectLoading=false;}closeModal();state.nav='home';render();$('main').scrollIntoView({behavior:'smooth',block:'start'});}
async function openActiveJob(){const job=state.activeJob;if(!job)return;if(!await selectProject(job.project_id)||state.project?.id!==job.project_id)return;showBatchResults(job.id);}
function renderWorkflow(){
  if(state.nav!=='library')return;
  const flow=workflowState(state),el=$('workflowGuide');
  if(state.offline||state.connecting){
    el.innerHTML=`<div class="workflow-header"><strong>${state.connecting?'正在读取私人研究空间':'私人后台暂不可用'}</strong></div><p>${esc(state.offline||'正在同步课题、文献与运行状态…')}</p><p>这里没有切换成示例数据。已保存资料仍在私人后台，连接恢复后继续显示。</p>${state.connecting?'':`<div class="form-actions"><button class="primary" id="retryConnection">${state.token?'重试连接':'重新登录'}</button><button class="outline" id="changeConnection">更换后台</button><button class="quiet" id="showDemoExplicit">查看独立示例</button></div>`}`;
    $('retryConnection')?.addEventListener('click',busy(async()=>{if(state.token){try{await loadWorkspace();}catch(error){state.offline=error.message;render();throw error;}}else connectionForm();},'正在连接…'));
    $('changeConnection')?.addEventListener('click',()=>connectionForm());$('showDemoExplicit')?.addEventListener('click',enterDemo);
    $('newBatch').textContent='连接私人服务后开始';return;
  }
  el.hidden=state.demo||flow.action==='batch'||flow.action==='active';
  el.innerHTML=el.hidden?'':`<div class="workflow-next"><div><strong>${esc(flow.title)}</strong><p>${esc(flow.description)}</p></div><button class="primary workflow-action" id="workflowAction">${esc(({connect:'连接模型 API',create:'创建课题',scope:'确认研究范围',settings:'配置模型'})[flow.action])} →</button></div>`;
  if($('workflowAction'))$('workflowAction').onclick=busy(async()=>batchForm(),'正在打开…');
  $('newBatch').textContent=state.activeJob&&!state.demo?'查看运行中的批次 →':'＋ 开始检索与分析';
}

function connection(){
  $('demoNotice').hidden=!state.demo;$('modePill').textContent=state.demo?'DEMO · 合成数据':'PRIVATE · 私人课题库';$('modePill').classList.toggle('live',!state.demo);$('connectionDot').classList.toggle('live',!state.demo);$('connectionLabel').textContent=state.demo?'独立示例演示':'已连接私人服务';$('logout').hidden=state.demo;
  if(state.offline||state.connecting){$('modePill').textContent=state.connecting?'正在连接私人服务…':'私人服务连接中断';$('modePill').classList.remove('live');$('connectionDot').classList.remove('live');$('connectionLabel').textContent=state.connecting?'正在连接…':'未连接，数据未删除';}
  if(state.mode==='direct'&&!state.demo){$('modePill').textContent='ONLINE · API 直连';$('connectionLabel').textContent=state.settings.has_api_key?'已配置模型 API':'浏览器课题库 · 待填写 Key';$('logout').textContent='断开 API';}else $('logout').textContent='退出';
  $('directNotice').hidden=state.demo||state.mode!=='direct';$('storageButton').hidden=state.demo;
}
function dateLabel(value){const date=new Date(value);return Number.isNaN(date.valueOf())?'时间未记录':date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
function selectedBatch(){return state.jobs.find(job=>job.id===state.batchId)||state.jobs[0];}
function batchLabel(job){const order=[...state.jobs].sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||''))||a.id.localeCompare(b.id));return `B${String(Math.max(1,order.findIndex(x=>x.id===job.id)+1)).padStart(3,'0')} · ${job.id.slice(0,8).toUpperCase()}`;}
function reportLabel(p){return p.analysis?.report_label||(p.analysis?.analysis_mode==='browser-fulltext'?'全文文字报告':p.analysis?.analysis_mode==='browser-abstract'||p.id?.startsWith('D')?'摘要研究报告':p.analysis?.verified?'精读研究报告':'研究报告');}
function reportRecords(){
  const papers=[...state.papers],knownIds=new Set(papers.map(p=>p.id)),knownIdentity=new Set(papers.map(p=>p.doi?.toLowerCase()||p.title));
  for(const job of state.jobs)for(const [index,item] of (job.checkpoint?.candidates||[]).entries()){
    const identity=item.doi?.toLowerCase()||item.title;
    if(['duplicate','reused','excluded'].includes(item.status)||!hasReport(item.analysis)||knownIds.has(item.paper_id)||knownIdentity.has(identity))continue;
    papers.push({...item,id:item.paper_id||`candidate-${job.id}-${index}`,batch_id:job.id,analysis:item.analysis,_candidateJob:job.id,_candidateIndex:index});knownIdentity.add(identity);
  }
  return papers;
}
function hasReport(analysis){return typeof analysis?.summary==='string'&&Boolean(analysis.summary.trim());}
function displayAnalysis(value){
  const analysis=value&&typeof value==='object'?{...value}:{};
  for(const key of ['flow_steps','sources','verification_gaps','unread','reproduction_checklist','reading_list'])analysis[key]=Array.isArray(analysis[key])?analysis[key].filter(x=>x!=null):typeof analysis[key]==='string'?[analysis[key]]:[];
  analysis.flow_steps=analysis.flow_steps.filter(x=>typeof x==='string');
  for(const key of ['actions','evidence','visuals'])analysis[key]=(Array.isArray(analysis[key])?analysis[key]:[]).filter(x=>x&&typeof x==='object'&&!Array.isArray(x)).map(x=>({...x}));
  for(const evidence of analysis.evidence)evidence.source_block_ids=Array.isArray(evidence.source_block_ids)?evidence.source_block_ids.filter(x=>typeof x==='string'):[];
  for(const action of analysis.actions)action.evidence_ids=Array.isArray(action.evidence_ids)?action.evidence_ids.filter(x=>typeof x==='string'):[];
  return analysis;
}
function batchReportCounts(job){
  const ids=paperIdsForBatch(job),reused=new Set(job.checkpoint?.reused||[]),reports=reportRecords().filter(p=>p.batch_id===job.id||ids.has(p.id));
  return {generated:reports.filter(p=>!reused.has(p.id)).length,reused:reports.filter(p=>reused.has(p.id)).length};
}
function badge(label,tone='neutral'){return `<span class="status-badge ${tone}">${esc(label)}</span>`;}
function candidateStatus(item){if(item.fulltext_uploaded&&needsEvidence.has(item.status))return badge('全文已保存 · 待继续核验','warning');return badge(({completed:'已登记精读',excluded:'相关性不足，已排除',duplicate:'已有记录',no_fulltext:state.mode==='direct'?'缺少可读资料':'待补全文',unverified:item.analysis?'报告 · 待核验':'待分析',pending:'等待处理',reused:'此前已分析'})[item.status]||item.status,item.status==='completed'?'success':needsEvidence.has(item.status)?'warning':'neutral');}
function safeLink(value,label){try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return '';return `<a class="outline" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;}catch{return '';}}
function publicationLink(p){return safeLink(p.doi?'https://doi.org/'+encodeURI(p.doi):p.url,'出版社 / DOI');}
function switchView(view){state.view=view;document.querySelectorAll('[data-view]').forEach(tab=>{tab.classList.toggle('active',tab.dataset.view===view);tab.setAttribute('aria-selected',String(tab.dataset.view===view));});}
function showBatchResults(id){state.batchId=id||'';state.nav='library';state.candidateLimit=12;switchView('latest');render();$('batchSummary').scrollIntoView({behavior:'smooth',block:'start'});}
function renderBatchSummary(){
  const job=selectedBatch(),el=$('batchSummary');el.hidden=state.demo||!job;if(el.hidden)return;
  const s=summarizeBatch(job),n=batchReportCounts(job).generated;
  el.innerHTML=`<div class="summary-head"><div><p class="eyebrow">${esc(batchLabel(job))} · ${esc(dateLabel(job.created_at))}</p><h2>目标新增 ${s.target} 篇</h2></div>${badge(job.persistence_error?'保存失败 · 请先导出':s.active?job.stage:job.status==='failed'?'分析中断':job.status==='cancelled'?'已取消':'本次搜索结束',job.persistence_error?'danger':s.active?'neutral':n?'success':'warning')}</div><div class="batch-inline"><span>已生成 ${n} 篇新文献报告</span><button class="quiet" data-jobs>运行记录 ↓</button>${s.active?`<button class="outline" data-cancel="${esc(job.id)}" ${job.cancel_requested?'disabled':''}>${job.cancel_requested?'正在停止':'停止分析'}</button>`:n<s.target?`<button class="outline" data-retry="${esc(job.id)}">继续搜索新文献</button>`:''}</div>${s.active&&state.mode==='direct'?'<p>请保持本页打开，报告生成后会自动显示。</p>':''}${job.error?`<p class="error">${esc(job.error)}</p>`:''}`;
  bindResultActions(el);
}
function directDraftCount(job){return Number(job.reports_generated??job.checkpoint?.reports_generated??job.drafts_analyzed??job.checkpoint?.drafts_analyzed??(job.checkpoint?.candidates||[]).filter(c=>c.analysis).length)||0;}
function bindResultActions(root){
  root.querySelectorAll('[data-jobs]').forEach(button=>button.onclick=()=>{const history=$('batchHistory');if(history)history.open=true;$('batchHistoryPanel').scrollIntoView({behavior:'smooth',block:'start'});});
  root.querySelectorAll('[data-show-candidates]').forEach(button=>button.onclick=()=>{const details=$('candidateDetails');if(details)details.open=true;$('candidatePanel').scrollIntoView({behavior:'smooth',block:'start'});});
  root.querySelectorAll('[data-results]').forEach(button=>button.onclick=()=>showBatchResults(button.dataset.results));
  root.querySelectorAll('[data-retry]').forEach(button=>button.onclick=busy(()=>retryForm(button.dataset.retry),'正在读取批次…'));
  root.querySelectorAll('[data-cancel]').forEach(button=>button.onclick=busy(async()=>{await api(`/api/jobs/${button.dataset.cancel}/cancel`,{method:'POST'});await loadProject();toast('已请求停止；当前调用结束后保存检查点。');},'正在请求停止…'));
  root.querySelectorAll('[data-candidate]').forEach(button=>button.onclick=busy(()=>showCandidate(button.dataset.job,Number(button.dataset.candidate))));
}
function render(){
  connection();
  if(state.nav==='jobs')state.nav='library';
  if(!state.project||state.nav!=='library')state.nav='home';
  const home=state.nav==='home';
  $('main').classList.toggle('is-home',home);$('main').classList.toggle('is-library',!home);
  $('projectCount').textContent=state.offline||state.connecting?'—':String(state.projects.length).padStart(2,'0');
  for(const id of ['topicStrip','projectSidebarNav'])$(id).hidden=home;
  $('workflowGuide').hidden=home;$('stats').hidden=true;
  $('pageEyebrow').textContent=home?'YOUR RESEARCH PROJECTS':'PROJECT RESEARCH WORKSPACE';
  $('pageTitle').textContent=home?'从一个课题，开始研究。':'课题文献报告';
  $('pageIntro').textContent=home?'选择或创建课题，在课题内积累文献报告与研究行动。':'启动分析后，报告会按批次显示在下方。';
  if(home){$('newBatch').textContent='＋ 创建课题';$('batchSummary').hidden=true;$('candidatePanel').hidden=true;$('researchSynthesis').hidden=true;}
  else if(state.nav==='library')renderWorkflow();
  else $('newBatch').textContent=state.activeJob&&!state.demo?'查看运行中的批次 →':'＋ 开始检索与分析';
  $('breadcrumbName').textContent=home?'课题首页':state.project.name;$('topicTitle').textContent=state.project?.name||'建立你的第一个研究课题';$('topicGoal').textContent=state.project?.goal||'输入课题名称或上传 PDF，确定研究范围后开始分析。';
  $('projectSelect').innerHTML=state.projects.map(p=>`<option value="${esc(p.id)}" ${p.id===state.project?.id?'selected':''}>${esc(p.name)}</option>`).join('');
  $('export').disabled=state.mode==='direct'&&!state.demo?!state.project:state.papers.length===0;$('export').title=state.mode==='direct'?'导出本课题、候选与未核验草稿':state.papers.length?'导出已登记的正式文献记录':'尚无已登记文献；候选草稿可在其详情中单独导出';
  $('batchSelect').hidden=state.demo||state.view!=='latest'||!state.jobs.length;
  $('newBatch').disabled=Boolean(state.projectLoading||state.connecting);if($('workflowAction'))$('workflowAction').disabled=Boolean(state.projectLoading);
  $('projectSelect').disabled=Boolean(state.projectLoading||state.connecting||!state.projects.length);
  document.querySelectorAll('[data-nav]').forEach(b=>{b.classList.toggle('active',b.dataset.nav===state.nav);if(b.dataset.nav===state.nav)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $('workspace').hidden=state.nav!=='library';$('alternate').hidden=state.nav==='library';
  $('deleteProject').hidden=state.demo;$('deleteProject').disabled=Boolean(state.projectLoading||state.connecting);
  if(state.nav==='library')renderPapers();else renderProjects();
}
function tags(p){return Array.isArray(p.tags)&&p.tags.length?p.tags:Array.isArray(state.project?.scope?.keywords)?state.project.scope.keywords.slice(0,3):[];}
function renderPapers(){
  if((state.offline||state.connecting)&&!state.papers.length){$('batchSummary').hidden=true;$('candidatePanel').hidden=true;$('resultCount').textContent='私人资料尚未读取';$('cards').innerHTML='<div class="empty"><h3>等待连接私人研究空间</h3><p>连接恢复后显示文献，不会用示例替代你的研究记录。</p></div>';return;}
  if(state.projectLoading){$('batchSummary').hidden=true;$('candidatePanel').hidden=true;$('resultCount').textContent='正在同步当前课题';$('cards').innerHTML='<div class="empty is-loading" role="status"><h3>正在读取文献与批次…</h3><p>切换完成后显示当前课题的记录。</p></div>';return;}
  renderBatchSummary();
  const papers=reportRecords(),old=$('tagFilter').value;
  $('tagFilter').innerHTML='<option value="">全部主题</option>'+[...new Set(papers.flatMap(tags))].map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');$('tagFilter').value=old;
  const q=$('search').value.toLocaleLowerCase().trim(),tag=$('tagFilter').value,date=$('dateFilter').value,priority=$('priorityFilter').value,status=$('statusFilter').value;
  const job=selectedBatch(),latest=job?.id || papers[0]?.batch_id,ids=paperIdsForBatch(job);
  $('batchSelect').innerHTML=state.jobs.map(j=>`<option value="${esc(j.id)}">${esc(batchLabel(j))} · ${esc(dateLabel(j.created_at))}</option>`).join('');$('batchSelect').value=job?.id||'';
  $('batchSelect').hidden=state.demo||state.view!=='latest'||!state.jobs.length;
  let list=papers.filter(p=>{
    const a=displayAnalysis(p.analysis);
    return (state.view!=='latest'||p.batch_id===latest||ids.has(p.id))&&(state.view!=='latest'||!(job?.checkpoint?.reused||[]).includes(p.id))&&(!q||JSON.stringify([p.title,p.doi,a.summary,a.actions,tags(p)]).toLocaleLowerCase().includes(q))&&(!tag||tags(p).includes(tag))&&(!date||a.analyzed_date===date)&&(!priority||a.actions?.some(x=>x.priority===priority))&&(!status||(status==='verified')===!!a.verified);
  });
  list.sort((a,b)=>(b.analysis.analyzed_date||'').localeCompare(a.analysis.analyzed_date||''));
  $('resultCount').textContent=`${list.length} 篇${state.demo?'合成示例':'文献报告'}${state.view==='latest'&&job?' · '+batchLabel(job):''}`;
  const active=job&&activeStatuses.has(job.status);
  const empty=papers.length?'当前筛选下没有报告':active?'正在检索与生成报告':'尚未生成文献报告';
  const detail=papers.length?'可清空筛选或查看全部报告。':active?'首篇报告生成后会自动显示，无需跳转到其他页面。':job?'本次搜索尚无可展示的新报告。可继续搜索，或展开检索记录查看实际来源。':'确认研究范围后，开始第一批分析。';
  $('cards').innerHTML=list.map(p=>paperCard(p)).join('')||`<div class="empty"><h3>${empty}</h3><p>${detail}</p><div class="empty-actions">${papers.length?'<button class="outline" data-clear>清空筛选</button><button class="outline" data-all>全部报告</button>':job?'<button class="outline" data-show-candidates>查看检索记录 ↓</button>':'<button class="primary" data-first-batch>开始分析</button>'}</div></div>`;
  $('cards').querySelectorAll('[data-paper]').forEach(b=>b.onclick=()=>showPaper(b.dataset.paper));
  $('cards').onclick=event=>{const card=event.target.closest('[data-open-paper]');if(card&&!event.target.closest('button,a,input,select,textarea,summary'))showPaper(card.dataset.openPaper);};
  $('cards').querySelector('[data-clear]')?.addEventListener('click',clearFilters);
  $('cards').querySelector('[data-all]')?.addEventListener('click',()=>{switchView('all');renderPapers();});
  $('cards').querySelector('[data-first-batch]')?.addEventListener('click',batchForm);
  renderCandidates();renderBatchHistory();renderSynthesis();bindResultActions($('cards'));
}
function clearFilters(){resetFilters();renderPapers();}
function renderCandidates(){
  const job=selectedBatch(),panel=$('candidatePanel');panel.hidden=state.demo||!job;if(panel.hidden)return;
  const candidates=(job.checkpoint?.candidates||[]);
  const query=$('search').value;
  const order={unverified:0,no_fulltext:1,pending:2,completed:3,duplicate:4,reused:5,excluded:6};
  const matches=candidates.map((item,index)=>({item,index})).filter(({item})=>!hasReport(item.analysis)&&candidateMatches(item,state.candidateFilter,query)).sort((a,b)=>(order[a.item.status]??9)-(order[b.item.status]??9)||a.index-b.index);
  const s=summarizeBatch(job);
  const opened=$('candidateDetails')?.open;
  panel.innerHTML=`<details id="candidateDetails" ${opened?'open':''}><summary>本批检索记录 · ${candidates.filter(item=>!hasReport(item.analysis)).length} 条未生成报告的题录</summary><p>仅保留题录、筛选理由和资料缺口；已生成的报告显示在上方。</p>${s.diagnostics.length?bullet(s.diagnostics):''}<div class="candidate-toolbar"><label>状态 <select id="candidateStatus" aria-label="筛选候选状态"><option value="needs">待补资料</option><option value="no_fulltext">缺少可读内容</option><option value="unverified">尚待分析</option><option value="excluded">已排除</option><option value="all">全部题录</option></select></label><span>显示 ${Math.min(matches.length,state.candidateLimit)} / ${matches.length} 条</span></div><div class="candidate-list">${matches.slice(0,state.candidateLimit).map(({item,index})=>candidateCard(job,item,index)).join('')||'<p>当前状态下没有未生成报告的题录。</p>'}</div>${matches.length>state.candidateLimit?'<button class="outline" id="moreCandidates">再显示 12 条</button>':''}</details>`;
  $('candidateStatus').value=state.candidateFilter;$('candidateStatus').onchange=()=>{state.candidateFilter=$('candidateStatus').value;state.candidateLimit=12;renderCandidates();};
  $('moreCandidates')?.addEventListener('click',()=>{state.candidateLimit+=12;renderCandidates();});
  bindResultActions(panel);bindUploads(panel);
}
function candidateCard(job,item,index){
  const reason=item.reason||item.relevance_reason||(item.status==='pending'?'尚未进入阅读阶段':'暂无进一步说明');
  return `<article class="candidate-result"><div class="candidate-meta">${candidateStatus(item)}<span>${esc(item.source||'来源未记录')} · ${esc(item.year||'年份未知')} · ${item.publication_status==='published'?'正式发表':item.publication_status==='preprint'?'预印本':'发表状态待确认'}</span></div><h3 class="candidate-title"><button class="title-button" data-job="${esc(job.id)}" data-candidate="${index}">${esc(item.title||'未命名候选')}</button></h3><p class="candidate-meta">${esc((item.authors||[]).slice(0,4).join(' · '))}${item.journal?' · '+esc(item.journal):''}</p><p class="candidate-reason">${esc(reason)}</p>${item.fulltext_uploaded?`<div class="upload-feedback">已保存全文：${esc(item.uploaded_filename||'补充 PDF')} · ${esc(dateLabel(item.fulltext_uploaded_at))}。恢复整个批次后核对身份并分析。</div>`:''}<div class="candidate-actions"><button class="outline" data-job="${esc(job.id)}" data-candidate="${index}">${item.status==='unverified'?'阅读分析草稿':'查看题录与证据缺口'} →</button>${publicationLink(item)}${state.mode!=='direct'&&!activeStatuses.has(job.status)&&needsEvidence.has(item.status)?`<label class="outline upload-button">${item.fulltext_uploaded?'替换已补传 PDF':'补充全文 PDF'}<input class="sr-only" type="file" accept=".pdf,application/pdf" data-upload-job="${esc(job.id)}" data-index="${index}"></label>`:''}</div></article>`;
}
function bindUploads(root){root.querySelectorAll('[data-upload-job]').forEach(input=>input.onchange=async()=>{
  const file=input.files[0];if(!file)return;const ctx=modalContext(),inside=Boolean(input.closest('#modal')),feedback=input.closest('.candidate-result')?.querySelector('.upload-feedback');
  try{
    input.disabled=true;if(file.size>50*1024*1024)throw new Error('PDF 超过 50 MB。');
    const data=new FormData();data.append('file',file);const result=await api(`/api/jobs/${input.dataset.uploadJob}/candidates/${input.dataset.index}/pdf`,{method:'POST',body:data});
    const candidate=state.jobs.find(job=>job.id===input.dataset.uploadJob)?.checkpoint?.candidates?.[Number(input.dataset.index)];if(candidate)Object.assign(candidate,result);
    if(inside&&ctx()){
      const message=document.createElement('p');message.className='upload-feedback';message.textContent='全文已保存。点击「继续整个批次」，在确认范围与用量后恢复核验。';input.closest('.form-actions')?.after(message);
    }
    toast('全文已保存，核验状态尚未改变。下一步：继续整个批次。');await loadProject();
  }catch(error){if(!inside||ctx())modalError(error);if(feedback?.isConnected)feedback.textContent='上传失败：'+error.message;}
  finally{if(input.isConnected){input.disabled=false;input.value='';}}
});}
function paperCard(p){
  const a=displayAnalysis(p.analysis),verified=state.mode!=='direct'&&a.verified;
  const text=value=>typeof value==='string'&&hasReportContent(value)?value.trim():'';
  const priority=a.actions?.[0]?.priority;
  const summary=text(a.summary)||text(a.scientific_question);
  const relevance=referenceValue(a);
  const reading=Array.isArray(a.research_logic?.reading_priorities)?a.research_logic.reading_priorities.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)):[];
  const focus=state.view==='actions'?(a.actions||[]).map(x=>text(x.title)||text(x.hypothesis)).find(Boolean):state.view==='evidence'?reading.map(x=>text(x.reason)||text(x.locator)).find(Boolean)||(a.evidence||[]).map(x=>text(x.claim)).find(Boolean):'';
  const job=state.jobs.find(j=>j.id===p.batch_id),batch=job?batchLabel(job):'';
  const citation=[Array.isArray(p.authors)?p.authors.slice(0,2).join(' · '):'',p.journal,p.year].filter(hasReportContent).join(' · ');
  return `<article class="paper-card" data-open-paper="${esc(p.id)}"><div class="card-top"><span>${esc(p.id)}${batch?' · '+esc(batch):''}</span>${badge(state.demo?'合成示例':reportLabel(p),verified?'success':'neutral')}</div><div class="card-body"><h3><button class="title-button" data-paper="${esc(p.id)}">${esc(p.title)}</button></h3>${citation?`<p class="journal">${esc(citation)}</p>`:''}${tags(p).length||priority?`<div class="tags">${tags(p).slice(0,3).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}${priority?`<span class="tag priority">${esc(priority)} 优先级</span>`:''}</div>`:''}${summary?`<div class="card-summary"><span class="card-label">主要内容</span><p>${esc(summary)}</p></div>`:''}${relevance?`<div class="card-relevance"><span class="card-label">对本课题的参考借鉴</span><p>${esc(relevance)}</p></div>`:''}${focus?`<div class="card-focus"><span class="card-label">${state.view==='actions'?'待执行行动':'重点精读'}</span><p>${esc(focus)}</p></div>`:''}</div><div class="card-bottom"><span>${state.demo?'合成资料 · 非真实论文':verified?'已完成模型核验':reportLabel(p)}</span><button data-paper="${esc(p.id)}">查看详细分析 ↗</button></div></article>`;
}
function section(title,content,id){return `<section class="reader-section"${id?` id="reading-${id}"`:''}><h2>${title}</h2>${content}</section>`;}
function para(value){return hasReportContent(value)?`<p>${esc(value)}</p>`:'';}
function bullet(values){const items=(Array.isArray(values)?values:values?[values]:[]).filter(hasReportContent);return items.length?`<ul>${items.map(x=>`<li>${esc(typeof x==='object'?JSON.stringify(x):x)}</li>`).join('')}</ul>`:'';}
function readingBody(p,{draft=false,notes=[],notice='',artifacts=null}={}){
  const a=displayAnalysis(p.analysis),parts=reportSections({...p,analysis:a},{
    visualMode:'asset',coverageHtml:coverageHtml(a.coverage,artifacts),currentScope:state.project?.scope,
  });
  const savedNotes=notes.filter(row=>hasReportContent(row.notes));
  if(savedNotes.length)parts.push(['notes','分段阅读记录',savedNotes.map((row,i)=>`<details${i===0?' open':''}><summary>阅读分段 ${i+1}</summary><div class="reading-notes">${esc(row.notes)}</div></details>`).join('')]);
  const nav=parts.map(([id,title])=>`<a href="#reading-${id}">${esc(title)}</a>`).join('');
  const publication=[p.year,p.journal].filter(hasReportContent).join(' · '),authorLine=[(p.authors||[]).join(' · '),p.doi].filter(hasReportContent).map(esc).join('<br>');
  const scopeNote=state.demo?'合成示例，不对应真实论文。':[notice,a.verification_status,a.coverage?.scope].find(hasReportContent);
  return `<article class="reader"><div class="candidate-meta">${badge(state.demo?'合成演示':reportLabel(p),draft?'warning':'neutral')}${publication?`<span>${esc(publication)}</span>`:''}</div><h2>${esc(p.title)}</h2>${authorLine?`<p class="reader-meta">${authorLine}</p>`:''}${scopeNote?`<div class="reader-callout${draft?' warning':''}"><strong>阅读依据</strong>${para(scopeNote)}</div>`:''}${hasReportContent(a.transfer_notice)?`<div class="reader-callout">${esc(a.transfer_notice)}</div>`:''}<div class="candidate-actions">${publicationLink(p)}${draft?'<button class="outline" id="exportCandidate">导出报告 JSON</button>':''}${artifacts?.pdf_available?'<button class="outline" id="openCandidatePdf">下载已获取的全文 PDF</button>':''}${artifacts?.source_available?'<button class="outline" id="openCandidateSource">查看实际来源文字</button>':''}</div><div class="reader-layout"><nav class="reader-toc" aria-label="阅读目录"><strong>阅读目录</strong>${nav}</nav><div class="reader-content">${parts.map(([id,title,content])=>section(title,content,id)).join('')}<div id="candidateSource"></div>${!state.demo?`<p class="watermark">${esc(state.mode==='direct'?(verifiedOriginals(a).length?'浏览器 API 研究报告｜已记录选定原页的视觉模型核验，未经人工复核；未执行 norman-paper-reading 外部技能。':'浏览器 API 研究报告｜未执行 norman-paper-reading 外部技能；原图及公式未视觉核验。'):watermark)}</p>`:''}</div></div></article>`;
}
function coverageHtml(coverage,artifacts){
  const c=coverage||{},pages=Array.isArray(artifacts?.image_pages)?artifacts.image_pages:[],rawChecked=artifacts?.checked_visual_pages||c.visual_pages_checked,checked=Array.isArray(rawChecked)?rawChecked:[];
  const values=[['正文来源块',c.text_blocks_read],['PDF 页数',c.pdf_pages],['已获取原图页',pages.join('、')],['已实际核验页',checked.join('、')]].filter(([,value])=>hasReportContent(value));
  return values.length?`<dl>${values.map(([label,value])=>`<dt>${label}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`:'';
}
function renderMath(){
  if(window.temml)window.temml.renderMathInElement($('modalBody'),{delimiters:[{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'\\(',right:'\\)',display:false}],throwOnError:false,trust:false});
  for(const link of $('modalBody').querySelectorAll('a[href^="#source-"]'))link.onclick=event=>{const target=document.getElementById(link.getAttribute('href').slice(1));if(target){event.preventDefault();target.open=true;target.scrollIntoView({behavior:'smooth',block:'center'});}};
}
async function loadReaderAssets(base){
  const hide=el=>{const item=el.closest('[data-visual-record]');if(!item)return;item.remove();const section=$('modalBody').querySelector('#reading-visuals');if(section&&!section.querySelector('[data-visual-record]')){section.remove();$('modalBody').querySelector('a[href="#reading-visuals"]')?.remove();}};
  for(const el of $('modalBody').querySelectorAll('[data-asset]')){
    try{const blob=await api(`${base}/${el.dataset.asset}`,{binary:true});if(!el.isConnected)continue;const url=URL.createObjectURL(blob);state.urls.push(url);el.onerror=()=>hide(el);el.src=url;el.onclick=()=>window.open(url,'_blank','noopener');}
    catch{if(el.isConnected)hide(el);}
  }
}
async function showPaper(id){
  const p=reportRecords().find(p=>p.id===id);if(!p)return;
  if(p._candidateJob)return showCandidate(p._candidateJob,p._candidateIndex);
  showModal('READING ROOM · 文献研究报告',readingBody(p,{draft:state.mode==='direct'||!p.analysis?.verified,notice:p.analysis?.verification_status,artifacts:state.mode==='direct'?{source_available:Boolean(p.analysis?.source_blocks?.length||p.abstract),image_pages:verifiedOriginals(p.analysis).map(v=>v.page),checked_visual_pages:verifiedOriginals(p.analysis).map(v=>v.page)}:null}),true);renderMath();
  if(state.mode==='direct'){
    $('exportCandidate')?.addEventListener('click',()=>download(new Blob([JSON.stringify(p,null,2)],{type:'application/json'}),`${p.id}-report.json`));
    $('openCandidateSource')?.addEventListener('click',()=>{const el=$('candidateSource'),blocks=p.analysis?.source_blocks||[{id:'ABSTRACT-1',text:p.abstract,locator:(p.abstract_source||p.source||'题录来源')+' abstract'}];el.innerHTML=section('实际分析来源',blocks.map(block=>`<details><summary>${esc(block.id)} · ${esc(block.locator||'来源块')}</summary><div class="reading-notes">${esc(block.text)}</div></details>`).join('')+bullet(p.analysis?.sources));el.scrollIntoView({behavior:'smooth',block:'start'});});
  }
  if(!state.demo)await loadReaderAssets(`/api/papers/${Number(p.id.slice(1))}/assets`);
}
async function showCandidate(jid,index){
  const registered=state.jobs.find(job=>job.id===jid)?.checkpoint?.candidates?.[index]?.paper_id;
  if(registered&&state.papers.some(p=>p.id===registered))return showPaper(registered);
  showModal('CANDIDATE · 候选与草稿','<div class="empty"><h2>正在读取已保存的记录…</h2><p>此操作不调用模型 API。</p></div>',true);
  const version=state.modalVersion;
  try{
    const detail=await api(`/api/jobs/${jid}/candidates/${index}`);if(version!==state.modalVersion||!$('modal').open)return;
    const p={...detail.candidate,analysis:detail.analysis},base=`/api/jobs/${jid}/candidates/${index}`;
    const draft=p.status!=='completed'||p.analysis?.verified!==true;
    const opts={draft,notes:detail.reading_notes||[],notice:detail.notice,artifacts:detail.artifacts};
    let body=p.analysis?readingBody(p,opts):`<article class="reader">${candidateStatus(p)}<h2>${esc(p.title)}</h2><p class="reader-meta">${esc((p.authors||[]).join(' · '))}<br>${esc(p.journal||'刊物信息未记录')} · ${esc(p.year||'年份未记录')}</p><div class="reader-callout warning"><strong>当前只有候选题录，尚未完成精读。</strong><p>${esc(p.reason||p.relevance_reason||detail.notice)}</p></div><div class="candidate-actions">${publicationLink(p)}<button class="outline" id="exportCandidate">导出候选 JSON</button>${detail.artifacts?.pdf_available?'<button class="outline" id="openCandidatePdf">下载已获取的全文 PDF</button>':''}${detail.artifacts?.source_available?'<button class="outline" id="openCandidateSource">查看实际来源文字</button>':''}</div>${section('题录摘要 · 尚未全文核验',para(p.abstract||'检索源未提供摘要。请获取全文后核对内容。'))}${detail.reading_notes?.length?section('已保存的分段阅读记录',detail.reading_notes.map(row=>`<div class="reading-notes">${esc(row.notes)}</div>${bullet(row.unread)}`).join('')):''}<div id="candidateSource"></div></article>`;
    const job=state.jobs.find(j=>j.id===jid);
    if(job&&!activeStatuses.has(job.status)&&needsEvidence.has(p.status))body+=`<div class="form-actions">${state.mode==='direct'?'':`<label class="outline upload-button">补充全文 PDF<input class="sr-only" type="file" accept=".pdf,application/pdf" data-upload-job="${esc(jid)}" data-index="${index}"></label>`}<button class="primary" data-retry="${esc(jid)}">${state.mode==='direct'?'继续生成报告':'继续整个批次'}</button></div><p class="reader-meta">恢复分析将使用当前模型设置并产生 API 用量；已登记记录不会重复新增。</p>`;
    showModal('CANDIDATE READING · 候选与分析草稿',body,true);renderMath();bindResultActions($('modalBody'));bindUploads($('modalBody'));
    $('exportCandidate')?.addEventListener('click',()=>download(new Blob([JSON.stringify(detail,null,2)],{type:'application/json'}),`candidate-${index+1}-unverified.json`));
    $('openCandidatePdf')?.addEventListener('click',busy(async()=>{const blob=await api(base+'/pdf',{binary:true});download(blob,`candidate-${index+1}.pdf`);}));
    $('openCandidateSource')?.addEventListener('click',busy(async()=>{const el=$('candidateSource'),version=state.modalVersion;const source=await api(base+'/source');if(!el?.isConnected||version!==state.modalVersion)return;el.innerHTML=section('正文来源定位',`<p>${esc(source.notice||'来源定位不表示科学结论已核验')}</p>`+(source.blocks||[]).map(block=>`<details><summary>${esc(block.id)} · ${block.page?'PDF 第 '+esc(block.page)+' 页':'Crossref 摘要'}</summary><div class="reading-notes">${esc(block.text)}</div></details>`).join(''),'source-blocks');el.scrollIntoView({behavior:'smooth',block:'start'});}));
    if(p.analysis)await loadReaderAssets(base+'/assets');
  }catch(error){if(version===state.modalVersion&&$('modal').open){$('modalBody').innerHTML=`<div class="empty"><h2>暂时无法读取记录</h2><p>${esc(error.message)}</p><p>请刷新研究空间后重试；已保存资料仍在后端。</p></div>`;}}
}


function connectionForm(options={}){if(options.mode==='backend')backendConnectionForm(options);else directConnectionForm(options);}
function directConnectionForm({continueToBatch=false,onConnected=null}={}){
  const cfg=directApi.getSettings();
  showModal('CONNECT · API 直连',`<div class="connection-tabs"><button class="active" type="button">API 直连</button><button id="usePrivateBackend" type="button">私人后台 · 完整精读</button></div><h2>填写你的模型 API</h2><p>在线网页直接连接你选择的供应商，无需后台地址或管理员口令。</p><div class="callout">课题与报告保存在此浏览器。Key 仅本页内存，刷新后重填。自动尝试开放全文，无法获取时依据实际摘要生成报告。可选图像模型只检查实际取得的论文原页，未经人工复核；不执行外部阅读技能。</div><form id="directConnectForm"><label class="field">服务地址快捷填写<select id="directPreset"><option value="deepseek">DeepSeek</option><option value="custom">自定义兼容接口</option></select></label>${field('API 基础地址','directBase',cfg.base_url||'https://api.deepseek.com','url','填写 HTTPS 基础地址，程序自动添加 /chat/completions。')}${field('API Key','directKey','','password',cfg.has_api_key?'当前供应商的 Key 已在本页内存中；同一服务可留空保留。':'从模型服务商控制台复制 API Key。')}${field('文本模型名称','directModel',cfg.text_model||'','text','使用供应商提供的准确模型名，可获取可用列表后选择。')}${field('图像模型名称（可选）','directVisionModel',cfg.vision_model||'','text','填写支持 image input 的准确模型名，与文本模型使用同一 API 地址和 Key。留空则不调用图像接口；仅支持文字的服务无法核验原图。')}<div class="model-picker"><button class="outline" type="button" id="fetchModels">获取可用模型</button><select id="directModelChoices" aria-label="选择可用模型" hidden></select></div><p class="form-message" id="formMessage" role="status"></p><p class="reader-meta">保存连接不调用模型。确认启动分析或提取研究范围后，资料会发送给此供应商并产生 API 用量。接口需允许浏览器跨域访问（CORS）。</p><div class="form-actions"><button class="quiet" type="button" id="directDemo">查看示例</button><button class="primary" type="submit" id="directConnectSubmit">${continueToBatch?'保存并继续运行确认 →':'保存并进入课题库 →'}</button></div></form>`);
  $('modal').classList.add('api-connect');
  const current=modalContext();$('directPreset').value=apiOrigin($('directBase').value)==='https://api.deepseek.com'?'deepseek':'custom';
  $('usePrivateBackend').onclick=()=>backendConnectionForm({continueToBatch,onConnected});$('directDemo').onclick=()=>{closeModal();enterDemo();};
  $('directPreset').onchange=()=>{if($('directPreset').value==='deepseek'){if(apiOrigin($('directBase').value)!=='https://api.deepseek.com'){$('directKey').value='';$('directModel').value='';$('directVisionModel').value='';}$('directBase').value='https://api.deepseek.com';}};
  $('fetchModels').onclick=busy(async()=>{
    const models=await directApi.listModels({base_url:$('directBase').value.trim(),api_key:$('directKey').value.trim()});if(!current())return;
    $('directModelChoices').innerHTML='<option value="">选择模型…</option>'+models.map(id=>`<option value="${esc(id)}">${esc(id)}</option>`).join('');$('directModelChoices').hidden=false;
    $('formMessage').textContent=models.length?`已获取 ${models.length} 个模型。选择后仍可手动修改。`:'供应商未返回可选模型，请手动填写。';
  },'正在读取模型列表…');
  $('directModelChoices').onchange=()=>{if($('directModelChoices').value)$('directModel').value=$('directModelChoices').value;};
  const submit=busy(async()=>{
    await directApi.configure({base_url:$('directBase').value.trim(),api_key:$('directKey').value.trim(),text_model:$('directModel').value.trim(),vision_model:$('directVisionModel').value.trim()});if(!current())return;
    state.workspaceRevision=(state.workspaceRevision||0)+1;state.selectionRevision=(state.selectionRevision||0)+1;state.loadRevision=(state.loadRevision||0)+1;clearInterval(state.poll);
    state.mode='direct';state.base='';state.token='';state.demo=false;state.offline='';state.connecting=true;state.projectLoading=false;state.projects=[];state.project=null;state.papers=[];state.jobs=[];state.activeJob=null;localStorage.setItem('pw-mode','direct');render();
    await loadWorkspace();if(!current())return;if(onConnected)onConnected();else if(continueToBatch)batchForm();else closeModal();toast('已进入 API 直连课题库，尚未调用模型。');
  },'正在保存连接…');
  $('directConnectForm').onsubmit=event=>{event.preventDefault();return submit({currentTarget:event.submitter});};
}
function backendConnectionForm({continueToBatch=false,onConnected=null}={}){
  const localBase=['localhost','127.0.0.1'].includes(location.hostname)?location.origin:'';
  showModal('CONNECT · 私人后台',`<div class="connection-tabs"><button id="useDirectApi" type="button">API 直连</button><button class="active" type="button">私人后台 · 完整精读</button></div><h2>连接你的私人后台</h2><p>此模式支持服务器上的完整阅读技能与受保护资料。填写已部署的后台地址及独立管理员口令。</p><form id="connectForm">${field('私人后台地址','backendUrl',state.base||localStorage.getItem('pw-base')||localBase,'url','本机可使用当前网页地址；公网服务使用部署者提供的 HTTPS 地址。')}${field('后台管理员口令','adminPassword','','password','这是后台独立口令，不是模型 API Key。')}<p class="form-message" id="formMessage" role="status"></p><div class="form-actions"><button type="button" class="quiet" id="keepDemo">继续示例演示</button><button class="primary" type="submit">连接并继续 →</button></div></form>`);
  $('useDirectApi').onclick=()=>directConnectionForm({continueToBatch,onConnected});
  const current=modalContext();$('keepDemo').onclick=()=>{closeModal();enterDemo();};
  const submit=busy(async()=>{
    const url=new URL($('backendUrl').value.trim());if(url.username||url.password||url.search||url.hash)throw new Error('后台地址不能包含凭据、查询参数或片段。');
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('线上后台必须使用 HTTPS。');
    const base=url.href.replace(/\/$/,'');
    const response=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:jsonBody({password:$('adminPassword').value})});
    const data=await response.json();if(!response.ok)throw new Error(apiErrorMessage(data.detail,response.status));if(!current())return;
    await directApi.clearSession();state.mode='backend';state.base=base;state.token=data.token;sessionStorage.setItem('pw-token',state.token);localStorage.setItem('pw-base',base);localStorage.setItem('pw-mode','backend');
    await loadWorkspace();if(!current())return;if(onConnected)onConnected();else if(continueToBatch)batchForm();else closeModal();toast('已连接私人研究空间。');
  },'正在连接后台…');
  $('connectForm').onsubmit=event=>{event.preventDefault();return submit({currentTarget:event.submitter});};
}

async function loadWorkspace(){
  const identity=state.base+'|'+state.token,revision=state.workspaceRevision=(state.workspaceRevision||0)+1,selection=state.selectionRevision;
  const current=()=>identity===state.base+'|'+state.token&&revision===state.workspaceRevision&&selection===state.selectionRevision;
  try{
    const [projects,settings,status]=await Promise.all([api('/api/projects'),api('/api/settings'),api('/api/workspace/status')]);
    if(!current())return;
    const project=projects.find(p=>p.id===localStorage.getItem('pw-project'))||projects[0]||null;
    const [papers,jobs]=project?await Promise.all([api(`/api/projects/${project.id}/papers`),api(`/api/projects/${project.id}/jobs`)]):[[],[]];
    if(!current())return;
    const oldId=state.project?.id;
    state.loadRevision=(state.loadRevision||0)+1;state.demo=false;state.offline='';state.connecting=false;state.projectLoading=false;state.projects=projects;state.settings=settings;state.activeJob=status.active_job;state.project=project;state.papers=papers;state.jobs=jobs;
    if(oldId!==project?.id)resetFilters();if(project)localStorage.setItem('pw-project',project.id);render();startPolling();
  }catch(error){if(current()){if(state.demo){state.demo=false;state.projects=[];state.project=null;state.papers=[];state.jobs=[];}state.connecting=false;state.offline=error.message;render();}throw error;}
}
async function loadProject(){
  const projectId=state.project?.id,revision=state.loadRevision=(state.loadRevision||0)+1;
  if(projectId){
    const [papers,jobs,status]=await Promise.all([api(`/api/projects/${projectId}/papers`),api(`/api/projects/${projectId}/jobs`),state.mode==='direct'?api('/api/workspace/status'):Promise.resolve(null)]);
    if(state.demo||state.project?.id!==projectId||revision!==state.loadRevision)return;
    state.papers=papers;state.jobs=jobs;if(status)state.activeJob=status.active_job;localStorage.setItem('pw-project',projectId);
  }else{state.papers=[];state.jobs=[];}
  render();
}
function enterDemo(){state.workspaceRevision=(state.workspaceRevision||0)+1;state.loadRevision=(state.loadRevision||0)+1;state.selectionRevision=(state.selectionRevision||0)+1;clearInterval(state.poll);state.demo=true;state.offline='';state.connecting=false;state.projectLoading=false;state.projects=[demoProject];state.project=demoProject;state.papers=demoPapers;state.jobs=[];state.activeJob=null;resetFilters();state.nav='home';render();}
function requireService(){if(state.demo||state.offline||state.connecting){connectionForm({mode:!state.demo&&state.mode==='backend'?'backend':'direct'});return false;}return true;}
function startPolling(){
  clearInterval(state.poll);state.poll=setInterval(async()=>{
    if(!state.project||state.demo||state.pollBusy||state.projectLoading)return;
    const projectId=state.project.id,revision=state.loadRevision;state.pollBusy=true;
    const current=()=>!state.demo&&!state.projectLoading&&state.project?.id===projectId&&state.loadRevision===revision;
    try{
      const [jobs,status]=await Promise.all([api(`/api/projects/${projectId}/jobs`),api('/api/workspace/status')]);if(!current())return;
      const activeChanged=JSON.stringify(state.activeJob)!==JSON.stringify(status.active_job);state.activeJob=status.active_job;
      if(JSON.stringify(jobs)!==JSON.stringify(state.jobs)){
        const papers=await api(`/api/projects/${projectId}/papers`);if(!current())return;
        state.jobs=jobs;state.papers=papers;render();
      }else if(activeChanged){render();}
    }catch(e){if(current()){clearInterval(state.poll);state.offline=state.mode==='direct'?'浏览器课题库读取失败：'+e.message:state.token?'后台连接中断：'+e.message:'登录已过期，请重新连接服务';render();}}
    finally{state.pollBusy=false;}
  },5000);
}

function newProjectForm({continueToBatch=true}={}){
  if(state.demo||state.offline||state.connecting){connectionForm({onConnected:()=>newProjectForm({continueToBatch})});return;}
  showModal('NEW PROJECT · 建立研究课题',flowProgress(0)+`<h2>先确定你要研究什么</h2><p>输入名称即可创建。参考 PDF 可稍后补充，用于界定范围，不占精读篇数。</p><form id="projectForm">${field('课题名称（必填）','projectName')}${area('研究目标与已有条件（可选）','projectGoal')}<label class="field">参考 PDF（可选）<input id="referencePdf" type="file" accept="application/pdf,.pdf"><small>${state.mode==='direct'?'本机提取文字，不上传原 PDF。每份不超过 50 MB、300 页；扫描件需先做 OCR，加密文件请先解密。':'单份不超过 50 MB、300 页；扫描或加密文件可能无法读取。'}</small></label><p class="form-message" id="formMessage" role="status"></p><div class="form-actions"><button class="quiet" id="skipReference" type="button" hidden>跳过参考 PDF，确认范围</button><button class="primary" id="createSubmit" type="submit">创建并确认研究范围 →</button></div></form>`);
  const current=modalContext();let created=null;
  const openScope=()=>{if(!current()||!created)return;state.project=created;scopeForm({continueToBatch});};
  $('skipReference').onclick=openScope;
  const submit=busy(async()=>{
    const name=$('projectName').value.trim(),file=$('referencePdf').files[0];
    if(!name)throw new Error('请填写课题名称。');if(file&&file.size>50*1024*1024)throw new Error('PDF 超过 50 MB。');
    if(!created){
      const project=await api('/api/projects',{method:'POST',body:jsonBody({name,goal:$('projectGoal').value})});
      created=project;if(!current())return;state.projects=[project,...state.projects.filter(p=>p.id!==project.id)];
      state.project=project;state.papers=[];state.jobs=[];state.nav='library';resetFilters();await loadProject();if(!current())return;
      $('projectName').readOnly=true;$('projectGoal').readOnly=true;
    }
    if(file){
      $('formMessage').textContent='课题已创建，正在保存参考 PDF…';
      try{const data=new FormData();data.append('file',file);await api(`/api/projects/${created.id}/references`,{method:'POST',body:data,onProgress:progress=>{if(current())$('formMessage').textContent=pdfProgress(progress);}});}
      catch(error){if(current()){$('skipReference').hidden=false;$('createSubmit').dataset.idleLabel='重试上传并继续 →';throw new Error('课题已创建，不会重复新建。参考 PDF 上传失败：'+error.message+'；可以更换文件重试，或跳过后继续。');}return;}
    }
    openScope();
  },'正在保存课题与资料…');
  $('projectForm').onsubmit=event=>{event.preventDefault();return submit({currentTarget:event.submitter});};
}

function scopeForm({continueToBatch=false}={}){
  if(!state.project){newProjectForm({continueToBatch});return;}
  if(!requireService())return;
  const project=state.project,scope=project.scope||{},projectId=project.id;
  showModal('RESEARCH CONFIG · 课题配置与范围',(continueToBatch?flowProgress(1):'')+`<h2>${esc(project.name)}</h2><div class="config-status">${scope.inferred?'当前范围由名称推定，请检查后保存。':'当前范围已确认，可继续修改。'}手动编辑不消耗模型 API。</div>${area('核心科学问题','scopeQuestion',scope.research_question||scope.core_question)}${researchConfigFields(scope)}${field('合并检索词（逗号分隔）','scopeKeywords',(scope.keywords||[]).join(', '))}${area('纳入范围','scopeInclude',scope.include)}${area('排除范围','scopeExclude',scope.exclude)}<details><summary>参考资料 · 查看或补充 PDF</summary><div id="referenceList" role="status">正在读取资料列表…</div><label class="field">添加范围参考 PDF<input id="scopeReference" type="file" accept="application/pdf,.pdf"><small>${state.mode==='direct'?'在本浏览器提取文字并保存，不上传原文件。仅用于研究范围，不计入论文额度；最多 50 MB、300 页。':'不占精读额度；资料中的文字只作为研究数据处理。'}</small></label><button class="outline" id="uploadReference">保存参考 PDF</button><p id="referenceFeedback" class="upload-feedback" hidden></p></details><p class="form-message" id="formMessage" role="status"></p><p class="reader-meta">「使用模型提取」会发送课题与参考资料给当前 API，产生用量。提取后仍需你确认范围。</p><div class="form-actions"><button class="outline" id="inferScope" ${configurationComplete(state.settings)?'':'disabled'}>使用模型提取范围</button><button class="primary" id="saveScope">${continueToBatch?'保存范围并继续 →':'保存研究范围'}</button></div>${!configurationComplete(state.settings)?'<p class="reader-meta">模型尚未配置。可先手动保存范围，再继续配置模型。</p>':''}`);
  const current=modalContext();let referenceCoverage=scope.reference_coverage||null;
  if(state.mode==='direct'&&directApi.storageStatus)directApi.storageStatus().then(status=>{if(current())$('scopeStorageRoot').value=status.selected?'已授权目录：'+status.name+'（浏览器不提供绝对路径）':'尚未绑定主目录 · 浏览器草稿';}).catch(()=>{});
  async function refreshReferences(){
    try{
      const refs=await api(`/api/projects/${projectId}/references`);if(!current())return;
      $('referenceList').innerHTML=refs.length?`<ul class="reference-records">${refs.map(r=>`<li><strong>${esc(r.filename)}</strong> · ${Number(r.pages)} 页${state.mode==='direct'?`<small>已提取 ${Number(r.text_characters)||0} 字 · 有文字 ${Number(r.text_page_count)||0} 页 · 未读页：${esc(r.unread_pages?.join('、')||'无额外记录')}。仅文字提取，未核验原图。</small>${(r.warnings||[]).map(w=>`<p class="reference-warning">${esc(w)}</p>`).join('')}<details data-reference-text="${esc(r.id)}"><summary>查看本机提取文字</summary><pre>展开后读取…</pre></details>`:''}</li>`).join('')}</ul>`:'<p>尚未上传参考资料，可以仅依据课题名称运行。</p>';
      $('referenceList').querySelectorAll('[data-reference-text]').forEach(details=>details.ontoggle=async()=>{
        if(!details.open||details.dataset.loaded)return;details.dataset.loaded='loading';
        try{const ref=await api(`/api/projects/${projectId}/references/${details.dataset.referenceText}`);if(!current()||!details.isConnected)return;details.querySelector('pre').textContent=ref.text_pages.map(page=>`PDF 第 ${page.page} 页 · 提取文字\n${page.text}`).join('\n\n');details.dataset.loaded='ready';}
        catch(error){if(current()&&details.isConnected){details.querySelector('pre').textContent='读取失败：'+error.message;delete details.dataset.loaded;}}
      });
    }catch(error){if(current())$('referenceList').textContent='资料列表读取失败：'+error.message;}
  }
  refreshReferences();
  $('uploadReference').onclick=busy(async()=>{
    const file=$('scopeReference').files[0];if(!file)throw new Error('先选择参考 PDF。');if(file.size>50*1024*1024)throw new Error('PDF 超过 50 MB。');
    const data=new FormData();data.append('file',file);const reference=await api(`/api/projects/${projectId}/references`,{method:'POST',body:data,onProgress:progress=>{if(current()){$('referenceFeedback').hidden=false;$('referenceFeedback').textContent=pdfProgress(progress);}}});if(!current())return;
    $('scopeReference').value='';$('referenceFeedback').hidden=false;$('referenceFeedback').textContent=(state.mode==='direct'?`参考文字已保存在此浏览器${reference.reused?'（此 PDF 已保存）':''}。`:'参考 PDF 已保存。')+'新资料不会自动改写当前范围。下一步可使用模型提取，或手工编辑后保存。';await refreshReferences();
  },'正在保存 PDF…');
  $('inferScope').onclick=busy(async()=>{
    $('formMessage').textContent='正在读取已保存的参考资料并提取范围…';
    const result=await api(`/api/projects/${projectId}/infer-scope`,{method:'POST'});if(!current())return;
    $('scopeQuestion').value=result.research_question||result.core_question||'';$('scopeKeywords').value=(result.keywords||[]).join(', ');$('scopeInclude').value=result.include;$('scopeExclude').value=result.exclude;
    if(result.keywords_zh)$('scopeKeywordsZh').value=result.keywords_zh.join(', ');if(result.keywords_en)$('scopeKeywordsEn').value=result.keywords_en.join(', ');
    if(result.version_differences)$('scopeVersions').value=[$('scopeVersions').value,result.version_differences].filter(Boolean).join('\n');
    referenceCoverage=result.reference_coverage||null;
    $('formMessage').textContent='推定范围已填入，尚未保存。请检查后点击保存。'+(referenceCoverage?.reference_count?`本次使用 ${referenceCoverage.reference_count} 份参考资料，共发送 ${referenceCoverage.characters_sent} 字。${referenceCoverage.truncated?'参考文字较长，部分文字未发送；不表示全文覆盖。':''}`:'');
  },'正在提取研究范围…');
  $('saveScope').onclick=busy(async()=>{
    const value={...scope,...readResearchConfigFields(),research_question:$('scopeQuestion').value.trim(),keywords:$('scopeKeywords').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean),include:$('scopeInclude').value.trim(),exclude:$('scopeExclude').value.trim(),inferred:false};
    value.core_question=value.research_question;value.keywords=[...new Set([...value.keywords,...value.keywords_zh,...value.keywords_en])];
    if(state.mode==='direct'&&referenceCoverage)value.reference_coverage=referenceCoverage;
    if(!value.research_question&&!value.keywords.length)throw new Error('请至少填写科学问题或一个检索关键词。');
    const saved=await api(`/api/projects/${projectId}/scope`,{method:'PUT',body:jsonBody(value)});
    state.projects=state.projects.map(p=>p.id===projectId?saved:p);if(state.project?.id===projectId)state.project=saved;
    if(!current())return;render();if(continueToBatch)batchForm();else{closeModal();toast('研究范围已保存。');}
  },'正在保存范围…');
}

function settingsForm({continueToBatch=false,onComplete=null}={}){
  if(state.mode==='direct'&&!state.demo){directConnectionForm({continueToBatch,onConnected:onComplete});return;}
  if(!requireService())return;const cfg=state.settings;
  const preset=apiOrigin(cfg.base_url)==='https://api.deepseek.com'?'deepseek':apiOrigin(cfg.base_url)==='https://api.openai.com'?'openai':'custom';
  showModal('SETTINGS · 模型与检索配置',(continueToBatch?flowProgress(2):'')+`<h2>选择模型服务，保存后再运行</h2><button class="outline" type="button" id="settingsDirect">切换为 API 直连 · 浏览器课题库</button><p>这里配置的是模型 API；你的私人后台地址是 ${esc(state.base)}。两者用途不同。</p><label class="field provider-preset">服务地址快捷填写<select id="providerPreset"><option value="custom">自定义 / 保留现有地址</option><option value="deepseek">DeepSeek 官方地址</option><option value="openai">OpenAI 官方地址</option></select><small>快捷项只填写地址，不自动选择模型或开通计费。</small></label>${field('API 基础地址','modelBase',cfg.base_url||'','url','填写供应商提供的 HTTPS 基础地址；程序会添加 /chat/completions。')}${field('当前供应商的模型 API 密钥','apiKey','','password',cfg.has_api_key?'原服务已存密钥；同一服务留空保留，更换服务需重填。':'从当前供应商控制台复制；不要填写网页登录密码。')}${field('文本模型名称（必填）','textModel',cfg.text_model||'','text','复制供应商模型列表中的准确名称。')}<label class="field"><span><input id="sameModel" type="checkbox" ${!cfg.vision_model||cfg.vision_model===cfg.text_model?'checked':''}> 视觉核验使用同一个模型</span><small>只有该模型支持图片输入时才能使用；否则单独填写视觉模型。</small></label>${field('视觉模型名称（必填）','visionModel',cfg.vision_model||cfg.text_model||'','text','用于实际读取论文原页，不能用纯文本模型假称原图已核验。')}<details><summary>检索源设置（可选）</summary>${field('OpenAlex API 密钥','alexKey','','password',cfg.has_openalex_key?'已配置；留空保留。':'未配置时仅使用 Crossref。')}</details><div class="config-status" id="configStatus" role="status"></div><div class="model-check-status" id="checkStatus"></div><p class="form-message" id="formMessage" role="status"></p><p class="reader-meta">接口检查会实际调用文本和视觉模型，可能产生少量 API 费用。保存配置本身不调用模型。</p><div class="form-actions"><button class="outline" id="saveSettings">仅保存配置</button><button class="outline" id="checkSetup">保存并检查接口</button><button class="primary" id="continueSettings">${continueToBatch||onComplete?'保存并进入运行确认 →':'保存并返回工作台'}</button></div>`);
  $('settingsDirect')?.addEventListener('click',()=>directConnectionForm({continueToBatch,onConnected:onComplete}));
  const current=modalContext(),identity=state.base+'|'+state.token;
  $('providerPreset').value=preset;
  const dirty=()=>['modelBase','textModel','visionModel'].some((id,i)=>$(id).value.trim()!==[state.settings.base_url||'',state.settings.text_model||'',state.settings.vision_model||''][i])||Boolean($('apiKey').value||$('alexKey').value);
  function syncStatus(){if(!current())return;const changed=dirty();$('configStatus').textContent=changed?'有尚未保存的修改。检查和继续前会先保存当前填写内容。':configurationComplete(state.settings)?'当前配置已保存。':'尚未完成配置，请填写地址、密钥和模型名称。';$('checkStatus').textContent=!changed&&state.settings.preflight?.ready?`当前配置已通过接口检查 · ${dateLabel(state.settings.preflight.checked_at)}`:'当前填写内容尚未通过接口检查。也可在确认启动后，由任务自动预检。';$('visionModel').readOnly=$('sameModel').checked;}
  for(const id of ['modelBase','apiKey','textModel','visionModel','alexKey'])$(id).addEventListener('input',()=>{if(id==='textModel'&&$('sameModel').checked)$('visionModel').value=$('textModel').value;syncStatus();});
  $('sameModel').onchange=()=>{if($('sameModel').checked)$('visionModel').value=$('textModel').value;syncStatus();};
  $('providerPreset').onchange=()=>{
    const url=({deepseek:'https://api.deepseek.com',openai:'https://api.openai.com/v1'})[$('providerPreset').value];
    if(url&&apiOrigin(url)!==apiOrigin($('modelBase').value)){$('apiKey').value='';$('textModel').value='';$('visionModel').value='';}
    if(url)$('modelBase').value=url;syncStatus();
  };
  async function saveCurrent(){
    const values=providerFormValues();await api('/api/settings',{method:'PUT',body:jsonBody(values)});const saved=await api('/api/settings');
    if(identity!==state.base+'|'+state.token)return false;state.settings=saved;renderWorkflow();
    if(!current())return false;$('apiKey').value='';$('alexKey').value='';syncStatus();$('formMessage').className='success';$('formMessage').textContent='配置已保存。';return true;
  }
  $('saveSettings').onclick=busy(saveCurrent,'正在保存配置…');
  $('checkSetup').onclick=busy(async()=>{
    if(!await saveCurrent())return;$('formMessage').className='';$('formMessage').textContent='正在检查外部技能、文本与实际图像读取能力…';
    try{await api('/api/preflight',{method:'POST'});}catch(error){if(identity===state.base+'|'+state.token){const saved=await api('/api/settings');if(identity===state.base+'|'+state.token){state.settings=saved;renderWorkflow();if(current())syncStatus();}}throw error;}
    if(identity!==state.base+'|'+state.token)return;const saved=await api('/api/settings');if(identity!==state.base+'|'+state.token)return;state.settings=saved;renderWorkflow();if(!current())return;syncStatus();$('formMessage').className='success';$('formMessage').textContent='当前保存的配置通过检查。完整研究内容仍需逐篇核验。';
  },'正在保存并检查…');
  $('continueSettings').onclick=busy(async()=>{if(!await saveCurrent())return;if(onComplete)onComplete();else if(continueToBatch)batchForm();else{closeModal();render();toast('模型配置已保存。');}},'正在保存并继续…');
  syncStatus();
}

function batchForm(){
  if(state.demo||state.offline){connectionForm({continueToBatch:true,mode:!state.demo&&state.mode==='backend'?'backend':'direct'});return;}
  if(state.activeJob){openActiveJob().catch(modalError);return;}
  if(!state.project){newProjectForm({continueToBatch:true});return;}
  if(!scopeConfirmed(state.project)){scopeForm({continueToBatch:true});return;}
  if(!configurationComplete(state.settings)){settingsForm({continueToBatch:true});return;}
  const project=state.project,scope=project.scope;
  showModal('NEW BATCH · 运行前确认',flowProgress(3)+`<h2>${state.mode==='direct'?'一次检索，生成文献研究报告':'确认后开始检索与分析'}</h2><p>${esc(project.name)}</p><div class="callout"><strong>本批研究范围</strong><br>${esc(scope.research_question)}<br>关键词：${esc((scope.keywords||[]).join(' · '))}<br>纳入：${esc(scope.include)}<br>排除：${esc(scope.exclude)}</div><label class="field">目标新增篇数<input id="batchCount" type="number" min="1" max="20" value="${Number(scope.default_count)||5}"><small>允许 1–20；仅计尚未分析的新文献。</small></label><p>文本模型：${esc(state.settings.text_model)}${state.mode==='direct'?'<br>优先分析可取得的开放全文文字；摘要报告会单独标明。<br>图像模型：'+esc(state.settings.vision_model||'未配置，仅文字分析'):'<br>视觉模型：'+esc(state.settings.vision_model)}</p><div class="config-status">${state.mode==='direct'?'按当前课题生成有资料依据的报告，展示主要内容、对本课题的参考借鉴与研究行动。无内容的字段不展示，阅读范围如实标注。':state.settings.preflight?.ready?'当前配置已有通过的接口检查记录；任务仍会在运行时确认可用性。':'当前配置已保存，任务启动后先进行文本与视觉能力预检。'}</div><div class="callout">${state.mode==='direct'?'启动会产生 API 用量。课题问题、已填资源与约束、题录、实际正文或摘要及已有报告会发送给所配置模型服务；配置图像模型后，另发送最多3页关键原页图像用于核验并产生图像用量。报告保存在当前浏览器，请保持本页打开；关闭或刷新后任务停止，需手动恢复。':'启动会产生模型 API 用量。课题配置、候选题录、论文正文与原页及用于跨论文综合的已有报告内容会发送给当前模型服务。资料保存在私人后端，关闭网页后任务继续。'}</div><p class="form-message" id="formMessage" role="status"></p><div class="form-actions"><button class="outline" id="adjustScope">修改范围</button><button class="outline" id="adjustModels">修改模型</button><button class="primary" id="submitBatch">确认并开始分析 →</button></div>`);
  const current=modalContext();$('adjustScope').onclick=()=>scopeForm({continueToBatch:true});$('adjustModels').onclick=()=>settingsForm({continueToBatch:true});
  $('submitBatch').onclick=busy(async()=>{
    const count=Number($('batchCount').value);if(!Number.isInteger(count)||count<1||count>20)throw new Error('数量应为 1–20 的整数。');
    const job=await api(`/api/projects/${project.id}/jobs`,{method:'POST',body:jsonBody({count})});state.activeJob={id:job.id,project_id:project.id,status:'queued',stage:'等待执行'};
    if(!current())return;closeModal();state.nav='library';state.batchId=job.id;switchView('latest');await loadProject();toast(state.mode==='direct'?'任务已开始，请保持此页打开。':'任务已提交，正在后台执行。');
  },'正在提交任务…');
}

async function retryForm(jid){
  if(!requireService())return;if(state.activeJob){await openActiveJob();return;}
  const job=state.jobs.find(j=>j.id===jid)||await api(`/api/jobs/${jid}`),summary=summarizeBatch(job),scope=job.checkpoint?.scope_snapshot||{};
  showModal('RESUME · 继续整个批次',`<h2>确认恢复整个批次</h2><p>此操作处理本批仍缺证据的候选，不是只分析当前打开的这一篇。</p><div class="retry-summary"><div class="retry-metrics"><span>原目标 ${summary.target} 篇</span><span>已完成 ${summary.complete} 篇</span><span>待补全文 ${summary.missingFulltext} 篇</span><span>未核验 ${summary.unverified} 篇</span></div><strong>沿用原批次研究范围</strong><p>${esc(scope.research_question||'范围未记录，请先核对批次来源')}</p><p>${esc((scope.keywords||[]).join(' · '))}</p></div><p>使用当前保存的文本模型 ${esc(state.settings.text_model||'未配置')} 与视觉模型 ${esc(state.settings.vision_model||'未配置')}。</p><div class="callout">继续会产生 API 用量。已登记论文保持唯一编号；缺全文和未核验内容仍不计入完整精读。改变当前课题范围不会改写这个批次的原始范围。</div><p class="form-message" id="formMessage" role="status"></p><div class="form-actions"><button class="outline" id="retryCancel">返回结果</button><button class="primary" id="confirmRetry">${configurationComplete(state.settings)?'确认继续整个批次 →':'先配置模型 →'}</button></div>`);
  if(state.mode==='direct')showModal('RESUME · 继续生成报告',`<h2>继续生成本批报告</h2><p>沿用原批次研究范围，继续补充尚未生成报告的候选资料。已经保存的报告不会重复付费分析。</p><div class="retry-summary"><p>目标 ${summary.target} 篇 · 已生成报告 ${directDraftCount(job)} 篇</p><strong>原批次范围</strong><p>${esc(scope.research_question||'范围未记录')}</p><p>${esc((scope.keywords||[]).join(' · '))}</p></div><p>使用当前文本模型 ${esc(state.settings.text_model||'未配置')}。</p><div class="callout">恢复可能产生 API 用量。请保持此页打开；只分析实际取得的全文文字或摘要；没有可读内容的题录不会虚构分析。原图与公式仍未视觉核验，未执行外部阅读技能。</div><p class="form-message" id="formMessage" role="status"></p><div class="form-actions"><button class="outline" id="retryCancel">返回结果</button><button class="primary" id="confirmRetry">${configurationComplete(state.settings)?'确认继续分析 →':'先填写 API →'}</button></div>`);
  const current=modalContext();$('retryCancel').onclick=closeModal;
  $('confirmRetry').onclick=busy(async()=>{
    if(!configurationComplete(state.settings)){settingsForm({onComplete:()=>retryForm(jid)});return;}
    await api(`/api/jobs/${jid}/retry`,{method:'POST'});state.activeJob={id:jid,project_id:job.project_id,status:'queued',stage:'等待恢复'};
    if(!current())return;closeModal();state.nav='library';state.batchId=jid;switchView('latest');await loadProject();toast(state.mode==='direct'?'报告分析已恢复，请保持此页打开。':'整个批次已恢复，原有进度继续保留。');
  },'正在恢复批次…');
}

function renderProjects(){
  const unavailable=state.offline||state.connecting;
  const service=unavailable?`<section class="home-service" role="status"><h2>${state.connecting?'正在连接私人研究空间':'私人服务暂不可用'}</h2><p>${esc(state.offline||'正在读取你的课题列表…')}</p><p>已保存资料仍保留在私人后台。连接恢复后继续打开课题。</p>${state.connecting?'':'<button class="outline" id="homeReconnect">重新连接服务 →</button>'}</section>`:'';
  const cards=state.projects.map((p,index)=>`<article class="project-card"><div class="project-card-top"><span class="project-index">PROJECT / ${String(index+1).padStart(2,'0')}</span>${state.demo?badge('合成示例','warning'):`<button class="quiet danger-text" data-delete-project="${esc(p.id)}" aria-label="删除课题：${esc(p.name)}">删除</button>`}</div><h3>${esc(p.name)}</h3><p>${esc(p.goal||'打开课题后确认研究范围，开始整理文献与证据。')}</p><div class="tags">${(p.scope?.keywords||[]).slice(0,5).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div><div class="project-card-bottom"><span>文献报告 · 研究行动</span><button class="outline" data-open-project="${esc(p.id)}" ${state.projectLoading||state.connecting?'disabled':''}>${state.projectLoading?'正在读取…':'进入课题 →'}</button></div></article>`).join('');
  $('alternate').innerHTML=service+'<div class="section-bar"><div><p class="eyebrow">PROJECT LIBRARY</p><h2>我的课题</h2><p class="home-caption">每个课题拥有自己的研究范围、文献和分析记录。</p></div></div><div class="project-grid">'+cards+(!unavailable?'<button class="project-create" id="altNew"><span>＋</span><strong>创建研究课题</strong><small>输入课题名称，确认研究范围</small></button>':'')+'</div>'+(!state.projects.length&&!unavailable?'<p class="home-empty">从第一个课题开始。创建后可修改研究范围，再选择要分析的论文篇数。</p>':'');
  $('altNew')?.addEventListener('click',()=>newProjectForm());$('homeReconnect')?.addEventListener('click',()=>connectionForm());$('alternate').querySelectorAll('[data-open-project]').forEach(b=>b.onclick=()=>selectProject(b.dataset.openProject));
  $('alternate').querySelectorAll('[data-delete-project]').forEach(b=>b.onclick=()=>deleteProjectForm(b.dataset.deleteProject));
}
function renderBatchHistory(){
  const panel=$('batchHistoryPanel');panel.hidden=state.demo||!state.jobs.length;if(panel.hidden)return;
  const opened=$('batchHistory')?.open;
  panel.innerHTML=`<details id="batchHistory" ${opened?'open':''}><summary>批次记录 · ${state.jobs.length} 次分析</summary><div class="batch-history-list">${state.jobs.map(job=>{
    const counts=batchReportCounts(job),active=activeStatuses.has(job.status);
    return `<div class="batch-history-row"><div><strong>${esc(batchLabel(job))}</strong><small>${esc(dateLabel(job.created_at))} · ${esc(active?job.stage:statusNames[job.status]||job.status)} · 目标新增 ${Number(job.requested)||0} 篇 · 已生成 ${counts.generated} 篇</small></div><button class="quiet" data-results="${esc(job.id)}">查看报告 →</button></div>`;
  }).join('')}</div></details>`;
  bindResultActions(panel);
}

function renderSynthesis(){
  const panel=$('researchSynthesis'),job=selectedBatch();panel.hidden=state.demo||!job;if(panel.hidden)return;
  const synthesis=job.checkpoint?.synthesis||{},ready=synthesis.status==='completed',partial=['partial','insufficient_evidence','unavailable'].includes(synthesis.status),opened=$('synthesisDetails')?.open;
  panel.innerHTML=`<details id="synthesisDetails" ${opened?'open':''}><summary><span>跨论文综合与研究决策</span>${badge(ready?'综合已保存':partial?'部分综合 · 证据不足':activeStatuses.has(job.status)?'本批结束后综合':'综合尚未完成',ready?'neutral':'warning')}</summary><p>比较相互支持与冲突的证据，明确判断变化，并安排 1—3 项最值得先验证的行动。</p>${partial?'<p class="notice">当前综合尚有缺口；保留已有比较和实际原因，不推定为完整证据。</p>':''}${ready||partial?synthesisHtml(synthesis):`<p>${esc(synthesis.error||'尚无已保存综合；不把空白结果当作没有研究冲突。')}</p>`}<div class="form-actions"><button class="outline" id="showResearchBrief">查看当次简报</button><button class="outline" id="refreshSynthesis" ${activeStatuses.has(job.status)?'disabled':''}>${ready||partial?'重新综合现有证据':'综合现有证据'}</button></div></details>`;
  $('refreshSynthesis').onclick=()=>synthesisForm(job.id);$('showResearchBrief').onclick=()=>showResearchBrief(job.id);
}
function synthesisForm(jid){
  if(!requireService())return;const job=state.jobs.find(j=>j.id===jid);if(!job)return;
  if(activeStatuses.has(job.status)){toast('当前批次仍在运行，结束后会综合。');return;}
  showModal('SYNTHESIS · 跨论文综合',`<h2>综合当前课题的已保存证据</h2><p>分析相互支持、冲突原因、判断变化和优先验证行动。依据该批次原始配置，不把后续建议当作已完成工作。</p><div class="callout">将发送课题配置及已保存报告内容至当前模型 API，可能产生用量。此操作不新增论文，不升级原图或公式核验等级。</div><p class="form-message" id="formMessage" role="status"></p><div class="form-actions"><button class="outline" id="cancelSynthesis">返回课题</button><button class="primary" id="confirmSynthesis">${configurationComplete(state.settings)?'确认综合':'先配置模型'}</button></div>`);
  const current=modalContext();$('cancelSynthesis').onclick=closeModal;
  $('confirmSynthesis').onclick=busy(async()=>{
    if(!configurationComplete(state.settings)){settingsForm({onComplete:()=>synthesisForm(jid)});return;}
    await api(`/api/jobs/${jid}/synthesis`,{method:'POST'});if(!current())return;
    closeModal();await loadProject();const details=$('synthesisDetails');if(details)details.open=true;toast('综合已更新；研究行动仍为待执行建议。');
  },'正在综合证据…');
}
function briefMarkdown(job){
  const ids=paperIdsForBatch(job),reused=new Set(job.checkpoint?.reused||[]),papers=reportRecords(),added=papers.filter(p=>(p.batch_id===job.id||ids.has(p.id))&&!reused.has(p.id)),s=job.checkpoint?.synthesis||{};
  const date=new Date(job.updated_at||job.created_at),day=Number.isNaN(date.valueOf())?'日期未记录':date.toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'});
  const lines=[`# ${day} · 研究简报`,`课题：${state.project?.name||'未记录'} · ${batchLabel(job)}`,`新增研究报告 ${added.length} 篇，其中完成模型全文核验 ${added.filter(p=>p.analysis?.verified).length} 篇；课题累计 ${papers.length} 篇报告（含未核验记录）。`,`目标新增 ${job.requested} 篇；实际新增 ${added.length} 篇。`,'','## 逐篇概况'];
  for(const paper of added){
    const a=displayAnalysis(paper.analysis),r=a.research_logic||{},target=r.reading_priorities?.[0],link=paper.doi?'https://doi.org/'+paper.doi:paper.url;
    lines.push(`- ${paper.id} · ${paper.title}${hasReportContent(a.summary)?'：'+a.summary:''}`);
    if(link)lines.push(`  原文：${link}`);
    const reading=target?[target.locator,target.reason].filter(hasReportContent).join('；'):a.reading_list.find(hasReportContent);
    if(reading)lines.push(`  值得精读：${reading}`);
    if(hasReportContent(a.future_insights))lines.push(`  研究启示：${a.future_insights}`);
    if(hasReportContent(a.verification_status))lines.push(`  阅读范围：${a.verification_status}`);
  }
  if(!added.length)lines.push('本次搜索尚无新增报告。');
  const priorities=Array.isArray(s.priority_actions)?s.priority_actions.slice(0,3):[];
  if(priorities.length)lines.push('','## 优先验证的行动（待执行）');
  for(const x of priorities){const paper=papers.find(p=>p.id===x.record_id),action=paper?.analysis?.actions?.find(a=>a.id===x.action_id);const description=[action?.title,x.reason].filter(hasReportContent).join('；');if(description)lines.push(`- ${[x.record_id,x.action_id].filter(Boolean).join(' / ')}：${description}`);}
  lines.push('','## 看板与保存结果',state.mode==='direct'?'当前为在线浏览器研究库；是否写入唯一主目录，请查看顶部「保存目录」实际状态。':`后台主目录：${state.settings.storage_root||state.project?.scope?.storage_root||'由部署者配置'}`,'结构校验通过不等于科学结论已经得到验证。');return lines.join('\n');
}
function showResearchBrief(jid){
  const job=state.jobs.find(j=>j.id===jid);if(!job)return;const text=briefMarkdown(job);
  showModal('RESEARCH BRIEF · 当次简报',`<h2>${esc(batchLabel(job))} · 研究简报</h2><pre class="research-brief">${esc(text)}</pre><div class="form-actions"><button class="outline" id="downloadBrief">导出这份 Markdown 简报</button></div>`,true);
  $('downloadBrief').onclick=()=>download(new Blob([text],{type:'text/markdown;charset=utf-8'}),`${job.id.slice(0,8)}-research-brief.md`);
}

async function storageForm(){
  if(state.demo){toast('示例不产生长期研究成果。');return;}
  showModal('STORAGE · 唯一长期保存目录','<h2>研究成果保存位置</h2><p id="storageStatus" role="status">正在读取实际保存状态…</p><p class="form-message" id="formMessage" role="status"></p><div class="form-actions" id="storageActions"></div>');
  const current=modalContext();
  try{
    if(state.mode!=='direct'){$('storageStatus').textContent='私人后台主目录：'+(state.settings.storage_root||state.project?.scope?.storage_root||'由部署者配置 DATA_DIR')+'。所有后台研究资料由部署服务保存，不能在课题表单改写服务器路径。';return;}
    const status=await directApi.storageStatus();if(!current())return;
    $('storageStatus').textContent=status.selected?`已选择主目录：${status.name}。${status.path_notice||'浏览器不提供绝对路径。'}${status.needs_reconnect?' 需要重新授权才能读取或写入；不会自动退回旧草稿。':''}`:'尚未绑定长期主目录。当前内容是浏览器草稿。选择目录后，核对并保存当前研究库，再以该目录为唯一正式来源。';
    if(status.warning)$('formMessage').textContent=status.warning;
    $('storageActions').innerHTML=status.supported?'<button class="primary" id="chooseResearchDirectory">选择并授权主目录</button>':'<p>当前浏览器不提供目录授权。请使用支持该功能的浏览器，或通过私人后台配置主目录；也可按需手动导出。</p>';
    $('chooseResearchDirectory')?.addEventListener('click',busy(async()=>{
      if(state.activeJob)throw new Error('先停止当前任务并等待保存完成，再切换主目录。');
      const saved=await directApi.selectDirectory({onProgress:progress=>{if(current())$('storageStatus').textContent=typeof progress==='string'?progress:progress.message||'正在核对并保存研究库…';}});
      if(!current())return;await loadWorkspace();$('storageStatus').textContent=`主目录已绑定：${saved?.name||'已选择目录'}。以后保存以此目录为准；原始论文或原图是否实际取得，以每份来源记录为准。`;
      if(saved?.warning)$('formMessage').textContent=saved.warning;
      toast('研究库已保存到所选主目录。');
    },'正在绑定主目录…'));
  }catch(error){if(current())modalError(error);}
}

function deleteProjectForm(pid=state.project?.id){
  if(state.demo){toast('合成示例不需要删除。');return;}
  const project=state.projects.find(p=>p.id===pid);if(!project)return;
  if(state.activeJob?.project_id===pid){toast('该课题正在分析，请先停止任务，再删除课题。');return;}
  showModal('DELETE PROJECT · 删除课题',`<h2>删除「${esc(project.name)}」？</h2><p>将删除该课题的范围、参考资料和批次记录，并移除其论文关联。其他课题使用的论文仍会保留，编号不会重置。</p><div class="callout">此操作无法撤销。需要备份时，请先返回课题导出资料。</div><p class="form-message" id="formMessage" role="status"></p><div class="form-actions"><button class="outline" id="cancelDelete">保留课题</button><button class="danger-button" id="confirmDelete">确认删除课题</button></div>`);
  const current=modalContext();$('cancelDelete').onclick=closeModal;
  $('confirmDelete').onclick=busy(async()=>{
    const result=await api(`/api/projects/${pid}`,{method:'DELETE'});
    if(!current())return;closeModal();
    state.selectionRevision=(state.selectionRevision||0)+1;state.loadRevision=(state.loadRevision||0)+1;
    state.projects=state.projects.filter(p=>p.id!==pid);
    if(state.project?.id===pid){state.project=null;state.papers=[];state.jobs=[];resetFilters();}
    if(localStorage.getItem('pw-project')===pid)localStorage.removeItem('pw-project');
    state.nav='home';await loadWorkspace();toast(result?.cleanup_pending?.length?'课题记录已删除；部分参考文件清理失败，请部署者检查存储目录。':'课题已删除。');
  },'正在删除课题…');
}

function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
$('export').onclick=async()=>{if(!requireService())return;if(!state.project)return;try{const kind=$('exportKind').value;download(await api(`/api/projects/${state.project.id}/export?kind=${kind}`,{binary:true}),state.mode==='direct'?`research-drafts.${kind==='markdown'?'md':kind}`:kind==='json'?'papers.json':`research-${kind}.zip`);}catch(e){toast(e.message);}};
for(const id of ['search','tagFilter','dateFilter','priorityFilter','statusFilter'])$(id).addEventListener('input',renderPapers);
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{switchView(b.dataset.view);renderPapers();});
document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{if(b.dataset.nav==='home'){goHome();return;}state.nav=b.dataset.nav;render();});
$('projectSelect').onchange=()=>selectProject($('projectSelect').value);
$('connect').onclick=connectionForm;$('settings').onclick=()=>state.demo?connectionForm():settingsForm();$('newProject').onclick=newProjectForm;$('newBatch').onclick=()=>state.nav==='home'?newProjectForm():batchForm();$('editScope').onclick=scopeForm;
$('topSettings').onclick=()=>state.demo?connectionForm():settingsForm();
$('directSettings').onclick=()=>directConnectionForm();
$('storageButton').onclick=()=>storageForm();
$('switchProject').onclick=goHome;
$('deleteProject').onclick=()=>deleteProjectForm();
$('clearFilters').onclick=clearFilters;
$('batchSelect').onchange=()=>{const selected=$('batchSelect').value;resetFilters();state.batchId=selected;renderPapers();};
$('refreshWorkspace').onclick=busy(async()=>{if(state.demo){render();toast('示例演示已刷新');return;}await loadWorkspace();toast('课题、文献与批次已更新');});
$('logout').onclick=async()=>{if(state.mode==='direct'){await directApi.clearSession();await loadWorkspace();toast('API Key 已从本页内存清除，浏览器课题仍保留。');return;}state.token='';sessionStorage.removeItem('pw-token');enterDemo();toast('已退出私人空间');};
$('help').onclick=()=>showModal('GUIDE · 使用说明','<h2>从课题进入你的研究</h2><p>1. 创建或打开课题，确认研究范围，可上传参考 PDF。</p><p>2. 填写模型 API 地址、Key 与准确模型名。Key 仅本页内存；课题与报告保存在当前浏览器。</p><p>3. 点击「开始检索与分析」，确认篇数与资料发送范围。报告会逐篇出现在课题中。</p><p>4. 用批次选择器查看 B001 等分析记录；摘要报告与全文文字报告分别标明。来源不足的题录收在折叠检索记录中。</p><p>5. 可查看研究行动、导出课题，或在课题菜单删除不再需要的课题。</p><div class="callout">浏览器模式会尝试开放全文文字；出版社跨域限制、付费墙或缺少可读资料时不能保证获取全文。图表与公式未视觉核验，未执行服务器外部阅读技能。研究行动均为待执行建议。</div>');
render();
if(state.mode==='direct'||state.base&&state.token){if(state.mode==='direct'){state.base='';state.token='';}state.demo=false;state.connecting=true;state.projects=[];state.project=null;state.papers=[];state.jobs=[];render();loadWorkspace().catch(error=>{state.connecting=false;state.offline=error.message;render();});}
