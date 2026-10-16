import {demoProject, demoPapers} from './demo.js';
import {activeStatuses, needsEvidence, summarizeBatch, batchOutcome, candidateMatches, paperIdsForBatch} from './results.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = {demo:true,projects:[demoProject],project:demoProject,papers:demoPapers,jobs:[],view:'latest',nav:'library',batchId:'',candidateFilter:'needs',candidateLimit:12,base:localStorage.getItem('pw-base')||'',token:sessionStorage.getItem('pw-token')||'',settings:{},poll:null,urls:[]};
const statusNames = {queued:'等待执行',running:'正在分析',completed:'批次结束',failed:'运行失败',cancelled:'已取消',pending:'待处理',excluded:'已排除',duplicate:'已分析，不计新增',no_fulltext:'待补全文',unverified:'未核验',reused:'复用证据'};
const stages = ['接口预检','检索','去重','获取全文','分析','图表核验','校验','完成'];
const watermark = '分析采用 norman-paper-reading 技能｜作者：N同学｜小红书：N同学｜B站/抖音：耐心的N同学\nAnalysis performed using the norman-paper-reading skill | Author: N同学 | Xiaohongshu: N同学 | Bilibili/Douyin: 耐心的N同学';

function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,5500);}
async function api(path,options={}){
  const headers = {Authorization:`Bearer ${state.token}`,...options.headers};
  if(options.body && !(options.body instanceof FormData)) headers['Content-Type']='application/json';
  const res=await fetch(state.base+path,{...options,headers});
  if(!res.ok){let detail;try{detail=(await res.json()).detail;}catch{detail=`HTTP ${res.status}`;}if(res.status===401){state.token='';sessionStorage.removeItem('pw-token');}throw new Error(apiErrorMessage(detail,res.status));}
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
  if(!state.settings.has_api_key&&!$('apiKey').value.trim()){$('apiKey').focus();throw new Error('请填写模型 API 密钥。');}
  return {base_url:$('modelBase').value.trim(),api_key:$('apiKey').value,text_model:$('textModel').value.trim(),vision_model:$('visionModel').value.trim(),openalex_key:$('alexKey').value};
}
function jsonBody(value){return JSON.stringify(value);}
function showModal(title,body,wide=false){state.modalVersion=(state.modalVersion||0)+1;clearAssets();$('modal').classList.toggle('wide',wide);$('dialogLabel').textContent=title;$('modalBody').innerHTML=body;if(!$('modal').open)$('modal').showModal();}
function clearAssets(){state.urls.forEach(URL.revokeObjectURL);state.urls=[];}
function closeModal(){$('modal').close();clearAssets();}
$('closeModal').onclick=closeModal;
$('modal').addEventListener('close',clearAssets);
function field(label,id,value='',type='text',help=''){return `<label class="field">${esc(label)}<input id="${id}" type="${type}" value="${esc(value)}" ${type==='password'?'autocomplete="new-password"':''}>${help?`<small>${esc(help)}</small>`:''}</label>`;}
function area(label,id,value=''){return `<label class="field">${esc(label)}<textarea id="${id}">${esc(value)}</textarea></label>`;}
function modalError(error){const el=$('formMessage');if(el){el.textContent=error.message;el.className='error';}else toast(error.message);}
function busy(handler){return async event=>{const button=event.currentTarget;button.disabled=true;try{await handler(event);}catch(e){modalError(e);}finally{button.disabled=false;}};}

