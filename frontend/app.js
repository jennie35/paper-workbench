import {demoProject, demoPapers} from './demo.js';
import {activeStatuses, needsEvidence, summarizeBatch, batchOutcome, candidateMatches, paperIdsForBatch} from './results.js';
import {apiOrigin, configurationComplete, scopeConfirmed, workflowState} from './workflow.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = {demo:true,projects:[demoProject],project:demoProject,papers:demoPapers,jobs:[],activeJob:null,uploads:{},view:'latest',nav:'home',batchId:'',candidateFilter:'needs',candidateLimit:12,base:localStorage.getItem('pw-base')||'',token:sessionStorage.getItem('pw-token')||'',settings:{},poll:null,urls:[]};
const statusNames = {queued:'等待执行',running:'正在分析',completed:'批次结束',failed:'运行失败',cancelled:'已取消',pending:'待处理',excluded:'已排除',duplicate:'已分析，不计新增',no_fulltext:'待补全文',unverified:'未核验',reused:'复用证据'};
const stages = ['接口预检','检索','去重','获取全文','分析','图表核验','校验','完成'];
const watermark = '分析采用 norman-paper-reading 技能｜作者：N同学｜小红书：N同学｜B站/抖音：耐心的N同学\nAnalysis performed using the norman-paper-reading skill | Author: N同学 | Xiaohongshu: N同学 | Bilibili/Douyin: 耐心的N同学';

function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,5500);}
async function api(path,options={}){
  const token=state.token,base=state.base;
  const headers = {Authorization:`Bearer ${token}`,...options.headers};
  if(options.body && !(options.body instanceof FormData)) headers['Content-Type']='application/json';
  const res=await fetch(base+path,{...options,headers});
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
function showModal(title,body,wide=false){state.modalVersion=(state.modalVersion||0)+1;clearAssets();$('modalBody').inert=false;$('modalBody').removeAttribute('aria-busy');$('modal').classList.toggle('wide',wide);$('dialogLabel').textContent=title;$('modalBody').innerHTML=body;if(!$('modal').open)$('modal').showModal();}
function clearAssets(){state.urls.forEach(URL.revokeObjectURL);state.urls=[];}
function closeModal(){state.modalVersion=(state.modalVersion||0)+1;$('modal').close();clearAssets();}
$('closeModal').onclick=closeModal;
$('modal').addEventListener('close',clearAssets);
function field(label,id,value='',type='text',help=''){return `<label class="field">${esc(label)}<input id="${id}" type="${type}" value="${esc(value)}" ${type==='password'?'autocomplete="new-password"':''}>${help?`<small>${esc(help)}</small>`:''}</label>`;}
function area(label,id,value=''){return `<label class="field">${esc(label)}<textarea id="${id}">${esc(value)}</textarea></label>`;}
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
async function openActiveJob(){const job=state.activeJob;if(!job)return;if(!await selectProject(job.project_id)||state.project?.id!==job.project_id)return;state.nav='jobs';render();$('alternate').scrollIntoView({behavior:'smooth',block:'start'});}
function renderWorkflow(){
  if(state.nav!=='library')return;
  const flow=workflowState(state),el=$('workflowGuide');
  if(state.offline||state.connecting){
    el.innerHTML=`<div class="workflow-header"><strong>${state.connecting?'正在读取私人研究空间':'私人后台暂不可用'}</strong></div><p>${esc(state.offline||'正在同步课题、文献与运行状态…')}</p><p>这里没有切换成示例数据。已保存资料仍在私人后台，连接恢复后继续显示。</p>${state.connecting?'':`<div class="form-actions"><button class="primary" id="retryConnection">${state.token?'重试连接':'重新登录'}</button><button class="outline" id="changeConnection">更换后台</button><button class="quiet" id="showDemoExplicit">查看独立示例</button></div>`}`;
    $('retryConnection')?.addEventListener('click',busy(async()=>{if(state.token){try{await loadWorkspace();}catch(error){state.offline=error.message;render();throw error;}}else connectionForm();},'正在连接…'));
    $('changeConnection')?.addEventListener('click',()=>connectionForm());$('showDemoExplicit')?.addEventListener('click',enterDemo);
    $('newBatch').textContent='连接私人服务后开始';return;
  }
  el.innerHTML=`<div class="workflow-header"><strong>研究准备与下一步</strong><span class="operation-status">${state.demo?'示例不调用 API':state.projectLoading?'正在读取课题…':'已连接私人服务'}</span></div><div class="workflow-steps">${flow.steps.map((step,i)=>`<div class="workflow-step ${step.complete?'is-complete':flow.action===({connection:'connect',project:'create',scope:'scope',model:'settings'})[step.key]?'is-current':''}"><span class="step-number">${step.complete?'✓':i+1}</span><div><strong>${esc(step.label)}</strong><small>${esc(step.description)}</small></div></div>`).join('')}</div><div class="workflow-next"><div><strong>${esc(flow.title)}</strong><p>${esc(flow.description)}</p></div><button class="primary workflow-action" id="workflowAction">${esc(({connect:'连接私人服务',create:'创建课题',scope:'确认研究范围',settings:'配置模型',active:'查看运行中的批次',batch:'开始一批分析'})[flow.action])} →</button></div>`;
  const steps=el.querySelector('.workflow-steps');if(flow.steps.every(step=>step.complete)&&steps){const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='准备已完成 · 展开查看配置与检查状态';details.className='workflow-details';details.append(summary);steps.replaceWith(details);details.append(steps);}
  $('workflowAction').onclick=busy(async()=>{if(flow.action==='active')await openActiveJob();else batchForm();},'正在打开…');
  $('newBatch').textContent=state.activeJob&&!state.demo?'查看运行中的批次 →':'＋ 开始检索与分析';
}

function connection(){
  $('demoNotice').hidden=!state.demo;$('modePill').textContent=state.demo?'DEMO · 合成数据':'PRIVATE · 私人课题库';$('modePill').classList.toggle('live',!state.demo);$('connectionDot').classList.toggle('live',!state.demo);$('connectionLabel').textContent=state.demo?'独立示例演示':'已连接私人服务';$('logout').hidden=state.demo;
  if(state.offline||state.connecting){$('modePill').textContent=state.connecting?'正在连接私人服务…':'私人服务连接中断';$('modePill').classList.remove('live');$('connectionDot').classList.remove('live');$('connectionLabel').textContent=state.connecting?'正在连接…':'未连接，数据未删除';}
}
function dateLabel(value){const date=new Date(value);return Number.isNaN(date.valueOf())?'时间未记录':date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
function selectedBatch(){return state.jobs.find(job=>job.id===state.batchId)||state.jobs[0];}
function badge(label,tone='neutral'){return `<span class="status-badge ${tone}">${esc(label)}</span>`;}
function candidateStatus(item){if(item.fulltext_uploaded&&needsEvidence.has(item.status))return badge('全文已保存 · 待继续核验','warning');return badge(({completed:'已登记精读',excluded:'相关性不足，已排除',duplicate:'已有记录',no_fulltext:'待补全文',unverified:'草稿 · 未核验',pending:'等待处理',reused:'复用已有证据'})[item.status]||item.status,item.status==='completed'?'success':needsEvidence.has(item.status)?'warning':'neutral');}
function safeLink(value,label){try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return '';return `<a class="outline" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;}catch{return '';}}
function publicationLink(p){return safeLink(p.doi?'https://doi.org/'+encodeURI(p.doi):p.url,'出版社 / DOI');}
function switchView(view){state.view=view;document.querySelectorAll('[data-view]').forEach(tab=>{tab.classList.toggle('active',tab.dataset.view===view);tab.setAttribute('aria-selected',String(tab.dataset.view===view));});}
function showBatchResults(id){state.batchId=id||'';state.nav='library';state.candidateLimit=12;switchView('latest');render();$('batchSummary').scrollIntoView({behavior:'smooth',block:'start'});}
function renderBatchSummary(){
  const job=selectedBatch(),el=$('batchSummary');el.hidden=state.demo||!job;if(el.hidden)return;
  const s=summarizeBatch(job);
  const explanation=s.active?'后台正在执行。刷新或关闭网页不会停止任务，已保存的结果会自动更新。':s.full?'已登记的论文可以从下方文献卡进入阅读，或切换到精读证据与研究行动。':`${s.missingFulltext} 篇存在全文缺口${s.uploadedFulltext?'（'+s.uploadedFulltext+' 篇已补传）':''}，${s.unverified} 篇未完成核验，${s.excluded} 条相关性不足已排除。候选与草稿在下方保留，不计入完整精读。`;
  el.innerHTML=`<div class="summary-head"><div><p class="eyebrow">BATCH RESULTS · ${esc(dateLabel(job.created_at))}</p><h2>${esc(batchOutcome(job))}</h2></div>${badge(s.full?'达到本批目标':s.active?job.stage:'进度已保存',s.full?'success':s.active?'neutral':'warning')}</div><p>${esc(explanation)}</p><div class="summary-metrics">${[[s.target,'目标篇数'],[s.complete,'新增完整精读'],[s.total,'候选记录'],[s.shortfall,s.active?'距目标':'精读缺额']].map(([n,label])=>`<div><strong class="metric-value">${n}</strong><span class="metric-label">${label}</span></div>`).join('')}</div>${job.error?`<p class="error">${esc(job.error)}</p>`:''}<div class="summary-actions"><button class="outline" data-jobs>查看批次与检索记录</button>${s.missingFulltext+s.unverified+s.pending?'<button class="primary" data-show-candidates>查看候选与分析草稿 ↓</button>':''}${!s.active&&(!s.full||job.status!=='completed')?`<button class="outline" data-retry="${esc(job.id)}">继续整个批次</button>`:''}</div>`;
  bindResultActions(el);
}
function bindResultActions(root){
  root.querySelectorAll('[data-jobs]').forEach(button=>button.onclick=()=>{state.nav='jobs';render();});
  root.querySelectorAll('[data-show-candidates]').forEach(button=>button.onclick=()=>{$('candidatePanel').scrollIntoView({behavior:'smooth',block:'start'});});
  root.querySelectorAll('[data-results]').forEach(button=>button.onclick=()=>showBatchResults(button.dataset.results));
  root.querySelectorAll('[data-retry]').forEach(button=>button.onclick=busy(()=>retryForm(button.dataset.retry),'正在读取批次…'));
  root.querySelectorAll('[data-cancel]').forEach(button=>button.onclick=busy(async()=>{await api(`/api/jobs/${button.dataset.cancel}/cancel`,{method:'POST'});await loadProject();toast('已请求停止；当前调用结束后保存检查点。');},'正在请求停止…'));
  root.querySelectorAll('[data-candidate]').forEach(button=>button.onclick=busy(()=>showCandidate(button.dataset.job,Number(button.dataset.candidate))));
}
function render(){
  connection();
  if(!state.project||!['library','jobs'].includes(state.nav))state.nav='home';
  const home=state.nav==='home';
  for(const id of ['topicStrip','projectTabs','projectSidebarNav'])$(id).hidden=home;
  for(const id of ['workflowGuide','stats'])$(id).hidden=state.nav!=='library';
  $('pageEyebrow').textContent=home?'YOUR RESEARCH PROJECTS':'PROJECT RESEARCH WORKSPACE';
  $('pageTitle').textContent=home?'从一个课题，开始研究。':'让阅读，走向下一步研究。';
  $('pageIntro').textContent=home?'选择或创建课题，在课题内积累文献、分析结果与研究行动。':'当前课题的文献、批次、证据与研究行动集中保存在这里。';
  if(home){$('newBatch').textContent='＋ 创建课题';$('batchSummary').hidden=true;$('candidatePanel').hidden=true;}
  else if(state.nav==='library')renderWorkflow();
  else $('newBatch').textContent=state.activeJob&&!state.demo?'查看运行中的批次 →':'＋ 开始检索与分析';
  $('breadcrumbName').textContent=home?'课题首页':state.project.name;$('topicTitle').textContent=state.project?.name||'建立你的第一个研究课题';$('topicGoal').textContent=state.project?.goal||'输入课题名称或上传 PDF，确定研究范围后开始分析。';
  $('projectSelect').innerHTML=state.projects.map(p=>`<option value="${esc(p.id)}" ${p.id===state.project?.id?'selected':''}>${esc(p.name)}</option>`).join('');
  const completed=state.papers.filter(p=>p.analysis.verified).length;
  const actions=state.papers.flatMap(p=>p.analysis.actions||[]);
  const pending=new Set(state.jobs.flatMap(j=>(j.checkpoint?.candidates||[]).filter(c=>['no_fulltext','unverified'].includes(c.status)).map(c=>c.doi||c.title))).size;
  const metrics=state.demo?[[4,'条合成文献记录','仅用于界面演示','▤'],[0,'篇完成真实精读','示例不计入分析成果','◉'],[3,'张示例行动卡','研究方案尚未执行','↗'],[1,'个示例证据缺口','展示未获得全文的状态','◷']]:[[state.papers.length,'篇累计文献','当前课题关联的独立论文','▤'],[completed,'篇完成模型核验','结构通过 ≠ 科学结论已证实','◉'],[actions.length,'项待执行研究行动','按资源与证据安排优先级','↗'],[pending,'项待补证据','缺全文或原图未核验','◷']];
  $('stats').innerHTML=metrics.map(([n,label,note,icon])=>`<div class="stat"><span class="stat-label">${label}</span><span class="stat-decoration">${icon}</span><span class="stat-value">${(state.offline||state.connecting)&&!state.papers.length?'—':n}</span><div class="stat-note">${note}</div></div>`).join('');
  $('export').disabled=state.papers.length===0;$('export').title=state.papers.length?'导出已登记的正式文献记录':'尚无已登记文献；候选草稿可在其详情中单独导出';
  $('batchSelect').hidden=state.demo||state.view!=='latest'||!state.jobs.length;
  $('newBatch').disabled=Boolean(state.projectLoading||state.connecting);if($('workflowAction'))$('workflowAction').disabled=Boolean(state.projectLoading);
  $('projectSelect').disabled=Boolean(state.projectLoading||state.connecting||!state.projects.length);
  document.querySelectorAll('[data-nav]').forEach(b=>{b.classList.toggle('active',b.dataset.nav===state.nav);if(b.dataset.nav===state.nav)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $('workspace').hidden=state.nav!=='library';$('alternate').hidden=state.nav==='library';
  if(state.nav==='library')renderPapers();else if(state.nav==='jobs')renderJobs();else renderProjects();
}
function tags(p){return p.tags||state.project?.scope?.keywords?.slice(0,3)||[];}
function renderPapers(){
  if((state.offline||state.connecting)&&!state.papers.length){$('batchSummary').hidden=true;$('candidatePanel').hidden=true;$('resultCount').textContent='私人资料尚未读取';$('cards').innerHTML='<div class="empty"><h3>等待连接私人研究空间</h3><p>连接恢复后显示文献，不会用示例替代你的研究记录。</p></div>';return;}
  if(state.projectLoading){$('batchSummary').hidden=true;$('candidatePanel').hidden=true;$('resultCount').textContent='正在同步当前课题';$('cards').innerHTML='<div class="empty is-loading" role="status"><h3>正在读取文献与批次…</h3><p>切换完成后显示当前课题的记录。</p></div>';return;}
  renderBatchSummary();
  const old=$('tagFilter').value;
  $('tagFilter').innerHTML='<option value="">全部主题</option>'+[...new Set(state.papers.flatMap(tags))].map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');$('tagFilter').value=old;
  const q=$('search').value.toLocaleLowerCase().trim(),tag=$('tagFilter').value,date=$('dateFilter').value,priority=$('priorityFilter').value,status=$('statusFilter').value;
  const job=selectedBatch(),latest=job?.id || state.papers[0]?.batch_id,ids=paperIdsForBatch(job);
  $('batchSelect').innerHTML=state.jobs.map((j,i)=>`<option value="${esc(j.id)}">${i===0?'最近 · ':''}${esc(dateLabel(j.created_at))} · ${summarizeBatch(j).complete}/${j.requested} 篇</option>`).join('');$('batchSelect').value=job?.id||'';
  $('batchSelect').hidden=state.demo||state.view!=='latest'||!state.jobs.length;
  let list=state.papers.filter(p=>{
    const a=p.analysis;
    return (state.view!=='latest'||p.batch_id===latest||ids.has(p.id))&&(!q||JSON.stringify([p.title,p.doi,a.summary,a.actions,tags(p)]).toLocaleLowerCase().includes(q))&&(!tag||tags(p).includes(tag))&&(!date||a.analyzed_date===date)&&(!priority||a.actions?.some(x=>x.priority===priority))&&(!status||(status==='verified')===!!a.verified);
  });
  list.sort((a,b)=>(b.analysis.analyzed_date||'').localeCompare(a.analysis.analyzed_date||''));
  $('resultCount').textContent=`显示 ${list.length} / ${state.papers.length} ${state.demo?'条示例':'篇已登记文献'}${state.view==='latest'?' · 所选批次':''}`;
  let empty=state.papers.length?'筛选条件下没有文献':'尚无完成全部核验的文献';
  let detail=state.papers.length?'可清空筛选或查看全部文献，已有记录仍保存在课题库中。':job?'批次结束不等于完成精读。请在下方查看候选题录、分析草稿和缺额原因。':'创建课题、确认研究范围，然后启动第一批检索。';
  $('cards').innerHTML=list.map(p=>paperCard(p)).join('')||`<div class="empty"><h3>${empty}</h3><p>${detail}</p><div class="empty-actions">${state.papers.length?'<button class="outline" data-clear>清空筛选</button><button class="outline" data-all>查看全部文献</button>':job?'<button class="outline" data-show-candidates>查看候选与草稿 ↓</button>':'<button class="primary" data-first-batch>创建课题并开始</button>'}</div></div>`;
  $('cards').querySelectorAll('[data-paper]').forEach(b=>b.onclick=()=>showPaper(b.dataset.paper));
  $('cards').querySelector('[data-clear]')?.addEventListener('click',clearFilters);
  $('cards').querySelector('[data-all]')?.addEventListener('click',()=>{switchView('all');renderPapers();});
  $('cards').querySelector('[data-first-batch]')?.addEventListener('click',batchForm);
  renderCandidates();bindResultActions($('cards'));
}
function clearFilters(){resetFilters();renderPapers();}
function renderCandidates(){
  const job=selectedBatch(),panel=$('candidatePanel');panel.hidden=state.demo||!job;if(panel.hidden)return;
  const candidates=job.checkpoint?.candidates||[];
  const query=$('search').value;
  const order={unverified:0,no_fulltext:1,pending:2,completed:3,duplicate:4,reused:5,excluded:6};
  const matches=candidates.map((item,index)=>({item,index})).filter(({item})=>candidateMatches(item,state.candidateFilter,query)).sort((a,b)=>(order[a.item.status]??9)-(order[b.item.status]??9)||a.index-b.index);
  const s=summarizeBatch(job);
  panel.innerHTML=`<div class="section-bar"><div><p class="eyebrow">CANDIDATES & DRAFTS · 未计入完整精读</p><h2>候选文献与分析草稿</h2></div>${badge(`${s.missingFulltext+s.unverified+s.pending} 项待处理`,'warning')}</div><p>候选保留检索题录与筛选理由。草稿可供继续阅读，但其结论、原图和研究建议仍需核验。</p><div class="candidate-toolbar"><label>候选状态 <select id="candidateStatus" aria-label="筛选候选状态"><option value="needs">待补证据与草稿</option><option value="no_fulltext">待补全文</option><option value="unverified">未核验草稿</option><option value="excluded">已排除</option><option value="all">全部候选</option></select></label><span>显示 ${Math.min(matches.length,state.candidateLimit)} / ${matches.length} 条 · 本批共 ${candidates.length} 条</span></div><div class="candidate-list">${matches.slice(0,state.candidateLimit).map(({item,index})=>candidateCard(job,item,index)).join('')||`<div class="empty"><h3>${candidates.length?'没有符合条件的候选':'本批尚未获得候选'}</h3><p>${candidates.length?'可以切换候选状态或清空上方搜索词。':s.active?'接口预检后开始检索，进度会自动更新。':'请查看批次记录中的错误或检索源状态，并检查研究范围。'}</p></div>`}</div>${matches.length>state.candidateLimit?'<button class="outline" id="moreCandidates">再显示 12 条候选</button>':''}`;
  $('candidateStatus').value=state.candidateFilter;$('candidateStatus').onchange=()=>{state.candidateFilter=$('candidateStatus').value;state.candidateLimit=12;renderCandidates();};
  $('moreCandidates')?.addEventListener('click',()=>{state.candidateLimit+=12;renderCandidates();});
  bindResultActions(panel);bindUploads(panel);
}
function candidateCard(job,item,index){
  const reason=item.reason||item.relevance_reason||(item.status==='pending'?'尚未进入阅读阶段':'暂无进一步说明');
  return `<article class="candidate-result"><div class="candidate-meta">${candidateStatus(item)}<span>${esc(item.source||'来源未记录')} · ${esc(item.year||'年份未知')} · ${item.publication_status==='published'?'正式发表':item.publication_status==='preprint'?'预印本':'发表状态待确认'}</span></div><h3 class="candidate-title"><button class="title-button" data-job="${esc(job.id)}" data-candidate="${index}">${esc(item.title||'未命名候选')}</button></h3><p class="candidate-meta">${esc((item.authors||[]).slice(0,4).join(' · '))}${item.journal?' · '+esc(item.journal):''}</p><p class="candidate-reason">${esc(reason)}</p>${item.fulltext_uploaded?`<div class="upload-feedback">已保存全文：${esc(item.uploaded_filename||'补充 PDF')} · ${esc(dateLabel(item.fulltext_uploaded_at))}。恢复整个批次后核对身份并分析。</div>`:''}<div class="candidate-actions"><button class="outline" data-job="${esc(job.id)}" data-candidate="${index}">${item.status==='unverified'?'阅读分析草稿':'查看题录与证据缺口'} →</button>${publicationLink(item)}${!activeStatuses.has(job.status)&&needsEvidence.has(item.status)?`<label class="outline upload-button">${item.fulltext_uploaded?'替换已补传 PDF':'补充全文 PDF'}<input class="sr-only" type="file" accept=".pdf,application/pdf" data-upload-job="${esc(job.id)}" data-index="${index}"></label>`:''}</div></article>`;
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
  const a=p.analysis,priority=a.actions?.[0]?.priority;
  let content=`<p class="summary">${esc(a.summary)}</p>`;
  if(state.view==='evidence') content=(a.evidence||[]).map(e=>`<div class="action-item"><strong>${esc(e.id)} · ${esc(e.claim)}</strong><p>${esc(e.observation)}</p><span class="tag">${esc(e.source_block_ids.join(' · ')||'合成示例 · 无真实来源')}</span></div>`).join('');
  else if(state.view==='actions')content=(a.actions||[]).map(x=>`<details class="action-item"><summary><span class="tag priority">${esc(x.priority)}</span> ${esc(x.title)}</summary><p>假设：${esc(x.hypothesis)}</p><p>方法与对照：${esc(x.method)} ${esc(x.controls)}</p><p>支持方向：${esc(x.supporting)}</p><p>削弱方向：${esc(x.weakening)}</p><p>资源与成果：${esc(x.resources)} ${esc(x.deliverable)}</p><p>样本量与阈值：${esc(x.sample_size_basis)}</p></details>`).join('')||'<p class="summary">证据不足，暂未提出可执行研究行动。</p>';
  else content+=`<div class="mini-flow">${a.flow_steps.slice(0,4).map((x,i)=>`${i?'<b>→</b>':''}<span>${esc(x)}</span>`).join('')}</div><div class="flow-label">分析者绘制 · 流程概览，非原论文图</div>`;
  return `<article class="paper-card"><div class="card-top"><span>${esc(p.id)} · ${p.year?esc(p.year):'SYNTHETIC EXAMPLE'}</span><span class="verified ${a.verified?'':'synthetic'}">${state.demo?'合成示例':a.verified?'已模型核验':'未核验'}</span></div><div class="card-body"><h3><button class="title-button" data-paper="${esc(p.id)}">${esc(p.title)}</button></h3><p class="journal">${esc(p.journal||'发表信息待确认')}${a.analyzed_date?' · '+esc(a.analyzed_date)+' 分析':''}</p><div class="tags">${tags(p).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}${priority?`<span class="tag priority">${esc(priority)} 优先级</span>`:''}</div>${content}</div><div class="card-bottom"><span>${state.demo?'不对应真实论文':p.publication_status==='published'?'正式发表':p.publication_status==='preprint'?'预印本':'发表状态待确认'}</span><button data-paper="${esc(p.id)}">进入精读与研究规划 ↗</button></div></article>`;
}
function section(title,content,id){return `<section class="reader-section"${id?` id="reading-${id}"`:''}><h2>${title}</h2>${content}</section>`;}
function para(value){return `<p>${esc(value||'尚未记录')}</p>`;}
function bullet(values){return `<ul>${(Array.isArray(values)?values:values?[values]:[]).map(x=>`<li>${esc(typeof x==='object'?JSON.stringify(x):x)}</li>`).join('')}</ul>`;}
function visualContent(a,artifacts){
  const described=new Set((a.visuals||[]).map(v=>Number(v.page)));
  const checked=new Set(artifacts?.checked_visual_pages||[]);
  return (a.visuals||[]).map(v=>`<h3>${esc(v.label)}</h3><figure><img data-asset="page-${Number(v.page)}.png" alt="PDF 第 ${Number(v.page)} 页原图"><figcaption>原论文 PDF 第 ${Number(v.page)} 页 · 点击放大</figcaption></figure>${para(v.explanation)}${para('核验边界：'+(v.limitations||'尚待核对'))}`).join('')+((artifacts?.image_pages||[]).filter(page=>!described.has(page)).map(page=>`<details><summary>PDF 第 ${Number(page)} 页原页 · ${checked.has(page)?'已保存页面核验记录':'已获取，尚未核验'}</summary><figure><img data-asset="page-${Number(page)}.png" alt="PDF 第 ${Number(page)} 页原页"><figcaption>实际获取的 PDF 页面，不表示存在编号图表。页面核验与全篇结论复核分别记录。</figcaption></figure></details>`).join(''))||para('尚无已实际核验的原图记录。取得图片不代表已核验。');
}
function readingBody(p,{draft=false,notes=[],notice='',artifacts=null}={}){
  const a=p.analysis||{},parts=[];
  parts.push(['summary','总结与问题',para(a.summary)+`<h3>科学问题</h3>`+para(a.scientific_question)]);
  if(a.flow_steps?.length)parts.push(['flow','研究流程',`<p class="reader-meta">分析者绘制 · 研究流程示意，非原论文图</p><img data-asset="research-flow.svg" alt="分析者绘制的研究流程">`]);
  parts.push(['design','研究设计',`<dl>${[['variables','变量'],['samples','样本'],['equipment','设备'],['parameters','参数'],['controls','对照'],['repeats','独立重复'],['statistics','统计设计']].map(([key,label])=>`<dt>${label}</dt><dd>${esc(a[key]||'尚未重建；不推定为原文未报告')}</dd>`).join('')}</dl>`]);
  parts.push(['evidence','证据与结论','<h3>作者结论</h3>'+para(a.author_conclusions)+'<h3>分析者推断</h3>'+para(a.analyst_inference)+(a.evidence||[]).map(e=>`<div class="evidence-block"><h3>${esc(e.id)} · ${esc(e.claim)}</h3>${para(e.observation)}<p class="reader-meta">来源：${esc((e.source_block_ids||[]).join(' · ')||'尚无定位')}</p>${para(e.interpretation)}${para('局限：'+(e.limits||'尚待核对'))}</div>`).join('')]);
  parts.push(['visuals','原图与公式',visualContent(a,artifacts)]);
  parts.push(['reading','精读清单',bullet(a.reading_list)||para('尚未生成精读清单')]);
  parts.push(['future','未来研究启示',para(a.future_insights)+`<h3>迁移条件</h3>`+para(a.transfer_conditions)+`<h3>复现检查清单</h3>`+bullet(a.reproduction_checklist)]);
  parts.push(['actions','下一步行动',(a.actions||[]).map(x=>`<h3><span class="tag priority">${esc(x.priority)}</span> ${esc(x.id)} ${esc(x.title)}</h3><p class="reader-meta">待执行方案 · 依据证据：${esc((x.evidence_ids||[]).join(' · '))}</p><dl>${[['gap','证据缺口'],['hypothesis','假设'],['method','方法'],['controls','对照'],['supporting','支持方向'],['weakening','削弱方向'],['resources','资源条件'],['sample_size_basis','样本量依据'],['deliverable','交付成果']].map(([key,label])=>`<dt>${label}</dt><dd>${esc(x[key]||'尚未记录')}</dd>`).join('')}</dl>`).join('')+para(a.roadmap||a.action_status||'尚无可执行研究行动，需先补齐证据。')]);
  const gaps=[...new Set([...(a.verification_gaps||[]),...(a.unread||[])])];
  parts.push(['sources','来源与核验边界',bullet(a.sources)+`<h3>未完成与未核验内容</h3>`+(gaps.length?bullet(gaps):para(draft?'完整精读尚未通过，请查看候选的缺口原因。':'未记录额外未读项；仍需独立人工复核。'))+coverageHtml(a.coverage,artifacts)]);
  if(notes.length)parts.push(['notes','分段阅读记录',`<p>以下为已保存的模型阅读记录，保留来源块编号供追溯；不代表全文与全部原图均已完成核验。</p>`+notes.map((row,i)=>`<details${i===0?' open':''}><summary>阅读分段 ${i+1}${row.unread?.length?' · 存在未读项':''}</summary><div class="reading-notes">${esc(row.notes)}</div>${row.unread?.length?'<h3>待补内容</h3>'+bullet(row.unread):''}</details>`).join('')]);
  const nav=parts.map(([id,title])=>`<a href="#reading-${id}">${esc(title)}</a>`).join('');
  return `<article class="reader"><div class="candidate-meta">${badge(draft?'分析草稿 · 未核验':state.demo?'合成演示':p.id,draft?'warning':'neutral')}<span>${esc(p.year||'年份未记录')} · ${esc(p.journal||'刊物信息未记录')}</span></div><h2>${esc(p.title)}</h2><p class="reader-meta">${esc((p.authors||[]).join(' · '))}<br>${esc(p.doi||'DOI 未记录')}</p>${draft?`<div class="reader-callout warning"><strong>这是未完成核验的临时分析，不计入完整精读。</strong><p>${esc(notice||a.verification_status)}</p>${bullet(a.verification_gaps)}</div>`:state.demo?'<div class="reader-callout">合成示例，没有真实论文、数据或核验结论。</div>':`<div class="reader-callout">${esc(a.verification_status||'核验范围尚未记录')}<p>模型核验不等于独立人工复核，研究行动均为待执行方案。</p></div>`}${a.transfer_notice?`<div class="reader-callout">${esc(a.transfer_notice)}</div>`:''}<div class="candidate-actions">${publicationLink(p)}${draft?'<button class="outline" id="exportCandidate">导出候选与草稿 JSON</button>':''}${artifacts?.pdf_available?'<button class="outline" id="openCandidatePdf">下载已获取的全文 PDF</button>':''}${artifacts?.source_available?'<button class="outline" id="openCandidateSource">查看正文来源定位</button>':''}</div><div class="reader-layout"><nav class="reader-toc" aria-label="阅读目录"><strong>阅读目录</strong>${nav}</nav><div class="reader-content">${parts.map(([id,title,content])=>section(title,content,id)).join('')}<div id="candidateSource"></div>${!state.demo?`<p class="watermark">${esc(watermark)}</p>`:''}</div></div></article>`;
}
function coverageHtml(coverage,artifacts){
  const c=coverage||{};
  return `<dl><dt>正文来源块</dt><dd>${esc(c.text_blocks_read??'未记录')}</dd><dt>PDF 页数</dt><dd>${esc(c.pdf_pages??'未记录')}</dd><dt>已获取原图页</dt><dd>${esc(artifacts?.image_pages?.join('、')||'详见原图记录')}</dd><dt>已实际核验页</dt><dd>${esc((artifacts?.checked_visual_pages||c.visual_pages_checked||[]).join('、')||'未记录')}</dd><dt>阅读范围</dt><dd>${esc(c.scope||'以已保存阅读记录为准；未推定覆盖全部材料')}</dd></dl>`;
}
function renderMath(){if(window.temml)window.temml.renderMathInElement($('modalBody'),{delimiters:[{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'\\(',right:'\\)',display:false}],throwOnError:false,trust:false});}
async function loadReaderAssets(base){
  for(const el of $('modalBody').querySelectorAll('[data-asset]')){
    try{const blob=await api(`${base}/${el.dataset.asset}`,{binary:true});if(!el.isConnected)continue;const url=URL.createObjectURL(blob);state.urls.push(url);el.src=url;el.onclick=()=>window.open(url,'_blank','noopener');}
    catch{if(el.isConnected){el.alt='原图暂不可用。请通过全文 PDF 核对，不能以文字说明代替原图核验。';el.classList.add('asset-missing');}}
  }
}
async function showPaper(id){
  const p=state.papers.find(p=>p.id===id);if(!p)return;
  showModal('READING ROOM · 论文与研究行动',readingBody(p),true);renderMath();
  if(state.demo){const flow=$('modalBody').querySelector('[data-asset]');if(flow){const list=document.createElement('ol');for(const step of p.analysis.flow_steps||[]){const li=document.createElement('li');li.textContent=step;list.append(li);}flow.replaceWith(list);}}
  else await loadReaderAssets(`/api/papers/${Number(p.id.slice(1))}/assets`);
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
    let body=p.analysis?readingBody(p,opts):`<article class="reader">${candidateStatus(p)}<h2>${esc(p.title)}</h2><p class="reader-meta">${esc((p.authors||[]).join(' · '))}<br>${esc(p.journal||'刊物信息未记录')} · ${esc(p.year||'年份未记录')}</p><div class="reader-callout warning"><strong>当前只有候选题录，尚未完成精读。</strong><p>${esc(p.reason||p.relevance_reason||detail.notice)}</p></div><div class="candidate-actions">${publicationLink(p)}<button class="outline" id="exportCandidate">导出候选 JSON</button>${detail.artifacts?.pdf_available?'<button class="outline" id="openCandidatePdf">下载已获取的全文 PDF</button>':''}${detail.artifacts?.source_available?'<button class="outline" id="openCandidateSource">查看正文来源定位</button>':''}</div>${section('题录摘要 · 尚未全文核验',para(p.abstract||'检索源未提供摘要。请获取全文后核对内容。'))}${detail.reading_notes?.length?section('已保存的分段阅读记录',detail.reading_notes.map(row=>`<div class="reading-notes">${esc(row.notes)}</div>${bullet(row.unread)}`).join('')):''}<div id="candidateSource"></div></article>`;
    const job=state.jobs.find(j=>j.id===jid);
    if(job&&!activeStatuses.has(job.status)&&needsEvidence.has(p.status))body+=`<div class="form-actions"><label class="outline upload-button">补充全文 PDF<input class="sr-only" type="file" accept=".pdf,application/pdf" data-upload-job="${esc(jid)}" data-index="${index}"></label><button class="primary" data-retry="${esc(jid)}">继续整个批次</button></div><p class="reader-meta">恢复分析将使用当前模型设置并产生 API 用量；已登记记录不会重复新增。</p>`;
    showModal('CANDIDATE READING · 候选与分析草稿',body,true);renderMath();bindResultActions($('modalBody'));bindUploads($('modalBody'));
    $('exportCandidate')?.addEventListener('click',()=>download(new Blob([JSON.stringify(detail,null,2)],{type:'application/json'}),`candidate-${index+1}-unverified.json`));
    $('openCandidatePdf')?.addEventListener('click',busy(async()=>{const blob=await api(base+'/pdf',{binary:true});download(blob,`candidate-${index+1}.pdf`);}));
    $('openCandidateSource')?.addEventListener('click',busy(async()=>{const el=$('candidateSource'),version=state.modalVersion;const source=await api(base+'/source');if(!el?.isConnected||version!==state.modalVersion)return;el.innerHTML=section('正文来源定位',`<p>${esc(source.notice||'来源定位不表示科学结论已核验')}</p>`+(source.blocks||[]).map(block=>`<details><summary>${esc(block.id)} · PDF 第 ${esc(block.page)} 页</summary><div class="reading-notes">${esc(block.text)}</div></details>`).join(''),'source-blocks');el.scrollIntoView({behavior:'smooth',block:'start'});}));
    if(p.analysis)await loadReaderAssets(base+'/assets');
  }catch(error){if(version===state.modalVersion&&$('modal').open){$('modalBody').innerHTML=`<div class="empty"><h2>暂时无法读取记录</h2><p>${esc(error.message)}</p><p>请刷新研究空间后重试；已保存资料仍在后端。</p></div>`;}}
}


function connectionForm({continueToBatch=false,onConnected=null}={}){
  const localBase=['localhost','127.0.0.1'].includes(location.hostname)?location.origin:'';
  showModal('CONNECT · 连接私人研究空间',`<h2>连接你的私人后台</h2><p>后台保存课题与论文，模型 API 负责分析。此处填写后台地址和管理员口令。</p><form id="connectForm">${field('私人后台地址','backendUrl',state.base||localBase,'url','本机模式通常就是当前网页地址；线上模式使用部署者提供的 HTTPS 地址。')}${field('后台管理员口令','adminPassword','','password','这是后台独立口令，不是 GitHub、模型 API 密钥或网页账号密码。')}<p class="form-message" id="formMessage" role="status"></p><div class="form-actions"><button type="button" class="quiet" id="keepDemo">继续示例演示</button><button class="primary" type="submit">连接并继续 →</button></div></form>`);
  const current=modalContext();$('keepDemo').onclick=()=>{closeModal();enterDemo();};
  const submit=busy(async()=>{
    const url=new URL($('backendUrl').value.trim());if(url.username||url.password||url.search||url.hash)throw new Error('后台地址不能包含凭据、查询参数或片段。');
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('线上后台必须使用 HTTPS。');
    const base=url.href.replace(/\/$/,'');
    const response=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:jsonBody({password:$('adminPassword').value})});
    const data=await response.json();if(!response.ok)throw new Error(apiErrorMessage(data.detail,response.status));if(!current())return;
    state.base=base;state.token=data.token;sessionStorage.setItem('pw-token',state.token);localStorage.setItem('pw-base',base);
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
    const [papers,jobs]=await Promise.all([api(`/api/projects/${projectId}/papers`),api(`/api/projects/${projectId}/jobs`)]);
    if(state.demo||state.project?.id!==projectId||revision!==state.loadRevision)return;
    state.papers=papers;state.jobs=jobs;localStorage.setItem('pw-project',projectId);
  }else{state.papers=[];state.jobs=[];}
  render();
}
function enterDemo(){state.workspaceRevision=(state.workspaceRevision||0)+1;state.loadRevision=(state.loadRevision||0)+1;state.selectionRevision=(state.selectionRevision||0)+1;clearInterval(state.poll);state.demo=true;state.offline='';state.connecting=false;state.projectLoading=false;state.projects=[demoProject];state.project=demoProject;state.papers=demoPapers;state.jobs=[];state.activeJob=null;resetFilters();state.nav='home';render();}
function requireService(){if(state.demo||state.offline||state.connecting){connectionForm();return false;}return true;}
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
    }catch(e){if(current()){clearInterval(state.poll);state.offline=state.token?'后台连接中断：'+e.message:'登录已过期，请重新连接服务';render();}}
    finally{state.pollBusy=false;}
  },5000);
}

function newProjectForm({continueToBatch=true}={}){
  if(state.demo||state.offline||state.connecting){connectionForm({onConnected:()=>newProjectForm({continueToBatch})});return;}
  showModal('NEW PROJECT · 建立研究课题',flowProgress(0)+`<h2>先确定你要研究什么</h2><p>输入名称即可创建。参考 PDF 可稍后补充，用于界定范围，不占精读篇数。</p><form id="projectForm">${field('课题名称（必填）','projectName')}${area('研究目标与已有条件（可选）','projectGoal')}<label class="field">参考 PDF（可选）<input id="referencePdf" type="file" accept="application/pdf,.pdf"><small>单份不超过 50 MB、300 页；扫描或加密文件可能无法读取。</small></label><p class="form-message" id="formMessage" role="status"></p><div class="form-actions"><button class="quiet" id="skipReference" type="button" hidden>跳过参考 PDF，确认范围</button><button class="primary" id="createSubmit" type="submit">创建并确认研究范围 →</button></div></form>`);
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
      try{const data=new FormData();data.append('file',file);await api(`/api/projects/${created.id}/references`,{method:'POST',body:data});}
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
  showModal('RESEARCH SCOPE · 确认研究范围',(continueToBatch?flowProgress(1):'')+`<h2>${esc(project.name)}</h2><div class="config-status">${scope.inferred?'当前范围由名称推定，请检查后保存。':'当前范围已确认，可继续修改。'}手动编辑不消耗模型 API。</div>${area('科学问题','scopeQuestion',scope.research_question)}${field('检索关键词（逗号分隔）','scopeKeywords',(scope.keywords||[]).join(', '))}${area('纳入范围','scopeInclude',scope.include)}${area('排除范围','scopeExclude',scope.exclude)}<details><summary>参考资料 · 查看或补充 PDF</summary><div id="referenceList" role="status">正在读取资料列表…</div><label class="field">添加范围参考 PDF<input id="scopeReference" type="file" accept="application/pdf,.pdf"><small>不占精读额度；资料中的文字只作为研究数据处理。</small></label><button class="outline" id="uploadReference">保存参考 PDF</button><p id="referenceFeedback" class="upload-feedback" hidden></p></details><p class="form-message" id="formMessage" role="status"></p><p class="reader-meta">「使用模型提取」会发送课题与参考资料给当前 API，产生用量。提取后仍需你确认范围。</p><div class="form-actions"><button class="outline" id="inferScope" ${configurationComplete(state.settings)?'':'disabled'}>使用模型提取范围</button><button class="primary" id="saveScope">${continueToBatch?'保存范围并继续 →':'保存研究范围'}</button></div>${!configurationComplete(state.settings)?'<p class="reader-meta">模型尚未配置。可先手动保存范围，再继续配置模型。</p>':''}`);
  const current=modalContext();
  async function refreshReferences(){try{const refs=await api(`/api/projects/${projectId}/references`);if(!current())return;$('referenceList').innerHTML=refs.length?`<ul>${refs.map(r=>`<li>${esc(r.filename)} · ${Number(r.pages)} 页</li>`).join('')}</ul>`:'<p>尚未上传参考资料，可以仅依据课题名称运行。</p>';}catch(error){if(current())$('referenceList').textContent='资料列表读取失败：'+error.message;}}
  refreshReferences();
  $('uploadReference').onclick=busy(async()=>{
    const file=$('scopeReference').files[0];if(!file)throw new Error('先选择参考 PDF。');if(file.size>50*1024*1024)throw new Error('PDF 超过 50 MB。');
    const data=new FormData();data.append('file',file);await api(`/api/projects/${projectId}/references`,{method:'POST',body:data});if(!current())return;
    $('scopeReference').value='';$('referenceFeedback').hidden=false;$('referenceFeedback').textContent='参考 PDF 已保存。新资料不会自动改写当前范围，请编辑或提取后确认保存。';await refreshReferences();
  },'正在保存 PDF…');
  $('inferScope').onclick=busy(async()=>{
    $('formMessage').textContent='正在读取已保存的参考资料并提取范围…';
    const result=await api(`/api/projects/${projectId}/infer-scope`,{method:'POST'});if(!current())return;
    $('scopeQuestion').value=result.research_question;$('scopeKeywords').value=(result.keywords||[]).join(', ');$('scopeInclude').value=result.include;$('scopeExclude').value=result.exclude;
    $('formMessage').textContent='推定范围已填入，尚未保存。请检查后点击保存。';
  },'正在提取研究范围…');
  $('saveScope').onclick=busy(async()=>{
    const value={research_question:$('scopeQuestion').value.trim(),keywords:$('scopeKeywords').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean),include:$('scopeInclude').value.trim(),exclude:$('scopeExclude').value.trim(),inferred:false};
    if(!value.research_question&&!value.keywords.length)throw new Error('请至少填写科学问题或一个检索关键词。');
    const saved=await api(`/api/projects/${projectId}/scope`,{method:'PUT',body:jsonBody(value)});
    state.projects=state.projects.map(p=>p.id===projectId?saved:p);if(state.project?.id===projectId)state.project=saved;
    if(!current())return;render();if(continueToBatch)batchForm();else{closeModal();toast('研究范围已保存。');}
  },'正在保存范围…');
}

function settingsForm({continueToBatch=false,onComplete=null}={}){
  if(!requireService())return;const cfg=state.settings;
  const preset=apiOrigin(cfg.base_url)==='https://api.deepseek.com'?'deepseek':apiOrigin(cfg.base_url)==='https://api.openai.com'?'openai':'custom';
  showModal('SETTINGS · 模型与检索配置',(continueToBatch?flowProgress(2):'')+`<h2>选择模型服务，保存后再运行</h2><p>这里配置的是模型 API；你的私人后台地址是 ${esc(state.base)}。两者用途不同。</p><label class="field provider-preset">服务地址快捷填写<select id="providerPreset"><option value="custom">自定义 / 保留现有地址</option><option value="deepseek">DeepSeek 官方地址</option><option value="openai">OpenAI 官方地址</option></select><small>快捷项只填写地址，不自动选择模型或开通计费。</small></label>${field('API 基础地址','modelBase',cfg.base_url||'','url','填写供应商提供的 HTTPS 基础地址；程序会添加 /chat/completions。')}${field('当前供应商的模型 API 密钥','apiKey','','password',cfg.has_api_key?'原服务已存密钥；同一服务留空保留，更换服务需重填。':'从当前供应商控制台复制；不要填写网页登录密码。')}${field('文本模型名称（必填）','textModel',cfg.text_model||'','text','复制供应商模型列表中的准确名称。')}<label class="field"><span><input id="sameModel" type="checkbox" ${!cfg.vision_model||cfg.vision_model===cfg.text_model?'checked':''}> 视觉核验使用同一个模型</span><small>只有该模型支持图片输入时才能使用；否则单独填写视觉模型。</small></label>${field('视觉模型名称（必填）','visionModel',cfg.vision_model||cfg.text_model||'','text','用于实际读取论文原页，不能用纯文本模型假称原图已核验。')}<details><summary>检索源设置（可选）</summary>${field('OpenAlex API 密钥','alexKey','','password',cfg.has_openalex_key?'已配置；留空保留。':'未配置时仅使用 Crossref。')}</details><div class="config-status" id="configStatus" role="status"></div><div class="model-check-status" id="checkStatus"></div><p class="form-message" id="formMessage" role="status"></p><p class="reader-meta">接口检查会实际调用文本和视觉模型，可能产生少量 API 费用。保存配置本身不调用模型。</p><div class="form-actions"><button class="outline" id="saveSettings">仅保存配置</button><button class="outline" id="checkSetup">保存并检查接口</button><button class="primary" id="continueSettings">${continueToBatch||onComplete?'保存并进入运行确认 →':'保存并返回工作台'}</button></div>`);
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
  if(state.demo||state.offline){connectionForm({continueToBatch:true});return;}
  if(state.activeJob){openActiveJob().catch(modalError);return;}
  if(!state.project){newProjectForm({continueToBatch:true});return;}
  if(!scopeConfirmed(state.project)){scopeForm({continueToBatch:true});return;}
  if(!configurationComplete(state.settings)){settingsForm({continueToBatch:true});return;}
  const project=state.project,scope=project.scope;
  showModal('NEW BATCH · 运行前确认',flowProgress(3)+`<h2>确认后开始检索与分析</h2><p>${esc(project.name)}</p><div class="callout"><strong>本批研究范围</strong><br>${esc(scope.research_question)}<br>关键词：${esc((scope.keywords||[]).join(' · '))}<br>纳入：${esc(scope.include)}<br>排除：${esc(scope.exclude)}</div><label class="field">本批目标数量<input id="batchCount" type="number" min="1" max="20" value="5"><small>允许 1–20；可靠新文献不足时报告缺额，不凑数。</small></label><p>文本模型：${esc(state.settings.text_model)}<br>视觉模型：${esc(state.settings.vision_model)}</p><div class="config-status">${state.settings.preflight?.ready?'当前配置已有通过的接口检查记录；任务仍会在运行时确认可用性。':'当前配置已保存，任务启动后先进行文本与视觉能力预检。'}</div><div class="callout">启动会产生模型 API 用量。课题范围、候选题录、论文正文与原页会发送给当前模型服务。资料保存在私人后端，关闭网页后任务继续。</div><p class="form-message" id="formMessage" role="status"></p><div class="form-actions"><button class="outline" id="adjustScope">修改范围</button><button class="outline" id="adjustModels">修改模型</button><button class="primary" id="submitBatch">确认并开始分析 →</button></div>`);
  const current=modalContext();$('adjustScope').onclick=()=>scopeForm({continueToBatch:true});$('adjustModels').onclick=()=>settingsForm({continueToBatch:true});
  $('submitBatch').onclick=busy(async()=>{
    const count=Number($('batchCount').value);if(!Number.isInteger(count)||count<1||count>20)throw new Error('数量应为 1–20 的整数。');
    const job=await api(`/api/projects/${project.id}/jobs`,{method:'POST',body:jsonBody({count})});state.activeJob={id:job.id,project_id:project.id,status:'queued',stage:'等待执行'};
    if(!current())return;closeModal();state.nav='jobs';await loadProject();toast('任务已提交，正在后台执行。');
  },'正在提交任务…');
}

async function retryForm(jid){
  if(!requireService())return;if(state.activeJob){await openActiveJob();return;}
  const job=state.jobs.find(j=>j.id===jid)||await api(`/api/jobs/${jid}`),summary=summarizeBatch(job),scope=job.checkpoint?.scope_snapshot||{};
  showModal('RESUME · 继续整个批次',`<h2>确认恢复整个批次</h2><p>此操作处理本批仍缺证据的候选，不是只分析当前打开的这一篇。</p><div class="retry-summary"><div class="retry-metrics"><span>原目标 ${summary.target} 篇</span><span>已完成 ${summary.complete} 篇</span><span>待补全文 ${summary.missingFulltext} 篇</span><span>未核验 ${summary.unverified} 篇</span></div><strong>沿用原批次研究范围</strong><p>${esc(scope.research_question||'范围未记录，请先核对批次来源')}</p><p>${esc((scope.keywords||[]).join(' · '))}</p></div><p>使用当前保存的文本模型 ${esc(state.settings.text_model||'未配置')} 与视觉模型 ${esc(state.settings.vision_model||'未配置')}。</p><div class="callout">继续会产生 API 用量。已登记论文保持唯一编号；缺全文和未核验内容仍不计入完整精读。改变当前课题范围不会改写这个批次的原始范围。</div><p class="form-message" id="formMessage" role="status"></p><div class="form-actions"><button class="outline" id="retryCancel">返回结果</button><button class="primary" id="confirmRetry">${configurationComplete(state.settings)?'确认继续整个批次 →':'先配置模型 →'}</button></div>`);
  const current=modalContext();$('retryCancel').onclick=closeModal;
  $('confirmRetry').onclick=busy(async()=>{
    if(!configurationComplete(state.settings)){settingsForm({onComplete:()=>retryForm(jid)});return;}
    await api(`/api/jobs/${jid}/retry`,{method:'POST'});state.activeJob={id:jid,project_id:job.project_id,status:'queued',stage:'等待恢复'};
    if(!current())return;closeModal();state.nav='jobs';await loadProject();toast('整个批次已恢复，原有进度继续保留。');
  },'正在恢复批次…');
}

function renderProjects(){
  const unavailable=state.offline||state.connecting;
  const service=unavailable?`<section class="home-service" role="status"><h2>${state.connecting?'正在连接私人研究空间':'私人服务暂不可用'}</h2><p>${esc(state.offline||'正在读取你的课题列表…')}</p><p>已保存资料仍保留在私人后台。连接恢复后继续打开课题。</p>${state.connecting?'':'<button class="outline" id="homeReconnect">重新连接服务 →</button>'}</section>`:'';
  const cards=state.projects.map(p=>`<article class="project-card"><div class="project-card-top"><span class="project-symbol">⌘</span>${badge(state.demo?'合成示例':'私人课题',state.demo?'warning':'neutral')}</div><h3>${esc(p.name)}</h3><p>${esc(p.goal||'打开课题后确认研究范围，开始整理文献与证据。')}</p><div class="tags">${(p.scope?.keywords||[]).slice(0,5).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div><div class="project-card-bottom"><span>文献 · 批次结果 · 研究行动</span><button class="outline" data-open-project="${esc(p.id)}" ${state.projectLoading||state.connecting?'disabled':''}>${state.projectLoading?'正在读取…':'进入课题 →'}</button></div></article>`).join('');
  $('alternate').innerHTML=service+'<div class="section-bar"><div><p class="eyebrow">PROJECT LIBRARY</p><h2>我的课题</h2><p class="home-caption">每个课题拥有自己的研究范围、文献和分析记录。</p></div></div><div class="project-grid">'+cards+(!unavailable?'<button class="project-create" id="altNew"><span>＋</span><strong>创建研究课题</strong><small>输入课题名称，或上传参考 PDF</small></button>':'')+'</div>'+(!state.projects.length&&!unavailable?'<p class="home-empty">从第一个课题开始。创建后可修改研究范围，再选择要分析的论文篇数。</p>':'');
  $('altNew')?.addEventListener('click',()=>newProjectForm());$('homeReconnect')?.addEventListener('click',()=>connectionForm());$('alternate').querySelectorAll('[data-open-project]').forEach(b=>b.onclick=()=>selectProject(b.dataset.openProject));
}
function renderJobs(){
  if(state.projectLoading){$('alternate').innerHTML='<div class="empty is-loading" role="status"><h3>正在读取课题批次…</h3><p>切换完成后显示所选课题的分析记录。</p></div>';return;}
  $('alternate').innerHTML='<div class="section-bar"><div><p class="eyebrow">ANALYSIS HISTORY</p><h2>分析批次与结果</h2></div><button class="outline" id="refreshJobs">刷新状态</button></div>'+(state.jobs.length?state.jobs.map(job=>{
    const c=job.checkpoint||{},s=summarizeBatch(job),stage=stages.indexOf(job.stage);
    return `<article class="job-card"><div class="job-header"><span class="eyebrow">${esc(dateLabel(job.created_at))} · 批次 ${esc(job.id.slice(0,8))}</span>${badge(s.full?'目标已完成':s.active?'正在执行':job.status==='failed'?'执行中断':'有证据缺口',s.full?'success':s.active?'neutral':job.status==='failed'?'danger':'warning')}</div><h3>${esc(batchOutcome(job))}</h3><div class="stages" aria-label="任务阶段">${stages.map((label,i)=>`<span class="stage ${i===stage?'current':i<stage?'done':''}">${i+1}. ${label}</span>`).join('')}</div><div class="job-counts"><span>目标 <strong>${s.target}</strong> 篇</span><span>新增完整精读 <strong>${s.complete}</strong> 篇</span><span>复用 <strong>${s.reused}</strong> 篇</span><span>待补全文 <strong>${s.missingFulltext}</strong> 篇</span><span>未核验 <strong>${s.unverified}</strong> 篇</span><span>缺额 <strong>${s.shortfall}</strong> 篇</span></div>${job.error?`<p class="error">${esc(job.error)}</p>`:''}${!s.active&&!s.full?'<p class="candidate-reason">本批流程已结束，未达到完整精读目标。候选与分析草稿仍可阅读；补齐材料后可恢复任务。</p>':''}<div class="job-buttons"><button class="primary" data-results="${esc(job.id)}">查看文献、候选与草稿 →</button>${s.active?`<button class="outline" data-cancel="${esc(job.id)}" ${job.cancel_requested?'disabled':''}>${job.cancel_requested?'已请求停止':'取消任务'}</button>`:!s.full?`<button class="outline" data-retry="${esc(job.id)}">继续整个批次</button>`:''}</div><details><summary>检索与筛选记录 · ${s.total} 条候选，${s.excluded} 条已排除</summary><div class="job-diagnostics"><h4>检索源状态</h4>${s.diagnostics.length?bullet(s.diagnostics):para(s.total?'未记录检索源故障。':'暂无来源记录，可能尚未通过接口预检。')}<h4>检索过程</h4><div class="search-log">${(c.search_log||[]).map(log=>`<div><strong>${esc(log.from_year)} 年起</strong><span>${esc(log.query)}</span><span>返回 ${Number(log.found)||0} 条 · 新增候选 ${Number(log.new_candidates)||0} 条</span><small>${esc(dateLabel(log.retrieved_at))}</small></div>`).join('')||'<p>尚未开始检索，或本阶段没有留下记录。</p>'}</div><p>全部题录和逐条筛选理由可在「查看文献、候选与草稿」中按状态筛选。</p></div></details></article>`;
  }).join(''):'<div class="empty"><h3>还没有分析批次</h3><p>先创建或选择课题，确认研究范围，再开始检索与分析。</p><button class="primary" id="firstBatch">开始第一批分析 →</button></div>');
  $('refreshJobs').onclick=busy(async()=>{if(state.demo){toast('示例演示没有真实后台任务');return;}await loadProject();toast('批次状态已更新');});
  $('firstBatch')?.addEventListener('click',batchForm);bindResultActions($('alternate'));
}

function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
$('export').onclick=async()=>{if(!requireService())return;if(!state.project)return;try{const kind=$('exportKind').value;download(await api(`/api/projects/${state.project.id}/export?kind=${kind}`,{binary:true}),kind==='json'?'papers.json':`research-${kind}.zip`);}catch(e){toast(e.message);}};
for(const id of ['search','tagFilter','dateFilter','priorityFilter','statusFilter'])$(id).addEventListener('input',renderPapers);
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{switchView(b.dataset.view);renderPapers();});
document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{if(b.dataset.nav==='home'){goHome();return;}state.nav=b.dataset.nav;render();});
$('projectSelect').onchange=()=>selectProject($('projectSelect').value);
$('connect').onclick=connectionForm;$('settings').onclick=()=>state.demo?connectionForm():settingsForm();$('newProject').onclick=newProjectForm;$('newBatch').onclick=()=>state.nav==='home'?newProjectForm():batchForm();$('editScope').onclick=scopeForm;
$('topSettings').onclick=()=>state.demo?connectionForm():settingsForm();
$('switchProject').onclick=goHome;
$('quickNewProject').onclick=()=>newProjectForm();
$('clearFilters').onclick=clearFilters;
$('batchSelect').onchange=()=>{const selected=$('batchSelect').value;resetFilters();state.batchId=selected;renderPapers();};
$('refreshWorkspace').onclick=busy(async()=>{if(state.demo){render();toast('示例演示已刷新');return;}await loadWorkspace();toast('课题、文献与批次已更新');});
$('logout').onclick=()=>{state.token='';sessionStorage.removeItem('pw-token');enterDemo();toast('已退出私人空间');};
$('help').onclick=()=>showModal('GUIDE · 使用说明','<h2>从课题进入你的研究</h2><p>1. 首页选择「进入课题」，或创建新课题。示例演示无需登录，不消耗 API。</p><p>2. 实际研究先连接私人后台。在课题内确认研究范围，并配置模型接口。</p><p>3. 点击「开始检索与分析」，确认篇数、模型与资料发送范围后运行。</p><p>4. 在该课题的「分析批次与结果」中查看进度；点击「查看文献、候选与草稿」阅读结果。缺全文或未核验的候选不会凑数。</p><p>5. 在「文献与研究行动」中筛选、精读、导出。返回课题首页可打开其他课题。</p><div class="callout">模型核验不是人工复核，也不等于独立复现。研究行动卡是建议方案。</div><p>GitHub Pages 展示网页；私人后台保存资料并运行任务。示例全部为合成内容。</p>');
render();
if(state.base&&state.token){state.demo=false;state.connecting=true;state.projects=[];state.project=null;state.papers=[];state.jobs=[];render();loadWorkspace().catch(error=>{state.connecting=false;state.offline=error.message;render();});}