function connection(){
  $('demoNotice').hidden=!state.demo;$('modePill').textContent=state.demo?'DEMO · 合成数据':'PRIVATE · 私人课题库';$('modePill').classList.toggle('live',!state.demo);$('connectionDot').classList.toggle('live',!state.demo);$('connectionLabel').textContent=state.demo?'独立示例演示':'已连接私人服务';$('logout').hidden=state.demo;
}
function dateLabel(value){const date=new Date(value);return Number.isNaN(date.valueOf())?'时间未记录':date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
function selectedBatch(){return state.jobs.find(job=>job.id===state.batchId)||state.jobs[0];}
function badge(label,tone='neutral'){return `<span class="status-badge ${tone}">${esc(label)}</span>`;}
function candidateStatus(item){return badge(({completed:'已登记精读',excluded:'相关性不足，已排除',duplicate:'已有记录',no_fulltext:'待补全文',unverified:'草稿 · 未核验',pending:'等待处理',reused:'复用已有证据'})[item.status]||item.status,item.status==='completed'?'success':needsEvidence.has(item.status)?'warning':'neutral');}
function safeLink(value,label){try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return '';return `<a class="outline" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;}catch{return '';}}
function publicationLink(p){return safeLink(p.doi?'https://doi.org/'+encodeURI(p.doi):p.url,'出版社 / DOI');}
function switchView(view){state.view=view;document.querySelectorAll('[data-view]').forEach(tab=>{tab.classList.toggle('active',tab.dataset.view===view);tab.setAttribute('aria-selected',String(tab.dataset.view===view));});}
function showBatchResults(id){state.batchId=id||'';state.nav='library';state.candidateLimit=12;switchView('latest');render();$('batchSummary').scrollIntoView({behavior:'smooth',block:'start'});}
function renderBatchSummary(){
  const job=selectedBatch(),el=$('batchSummary');el.hidden=state.demo||!job;if(el.hidden)return;
  const s=summarizeBatch(job);
  const explanation=s.active?'后台正在执行。刷新或关闭网页不会停止任务，已保存的结果会自动更新。':s.full?'已登记的论文可以从下方文献卡进入阅读，或切换到精读证据与研究行动。':`${s.missingFulltext} 篇待补全文，${s.unverified} 篇未完成核验，${s.excluded} 条相关性不足已排除。候选与草稿在下方保留，不计入完整精读。`;
  el.innerHTML=`<div class="summary-head"><div><p class="eyebrow">BATCH RESULTS · ${esc(dateLabel(job.created_at))}</p><h2>${esc(batchOutcome(job))}</h2></div>${badge(s.full?'达到本批目标':s.active?job.stage:'进度已保存',s.full?'success':s.active?'neutral':'warning')}</div><p>${esc(explanation)}</p><div class="summary-metrics">${[[s.target,'目标篇数'],[s.complete,'新增完整精读'],[s.total,'候选记录'],[s.shortfall,s.active?'距目标':'精读缺额']].map(([n,label])=>`<div><strong class="metric-value">${n}</strong><span class="metric-label">${label}</span></div>`).join('')}</div>${job.error?`<p class="error">${esc(job.error)}</p>`:''}<div class="summary-actions"><button class="outline" data-jobs>查看批次与检索记录</button>${s.missingFulltext+s.unverified+s.pending?'<button class="primary" data-show-candidates>查看候选与分析草稿 ↓</button>':''}${!s.active&&(!s.full||job.status!=='completed')?`<button class="outline" data-retry="${esc(job.id)}">从检查点继续</button>`:''}</div>`;
  bindResultActions(el);
}
function bindResultActions(root){
  root.querySelectorAll('[data-jobs]').forEach(button=>button.onclick=()=>{state.nav='jobs';render();});
  root.querySelectorAll('[data-show-candidates]').forEach(button=>button.onclick=()=>{$('candidatePanel').scrollIntoView({behavior:'smooth',block:'start'});});
  root.querySelectorAll('[data-results]').forEach(button=>button.onclick=()=>showBatchResults(button.dataset.results));
  root.querySelectorAll('[data-retry],[data-cancel]').forEach(button=>button.onclick=busy(async()=>{await api(`/api/jobs/${button.dataset.cancel||button.dataset.retry}/${button.dataset.cancel?'cancel':'retry'}`,{method:'POST'});if($('modal').open&&$('modalBody').contains(button))closeModal();await loadProject();toast(button.dataset.cancel?'已请求停止；当前调用结束后保存检查点':'任务已恢复，已完成记录会保留');}));
  root.querySelectorAll('[data-candidate]').forEach(button=>button.onclick=busy(()=>showCandidate(button.dataset.job,Number(button.dataset.candidate))));
}
function render(){
  connection();
  $('breadcrumbName').textContent=state.project?.name||'尚未创建课题';$('topicTitle').textContent=state.project?.name||'建立你的第一个研究课题';$('topicGoal').textContent=state.project?.goal||'输入课题名称或上传 PDF，确定研究范围后开始分析。';
  $('projectSelect').innerHTML=state.projects.map(p=>`<option value="${esc(p.id)}" ${p.id===state.project?.id?'selected':''}>${esc(p.name)}</option>`).join('');
  const completed=state.papers.filter(p=>p.analysis.verified).length;
  const actions=state.papers.flatMap(p=>p.analysis.actions||[]);
  const pending=new Set(state.jobs.flatMap(j=>(j.checkpoint?.candidates||[]).filter(c=>['no_fulltext','unverified'].includes(c.status)).map(c=>c.doi||c.title))).size;
  const metrics=state.demo?[[4,'条合成文献记录','仅用于界面演示','▤'],[0,'篇完成真实精读','示例不计入分析成果','◉'],[3,'张示例行动卡','研究方案尚未执行','↗'],[1,'个示例证据缺口','展示未获得全文的状态','◷']]:[[state.papers.length,'篇累计文献','当前课题关联的独立论文','▤'],[completed,'篇完成模型核验','结构通过 ≠ 科学结论已证实','◉'],[actions.length,'项待执行研究行动','按资源与证据安排优先级','↗'],[pending,'项待补证据','缺全文或原图未核验','◷']];
  $('stats').innerHTML=metrics.map(([n,label,note,icon])=>`<div class="stat"><span class="stat-label">${label}</span><span class="stat-decoration">${icon}</span><span class="stat-value">${n}</span><div class="stat-note">${note}</div></div>`).join('');
  $('export').disabled=state.papers.length===0;$('export').title=state.papers.length?'导出已登记的正式文献记录':'尚无已登记文献；候选草稿可在其详情中单独导出';
  $('batchSelect').hidden=state.demo||state.view!=='latest'||!state.jobs.length;
  document.querySelectorAll('[data-nav]').forEach(b=>b.classList.toggle('active',b.dataset.nav===state.nav));
  $('workspace').hidden=state.nav!=='library';$('alternate').hidden=state.nav==='library';
  if(state.nav==='library')renderPapers();else if(state.nav==='jobs')renderJobs();else renderProjects();
}
function tags(p){return p.tags||state.project?.scope?.keywords?.slice(0,3)||[];}
function renderPapers(){
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
function clearFilters(){for(const id of ['search','tagFilter','dateFilter','priorityFilter','statusFilter'])$(id).value='';renderPapers();}
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
  return `<article class="candidate-result"><div class="candidate-meta">${candidateStatus(item)}<span>${esc(item.source||'来源未记录')} · ${esc(item.year||'年份未知')} · ${item.publication_status==='published'?'正式发表':item.publication_status==='preprint'?'预印本':'发表状态待确认'}</span></div><h3 class="candidate-title"><button class="title-button" data-job="${esc(job.id)}" data-candidate="${index}">${esc(item.title||'未命名候选')}</button></h3><p class="candidate-meta">${esc((item.authors||[]).slice(0,4).join(' · '))}${item.journal?' · '+esc(item.journal):''}</p><p class="candidate-reason">${esc(reason)}</p><div class="candidate-actions"><button class="outline" data-job="${esc(job.id)}" data-candidate="${index}">${item.status==='unverified'?'阅读分析草稿':'查看题录与证据缺口'} →</button>${publicationLink(item)}${!activeStatuses.has(job.status)&&needsEvidence.has(item.status)?`<label class="outline upload-button">补充全文 PDF<input class="sr-only" type="file" accept=".pdf,application/pdf" data-upload-job="${esc(job.id)}" data-index="${index}"></label>`:''}</div></article>`;
}
function bindUploads(root){root.querySelectorAll('[data-upload-job]').forEach(input=>input.onchange=async()=>{if(!input.files[0])return;try{input.disabled=true;if(input.files[0].size>50*1024*1024)throw new Error('PDF 超过 50 MB');const form=new FormData();form.append('file',input.files[0]);await api(`/api/jobs/${input.dataset.uploadJob}/candidates/${input.dataset.index}/pdf`,{method:'POST',body:form});toast('全文已保存。点击「从检查点继续」后核对正文身份并恢复分析。');await loadProject();}catch(error){toast(error.message);}finally{input.disabled=false;input.value='';}});}
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
    if(job&&!activeStatuses.has(job.status)&&needsEvidence.has(p.status))body+=`<div class="form-actions"><label class="outline upload-button">补充全文 PDF<input class="sr-only" type="file" accept=".pdf,application/pdf" data-upload-job="${esc(jid)}" data-index="${index}"></label><button class="primary" data-retry="${esc(jid)}">从检查点继续</button></div><p class="reader-meta">恢复分析将使用当前模型设置并产生 API 用量；已登记记录不会重复新增。</p>`;
    showModal('CANDIDATE READING · 候选与分析草稿',body,true);renderMath();bindResultActions($('modalBody'));bindUploads($('modalBody'));
    $('exportCandidate')?.addEventListener('click',()=>download(new Blob([JSON.stringify(detail,null,2)],{type:'application/json'}),`candidate-${index+1}-unverified.json`));
    $('openCandidatePdf')?.addEventListener('click',busy(async()=>{const blob=await api(base+'/pdf',{binary:true});download(blob,`candidate-${index+1}.pdf`);}));
    $('openCandidateSource')?.addEventListener('click',busy(async()=>{const el=$('candidateSource'),version=state.modalVersion;const source=await api(base+'/source');if(!el?.isConnected||version!==state.modalVersion)return;el.innerHTML=section('正文来源定位',`<p>${esc(source.notice||'来源定位不表示科学结论已核验')}</p>`+(source.blocks||[]).map(block=>`<details><summary>${esc(block.id)} · PDF 第 ${esc(block.page)} 页</summary><div class="reading-notes">${esc(block.text)}</div></details>`).join(''),'source-blocks');el.scrollIntoView({behavior:'smooth',block:'start'});}));
    if(p.analysis)await loadReaderAssets(base+'/assets');
  }catch(error){if(version===state.modalVersion&&$('modal').open){$('modalBody').innerHTML=`<div class="empty"><h2>暂时无法读取记录</h2><p>${esc(error.message)}</p><p>请刷新研究空间后重试；已保存资料仍在后端。</p></div>`;}}
}


function connectionForm(){
  const localBase=['localhost','127.0.0.1'].includes(location.hostname)?location.origin:'';
  showModal('CONNECT · 私人服务',`<h2>连接你的研究空间</h2><p>私人服务保存论文、台账并运行分析。示例演示不消耗 API。</p><div class="callout">这里使用私人后台的登录口令，与 GitHub、Codex 登录无关。本机版由启动程序生成独立口令；公网版由部署者设置。</div><form id="connectForm">${field('后台地址','backendUrl',state.base||localBase,'url','填写已运行的私人后台根地址，不是 GitHub 仓库或模型 API 地址。')}${field('管理员口令','adminPassword','','password','使用本机启动程序提供的口令，或公网后台的 ADMIN_PASSWORD；没有通用默认口令。')}<p id="formMessage"></p><div class="form-actions"><button type="button" class="quiet" id="keepDemo">继续示例演示</button><button class="primary" type="submit">连接并登录 →</button></div></form>`);
  $('keepDemo').onclick=()=>{closeModal();enterDemo();};
  $('connectForm').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{
    const url=new URL($('backendUrl').value.trim());if(url.username||url.password||url.search||url.hash)throw new Error('服务地址不能包含凭据、查询参数或片段');if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('线上服务必须使用 HTTPS');
    const newBase=url.href.replace(/\/$/,'');const res=await fetch(newBase+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:jsonBody({password:$('adminPassword').value})});const data=await res.json();if(!res.ok)throw new Error(data.detail||'登录失败');state.base=newBase;state.token=data.token;sessionStorage.setItem('pw-token',state.token);localStorage.setItem('pw-base',state.base);await loadWorkspace();closeModal();toast('已连接私人研究空间');
  }catch(error){modalError(error);}finally{button.disabled=false;}};
}
async function loadWorkspace(){
  const [projects,settings]=await Promise.all([api('/api/projects'),api('/api/settings')]);
  state.demo=false;state.projects=projects;state.settings=settings;state.project=projects.find(p=>p.id===localStorage.getItem('pw-project'))||projects[0]||null;await loadProject();startPolling();
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
function enterDemo(){clearInterval(state.poll);state.demo=true;state.projects=[demoProject];state.project=demoProject;state.papers=demoPapers;state.jobs=[];state.batchId='';state.nav='library';render();}
function requireService(){if(state.demo){connectionForm();return false;}return true;}
function startPolling(){
  clearInterval(state.poll);state.poll=setInterval(async()=>{
    if(!state.project||state.demo||state.pollBusy)return;
    const projectId=state.project.id,revision=state.loadRevision;state.pollBusy=true;
    const current=()=>!state.demo&&state.project?.id===projectId&&state.loadRevision===revision;
    try{
      const jobs=await api(`/api/projects/${projectId}/jobs`);if(!current())return;
      if(JSON.stringify(jobs)!==JSON.stringify(state.jobs)){
        const papers=await api(`/api/projects/${projectId}/papers`);if(!current())return;
        state.jobs=jobs;state.papers=papers;render();
      }
    }catch(e){if(!state.token&&!state.demo){clearInterval(state.poll);toast('登录已过期，请重新连接服务');}}
    finally{state.pollBusy=false;}
  },5000);
}

function newProjectForm(){
  if(!requireService())return;
  showModal('NEW PROJECT · 创建课题',`<h2>从你的研究问题开始</h2><p>参考 PDF 用于界定范围，不占用本批论文数量。</p><form id="projectForm">${field('课题名称','projectName')}${area('研究目标与已有条件（可选）','projectGoal')}<label class="field">参考 PDF（可选）<input id="referencePdf" type="file" accept="application/pdf,.pdf"><small>单份不超过 50 MB、300 页。资料只进入私人后端；生成范围时会发送给模型 API。</small></label><p id="formMessage"></p><div class="form-actions"><button type="submit" class="primary">创建并设置研究范围 →</button></div></form>`);
  $('projectForm').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{const name=$('projectName').value.trim();if(!name)throw new Error('请填写课题名称');const file=$('referencePdf').files[0];if(file&&file.size>50*1024*1024)throw new Error('PDF 超过 50 MB');const project=await api('/api/projects',{method:'POST',body:jsonBody({name,goal:$('projectGoal').value})});state.projects.unshift(project);state.project=project;await loadProject();if(file){const form=new FormData();form.append('file',file);await api(`/api/projects/${project.id}/references`,{method:'POST',body:form});}scopeForm();}catch(error){modalError(error);}finally{e.submitter.disabled=false;}};
}
function scopeForm(){
  if(!state.project){newProjectForm();return;}
  const scope=state.project.scope;
  showModal('RESEARCH SCOPE · 研究范围',`<h2>${esc(state.project.name)}</h2><p>${scope.inferred?'当前范围含推定内容，请检查后保存。':'当前范围已由你确认。'}上传资料中的命令不会作为执行指令。</p>${area('科学问题','scopeQuestion',scope.research_question)}${field('检索关键词（逗号分隔）','scopeKeywords',(scope.keywords||[]).join(', '))}${area('纳入范围','scopeInclude',scope.include)}${area('排除范围','scopeExclude',scope.exclude)}<p id="formMessage"></p><div class="form-actions"><button class="outline" id="inferScope">根据课题与资料提取范围</button><button class="primary" id="saveScope">确认并保存</button></div>`);
  $('inferScope').onclick=busy(async()=>{if(!requireService())return;$('formMessage').textContent='正在读取参考资料并提取范围…';const s=await api(`/api/projects/${state.project.id}/infer-scope`,{method:'POST'});$('scopeQuestion').value=s.research_question;$('scopeKeywords').value=s.keywords.join(', ');$('scopeInclude').value=s.include;$('scopeExclude').value=s.exclude;$('formMessage').textContent='模型推定范围已填入，请检查后保存。';});
  $('saveScope').onclick=busy(async()=>{if(!requireService())return;const scope={research_question:$('scopeQuestion').value,keywords:$('scopeKeywords').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean),include:$('scopeInclude').value,exclude:$('scopeExclude').value,inferred:false};state.project=await api(`/api/projects/${state.project.id}/scope`,{method:'PUT',body:jsonBody(scope)});state.projects=state.projects.map(p=>p.id===state.project.id?state.project:p);closeModal();render();toast('研究范围已保存');});
}
function settingsForm(){
  if(!requireService())return;const cfg=state.settings;
  showModal('SETTINGS · 模型与连接',`<h2>模型与检索配置</h2><p>使用支持文本与图像的兼容接口。密钥加密保存在你的后端，不进入 Pages 或导出文件。</p>${field('API 基础地址','modelBase',cfg.base_url||'https://api.openai.com/v1','url')}${field('模型 API 密钥','apiKey','','password',cfg.has_api_key?'已配置；留空保留原密钥':'请填写你的密钥')}${field('文本模型名称（必填）','textModel',cfg.text_model||'','text','从供应商模型列表复制准确名称，API 密钥不会自动选择模型。')}${field('视觉模型名称（必填）','visionModel',cfg.vision_model||'','text','用于核对论文原图，必须支持图像输入；可与文本模型使用同一支持图像的模型。')}${field('OpenAlex API 密钥（可选）','alexKey','','password',cfg.has_openalex_key?'已配置；留空保留':'未配置时仅使用 Crossref')}<p id="formMessage"></p><div class="form-actions"><button class="outline" id="checkSetup">检查技能与图像能力</button><button class="primary" id="saveSettings">保存配置</button></div>`);
  $('saveSettings').onclick=busy(async()=>{await api('/api/settings',{method:'PUT',body:jsonBody(providerFormValues())});state.settings=await api('/api/settings');$('apiKey').value='';$('alexKey').value='';$('formMessage').textContent='已保存。可检查接口能力；检查会产生少量 API 调用。';$('formMessage').className='success';});
  $('checkSetup').onclick=busy(async()=>{$('formMessage').textContent='正在检查外部技能和模型的实际图像读取能力…';await api('/api/preflight',{method:'POST'});$('formMessage').textContent='外部技能、文本和图像接口均通过检查。';$('formMessage').className='success';});
  const exit=document.createElement('button');exit.className='quiet';exit.textContent='退出私人空间';$('modalBody').querySelector('.form-actions').prepend(exit);exit.onclick=()=>{closeModal();$('logout').click();};
}
function batchForm(){
  if(!requireService())return;if(!state.project){newProjectForm();return;}if(!state.settings.configured){settingsForm();return;}
  const scope=state.project.scope;
  showModal('NEW BATCH · 文献分析',`<h2>开始一批有证据的阅读</h2><p>${esc(state.project.name)}</p><div class="callout"><strong>研究问题</strong><br>${esc(scope.research_question)}<br>关键词：${esc(scope.keywords.join(' · '))}<br>纳入：${esc(scope.include)}<br>排除：${esc(scope.exclude)}</div><label class="field">本批目标数量<input id="batchCount" type="number" min="1" max="20" value="5"><small>优先高度相关、最新正式发表且未分析的论文。可靠文献不足时保留缺额。</small></label><p>文本模型：${esc(state.settings.text_model)}<br>视觉模型：${esc(state.settings.vision_model)}</p><div class="callout">开始后，课题范围、检索题录、论文正文与选定原图将发送给你配置的模型 API。关闭网页后后台任务继续；不会自动公开研究资料。</div><p id="formMessage"></p><div class="form-actions"><button class="outline" id="adjustScope">修改范围</button><button class="primary" id="submitBatch">确认并开始分析 →</button></div>`);
  $('adjustScope').onclick=scopeForm;
  $('submitBatch').onclick=busy(async()=>{const count=Number($('batchCount').value);if(!Number.isInteger(count)||count<1||count>20)throw new Error('数量应为 1–20 的整数');const j=await api(`/api/projects/${state.project.id}/jobs`,{method:'POST',body:jsonBody({count})});closeModal();state.nav='jobs';await loadProject();toast('任务已提交，可在分析批次查看进度');});
}
function renderProjects(){
  $('alternate').innerHTML='<div class="section-bar"><h2>我的课题库</h2><button class="primary" id="altNew">＋ 创建课题</button></div>'+state.projects.map(p=>`<article class="project-card"><h3>${esc(p.name)}</h3><p>${esc(p.goal)}</p><div class="tags">${(p.scope.keywords||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div><div class="form-actions"><button class="outline" data-open-project="${esc(p.id)}">打开课题库 →</button></div></article>`).join('');
  $('altNew').onclick=newProjectForm;$('alternate').querySelectorAll('[data-open-project]').forEach(b=>b.onclick=async()=>{state.project=state.projects.find(p=>p.id===b.dataset.openProject);state.nav='library';if(state.demo)render();else try{await loadProject();}catch(e){toast(e.message);}});
}
function renderJobs(){
  $('alternate').innerHTML='<div class="section-bar"><div><p class="eyebrow">ANALYSIS HISTORY</p><h2>分析批次与结果</h2></div><button class="outline" id="refreshJobs">刷新状态</button></div>'+(state.jobs.length?state.jobs.map(job=>{
    const c=job.checkpoint||{},s=summarizeBatch(job),stage=stages.indexOf(job.stage);
    return `<article class="job-card"><div class="job-header"><span class="eyebrow">${esc(dateLabel(job.created_at))} · 批次 ${esc(job.id.slice(0,8))}</span>${badge(s.full?'目标已完成':s.active?'正在执行':job.status==='failed'?'执行中断':'有证据缺口',s.full?'success':s.active?'neutral':job.status==='failed'?'danger':'warning')}</div><h3>${esc(batchOutcome(job))}</h3><div class="stages" aria-label="任务阶段">${stages.map((label,i)=>`<span class="stage ${i===stage?'current':i<stage?'done':''}">${i+1}. ${label}</span>`).join('')}</div><div class="job-counts"><span>目标 <strong>${s.target}</strong> 篇</span><span>新增完整精读 <strong>${s.complete}</strong> 篇</span><span>复用 <strong>${s.reused}</strong> 篇</span><span>待补全文 <strong>${s.missingFulltext}</strong> 篇</span><span>未核验 <strong>${s.unverified}</strong> 篇</span><span>缺额 <strong>${s.shortfall}</strong> 篇</span></div>${job.error?`<p class="error">${esc(job.error)}</p>`:''}${!s.active&&!s.full?'<p class="candidate-reason">本批流程已结束，未达到完整精读目标。候选与分析草稿仍可阅读；补齐材料后可恢复任务。</p>':''}<div class="job-buttons"><button class="primary" data-results="${esc(job.id)}">查看文献、候选与草稿 →</button>${s.active?`<button class="outline" data-cancel="${esc(job.id)}" ${job.cancel_requested?'disabled':''}>${job.cancel_requested?'已请求停止':'取消任务'}</button>`:!s.full?`<button class="outline" data-retry="${esc(job.id)}">从检查点继续</button>`:''}</div><details><summary>检索与筛选记录 · ${s.total} 条候选，${s.excluded} 条已排除</summary><div class="job-diagnostics"><h4>检索源状态</h4>${s.diagnostics.length?bullet(s.diagnostics):para(s.total?'未记录检索源故障。':'暂无来源记录，可能尚未通过接口预检。')}<h4>检索过程</h4><div class="search-log">${(c.search_log||[]).map(log=>`<div><strong>${esc(log.from_year)} 年起</strong><span>${esc(log.query)}</span><span>返回 ${Number(log.found)||0} 条 · 新增候选 ${Number(log.new_candidates)||0} 条</span><small>${esc(dateLabel(log.retrieved_at))}</small></div>`).join('')||'<p>尚未开始检索，或本阶段没有留下记录。</p>'}</div><p>全部题录和逐条筛选理由可在「查看文献、候选与草稿」中按状态筛选。</p></div></details></article>`;
  }).join(''):'<div class="empty"><h3>还没有分析批次</h3><p>先创建或选择课题，确认研究范围，再开始检索与分析。</p><button class="primary" id="firstBatch">开始第一批分析 →</button></div>');
  $('refreshJobs').onclick=busy(async()=>{if(state.demo){toast('示例演示没有真实后台任务');return;}await loadProject();toast('批次状态已更新');});
  $('firstBatch')?.addEventListener('click',batchForm);bindResultActions($('alternate'));
}

function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
$('export').onclick=async()=>{if(!requireService())return;if(!state.project)return;try{const kind=$('exportKind').value;download(await api(`/api/projects/${state.project.id}/export?kind=${kind}`,{binary:true}),kind==='json'?'papers.json':`research-${kind}.zip`);}catch(e){toast(e.message);}};
for(const id of ['search','tagFilter','dateFilter','priorityFilter','statusFilter'])$(id).addEventListener('input',renderPapers);
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{switchView(b.dataset.view);renderPapers();});
document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{state.nav=b.dataset.nav;render();});
$('projectSelect').onchange=async()=>{state.project=state.projects.find(p=>p.id===$('projectSelect').value);try{if(state.demo)render();else await loadProject();}catch(e){toast(e.message);}};
$('connect').onclick=connectionForm;$('settings').onclick=()=>state.demo?connectionForm():settingsForm();$('newProject').onclick=newProjectForm;$('newBatch').onclick=batchForm;$('editScope').onclick=scopeForm;
$('topSettings').onclick=()=>state.demo?connectionForm():settingsForm();
$('clearFilters').onclick=clearFilters;
$('batchSelect').onchange=()=>{state.batchId=$('batchSelect').value;state.candidateLimit=12;renderPapers();};
$('refreshWorkspace').onclick=busy(async()=>{if(state.demo){render();toast('示例演示已刷新');return;}await loadWorkspace();toast('课题、文献与批次已更新');});
$('logout').onclick=()=>{state.token='';sessionStorage.removeItem('pw-token');enterDemo();toast('已退出私人空间');};
$('help').onclick=()=>showModal('GUIDE · 使用说明','<h2>从问题到证据，再到行动</h2><p>1. 部署者将前端发布至 GitHub Pages，另部署私人分析服务。</p><p>2. 连接服务并登录，配置模型 API 与外部 Norman 技能。</p><p>3. 创建课题，上传参考 PDF 或输入课题名称，检查研究范围。</p><p>4. 运行默认五篇分析。缺全文或未核验的候选不会凑数。</p><p>5. 浏览精读证据和待执行研究行动，导出私人文献库。</p><div class="callout">模型核验不是人工复核，也不等于独立复现。研究行动卡是建议方案。</div><p>源码与部署说明随本项目提供。示例全部为合成内容。</p>');
render();
if(state.base&&state.token)loadWorkspace().catch(e=>{enterDemo();toast('私人服务暂不可用：'+e.message);});
