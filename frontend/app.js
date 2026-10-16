import {demoProject, demoPapers} from './demo.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = {demo:true,projects:[demoProject],project:demoProject,papers:demoPapers,jobs:[],view:'latest',nav:'library',base:localStorage.getItem('pw-base')||'',token:sessionStorage.getItem('pw-token')||'',settings:{},poll:null,urls:[]};
const statusNames = {queued:'等待执行',running:'正在分析',completed:'批次结束',failed:'运行失败',cancelled:'已取消',pending:'待处理',excluded:'已排除',duplicate:'已分析，不计新增',no_fulltext:'待补全文',unverified:'未核验',reused:'复用证据'};
const stages = ['检索','去重','获取全文','分析','图表核验','校验','完成'];
const watermark = '分析采用 norman-paper-reading 技能｜作者：N同学｜小红书：N同学｜B站/抖音：耐心的N同学\nAnalysis performed using the norman-paper-reading skill | Author: N同学 | Xiaohongshu: N同学 | Bilibili/Douyin: 耐心的N同学';

function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,5500);}
async function api(path,options={}){
  const headers = {Authorization:`Bearer ${state.token}`,...options.headers};
  if(options.body && !(options.body instanceof FormData)) headers['Content-Type']='application/json';
  const res=await fetch(state.base+path,{...options,headers});
  if(!res.ok){let detail;try{detail=(await res.json()).detail;}catch{detail=`HTTP ${res.status}`;}if(res.status===401){state.token='';sessionStorage.removeItem('pw-token');}throw new Error(typeof detail==='string'?detail:JSON.stringify(detail));}
  return options.binary?res.blob():res.json();
}
function jsonBody(value){return JSON.stringify(value);}
function showModal(title,body,wide=false){clearAssets();$('modal').classList.toggle('wide',wide);$('dialogLabel').textContent=title;$('modalBody').innerHTML=body;if(!$('modal').open)$('modal').showModal();}
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
function render(){
  connection();
  $('breadcrumbName').textContent=state.project?.name||'尚未创建课题';$('topicTitle').textContent=state.project?.name||'建立你的第一个研究课题';$('topicGoal').textContent=state.project?.goal||'输入课题名称或上传 PDF，确定研究范围后开始分析。';
  $('projectSelect').innerHTML=state.projects.map(p=>`<option value="${esc(p.id)}" ${p.id===state.project?.id?'selected':''}>${esc(p.name)}</option>`).join('');
  const completed=state.papers.filter(p=>p.analysis.verified).length;
  const actions=state.papers.flatMap(p=>p.analysis.actions||[]);
  const pending=state.jobs.reduce((sum,j)=>sum+(j.checkpoint?.candidates||[]).filter(c=>['no_fulltext','unverified'].includes(c.status)).length,0);
  const metrics=state.demo?[[4,'条合成文献记录','仅用于界面演示','▤'],[0,'篇完成真实精读','示例不计入分析成果','◉'],[3,'张示例行动卡','研究方案尚未执行','↗'],[1,'个示例证据缺口','展示未获得全文的状态','◷']]:[[state.papers.length,'篇累计文献','当前课题关联的独立论文','▤'],[completed,'篇完成模型核验','结构通过 ≠ 科学结论已证实','◉'],[actions.length,'项待执行研究行动','按资源与证据安排优先级','↗'],[pending,'项待补证据','缺全文或原图未核验','◷']];
  $('stats').innerHTML=metrics.map(([n,label,note,icon])=>`<div class="stat"><span class="stat-label">${label}</span><span class="stat-decoration">${icon}</span><span class="stat-value">${n}</span><div class="stat-note">${note}</div></div>`).join('');
  document.querySelectorAll('[data-nav]').forEach(b=>b.classList.toggle('active',b.dataset.nav===state.nav));
  $('workspace').hidden=state.nav!=='library';$('alternate').hidden=state.nav==='library';
  if(state.nav==='library')renderPapers();else if(state.nav==='jobs')renderJobs();else renderProjects();
}
function tags(p){return p.tags||state.project?.scope?.keywords?.slice(0,3)||[];}
function renderPapers(){
  const old=$('tagFilter').value;
  $('tagFilter').innerHTML='<option value="">全部主题</option>'+[...new Set(state.papers.flatMap(tags))].map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');$('tagFilter').value=old;
  const q=$('search').value.toLocaleLowerCase().trim(),tag=$('tagFilter').value,date=$('dateFilter').value,priority=$('priorityFilter').value,status=$('statusFilter').value;
  const latest=state.jobs[0]?.id || state.papers[0]?.batch_id;
  let list=state.papers.filter(p=>{
    const a=p.analysis;
    return (state.view!=='latest'||p.batch_id===latest)&&(!q||JSON.stringify([p.title,p.doi,a.summary,a.actions,tags(p)]).toLocaleLowerCase().includes(q))&&(!tag||tags(p).includes(tag))&&(!date||a.analyzed_date===date)&&(!priority||a.actions?.some(x=>x.priority===priority))&&(!status||(status==='verified')===!!a.verified);
  });
  list.sort((a,b)=>(b.analysis.analyzed_date||'').localeCompare(a.analysis.analyzed_date||''));
  $('resultCount').textContent=`显示 ${list.length} / ${state.papers.length} ${state.demo?'条示例':'篇文献'}${state.view==='latest'?' · 最近一次分析批次':''}`;
  $('cards').innerHTML=list.map(p=>paperCard(p)).join('')||'<div class="empty"><h3>让研究从一个好问题开始</h3><p>这里还没有符合条件的文献。创建课题并启动分析，或清空筛选条件。</p></div>';
  $('cards').querySelectorAll('[data-paper]').forEach(b=>b.onclick=()=>showPaper(b.dataset.paper));
}
function paperCard(p){
  const a=p.analysis,priority=a.actions?.[0]?.priority;
  let content=`<p class="summary">${esc(a.summary)}</p>`;
  if(state.view==='evidence') content=(a.evidence||[]).map(e=>`<div class="action-item"><strong>${esc(e.id)} · ${esc(e.claim)}</strong><p>${esc(e.observation)}</p><span class="tag">${esc(e.source_block_ids.join(' · ')||'合成示例 · 无真实来源')}</span></div>`).join('');
  else if(state.view==='actions')content=(a.actions||[]).map(x=>`<details class="action-item"><summary><span class="tag priority">${esc(x.priority)}</span> ${esc(x.title)}</summary><p>假设：${esc(x.hypothesis)}</p><p>方法与对照：${esc(x.method)} ${esc(x.controls)}</p><p>支持方向：${esc(x.supporting)}</p><p>削弱方向：${esc(x.weakening)}</p><p>资源与成果：${esc(x.resources)} ${esc(x.deliverable)}</p><p>样本量与阈值：${esc(x.sample_size_basis)}</p></details>`).join('')||'<p class="summary">证据不足，暂未提出可执行研究行动。</p>';
  else content+=`<div class="mini-flow">${a.flow_steps.slice(0,4).map((x,i)=>`${i?'<b>→</b>':''}<span>${esc(x)}</span>`).join('')}</div><div class="flow-label">分析者绘制 · 流程概览，非原论文图</div>`;
  return `<article class="paper-card"><div class="card-top"><span>${esc(p.id)} · ${p.year?esc(p.year):'SYNTHETIC EXAMPLE'}</span><span class="verified ${a.verified?'':'synthetic'}">${state.demo?'合成示例':a.verified?'已模型核验':'未核验'}</span></div><div class="card-body"><h3><button class="title-button" data-paper="${esc(p.id)}">${esc(p.title)}</button></h3><p class="journal">${esc(p.journal||'发表信息待确认')}${a.analyzed_date?' · '+esc(a.analyzed_date)+' 分析':''}</p><div class="tags">${tags(p).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}${priority?`<span class="tag priority">${esc(priority)} 优先级</span>`:''}</div>${content}</div><div class="card-bottom"><span>${state.demo?'不对应真实论文':p.publication_status==='published'?'正式发表':p.publication_status==='preprint'?'预印本':'发表状态待确认'}</span><button data-paper="${esc(p.id)}">进入精读与研究规划 ↗</button></div></article>`;
}
function section(title,content){return `<section><h2>${title}</h2>${content}</section>`;}
function para(value){return `<p>${esc(value)}</p>`;}
function bullet(values){return `<ul>${(values||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;}
async function showPaper(id){
  const p=state.papers.find(p=>p.id===id);if(!p)return;const a=p.analysis;
  let body=`<article class="reader"><span class="tag">${esc(p.id)}</span><h2>${esc(p.title)}</h2><p class="reader-meta">${esc(p.journal)} · ${esc(p.doi||'无 DOI · 合成示例')}<br>${esc(a.verification_status)}</p>`;
  if(state.demo)body+='<div class="callout">合成示例，没有真实论文、数据或核验结论。</div>';
  if(a.transfer_notice)body+=`<div class="callout">${esc(a.transfer_notice)}</div>`;
  body+=section('简明总结与科学问题',para(a.summary)+`<h3>科学问题</h3>`+para(a.scientific_question));
  body+=section('研究流程 · 分析者绘制',state.demo?`<ol>${a.flow_steps.map(s=>`<li>${esc(s)}</li>`).join('')}</ol>`:'<img data-asset="research-flow.svg" alt="分析者绘制，非原论文图">');
  body+=section('研究设计重建',`<dl>${[['variables','变量'],['samples','样本'],['equipment','设备'],['parameters','参数'],['controls','对照'],['repeats','独立重复'],['statistics','统计设计']].map(([key,label])=>`<dt>${label}</dt><dd>${esc(a[key])}</dd>`).join('')}</dl>`);
  body+=section('结论、推断与证据边界','<h3>作者结论</h3>'+para(a.author_conclusions)+'<h3>分析者推断</h3>'+para(a.analyst_inference)+(a.evidence||[]).map(e=>`<h3>${esc(e.id)} · ${esc(e.claim)}</h3>${para(e.observation)}<p class="reader-meta">${esc(e.source_block_ids.join(' · '))}</p>${para(e.interpretation)}${para('局限：'+e.limits)}`).join(''));
  body+=section('原图、表与必要公式',(a.visuals||[]).map(v=>`<h3>${esc(v.label)}</h3><figure><img data-asset="page-${v.page}.png" alt="PDF 第 ${v.page} 页原图"><figcaption>PDF 第 ${v.page} 页完整原图 · 点击放大</figcaption></figure>${para(v.explanation)}${para('核验边界：'+v.limitations)}`).join('')||para('此记录未提供可核验原图。'));
  body+=section('需要精读的内容与原因',bullet(a.reading_list));body+=section('未来研究启示与迁移条件',para(a.future_insights)+para(a.transfer_conditions));
  body+=section('复现检查清单',bullet(a.reproduction_checklist));
  body+=section('下一步研究规划 · 待执行',(a.actions||[]).map(x=>`<h3><span class="tag priority">${esc(x.priority)}</span> ${esc(x.id)} ${esc(x.title)}</h3><dl>${[['gap','证据缺口'],['hypothesis','假设'],['method','方法'],['controls','对照'],['supporting','支持方向'],['weakening','削弱方向'],['resources','资源条件'],['sample_size_basis','样本量依据'],['deliverable','交付成果']].map(([key,label])=>`<dt>${label}</dt><dd>${esc(x[key])}</dd>`).join('')}</dl>`).join('')+para(a.roadmap));
  body+=section('来源与未核验材料',bullet(a.sources)+bullet(a.unread));
  body+=para(JSON.stringify(a.coverage||{},null,2));
  if(!state.demo)body+=`<p class="watermark">${esc(watermark)}</p>`;
  body+='</article>';showModal('READING ROOM · 论文与研究行动',body,true);
  if(window.temml)window.temml.renderMathInElement($('modalBody'),{delimiters:[{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'\\(',right:'\\)',display:false}],throwOnError:false,trust:false});
  if(!state.demo){for(const el of $('modalBody').querySelectorAll('[data-asset]')){try{const blob=await api(`/api/papers/${Number(p.id.slice(1))}/assets/${el.dataset.asset}`,{binary:true});const url=URL.createObjectURL(blob);state.urls.push(url);if(el.isConnected){el.src=url;el.onclick=()=>window.open(url,'_blank','noopener');}}catch{el.alt='原图获取失败，请检查登录与资源状态';}}}
}

function connectionForm(){
  showModal('CONNECT · 私人服务',`<h2>连接你的研究空间</h2><p>GitHub Pages 展示界面；私人服务保存论文、台账并运行分析。示例演示不消耗 API。</p><div class="callout">这里使用私人后台的登录口令，与 GitHub、Codex 登录无关。后台尚未部署时，请先浏览示例演示。</div><form id="connectForm">${field('后端 HTTPS 地址','backendUrl',state.base,'url','填写已运行的私人后台根地址，不是 GitHub 仓库或模型 API 地址。开发环境可使用 localhost。')}${field('管理员口令','adminPassword','','password','由部署者通过后台环境变量 ADMIN_PASSWORD 设置；项目没有默认口令。')}<p id="formMessage"></p><div class="form-actions"><button type="button" class="quiet" id="keepDemo">继续示例演示</button><button class="primary" type="submit">连接并登录 →</button></div></form>`);
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
  if(state.project){[state.papers,state.jobs]=await Promise.all([api(`/api/projects/${state.project.id}/papers`),api(`/api/projects/${state.project.id}/jobs`)]);localStorage.setItem('pw-project',state.project.id);}else{state.papers=[];state.jobs=[];}render();
}
function enterDemo(){clearInterval(state.poll);state.demo=true;state.projects=[demoProject];state.project=demoProject;state.papers=demoPapers;state.jobs=[];state.nav='library';render();}
function requireService(){if(state.demo){connectionForm();return false;}return true;}
function startPolling(){clearInterval(state.poll);state.poll=setInterval(async()=>{if(!state.project||state.demo)return;try{const jobs=await api(`/api/projects/${state.project.id}/jobs`);const changed=JSON.stringify(jobs)!==JSON.stringify(state.jobs);state.jobs=jobs;if(changed){state.papers=await api(`/api/projects/${state.project.id}/papers`);render();}}catch(e){if(!state.token){clearInterval(state.poll);toast('登录已过期，请重新连接服务');}}},5000);}

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
  showModal('SETTINGS · 模型与连接',`<h2>模型与检索配置</h2><p>使用支持文本与图像的兼容接口。密钥加密保存在你的后端，不进入 Pages 或导出文件。</p>${field('API 基础地址（含 /v1）','modelBase',cfg.base_url||'https://api.openai.com/v1','url')}${field('模型 API 密钥','apiKey','','password',cfg.has_api_key?'已配置；留空保留原密钥':'请填写你的密钥')}${field('文本模型名称','textModel',cfg.text_model||'')}${field('视觉模型名称','visionModel',cfg.vision_model||'')}${field('OpenAlex API 密钥（可选）','alexKey','','password',cfg.has_openalex_key?'已配置；留空保留':'未配置时仅使用 Crossref')}<p id="formMessage"></p><div class="form-actions"><button class="outline" id="checkSetup">检查技能与图像能力</button><button class="primary" id="saveSettings">保存配置</button></div>`);
  $('saveSettings').onclick=busy(async()=>{await api('/api/settings',{method:'PUT',body:jsonBody({base_url:$('modelBase').value.trim(),api_key:$('apiKey').value,text_model:$('textModel').value.trim(),vision_model:$('visionModel').value.trim(),openalex_key:$('alexKey').value})});state.settings=await api('/api/settings');$('apiKey').value='';$('alexKey').value='';$('formMessage').textContent='已保存。可检查接口能力；检查会产生少量 API 调用。';$('formMessage').className='success';});
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
  $('alternate').innerHTML='<div class="section-bar"><h2>分析批次</h2><button class="outline" id="refreshJobs">刷新状态</button></div>'+(state.jobs.length?state.jobs.map(j=>{const c=j.checkpoint||{};return `<article class="job-card"><span class="eyebrow">${esc(j.id.slice(0,8))} · ${esc(j.created_at.slice(0,16).replace('T',' '))} UTC</span><h3>${esc(statusNames[j.status]||j.status)} · ${esc(j.stage)}</h3><div class="stages">${stages.map(s=>`<span class="stage ${s===j.stage?'current':''}">${s}</span>`).join('')}</div><div class="job-counts"><span>目标 ${j.requested} 篇</span><span>新增完成 ${(c.completed||[]).length} 篇</span><span>复用 ${(c.reused||[]).length} 篇（不计新增）</span><span>待核验 ${c.pending_verification??(c.candidates||[]).filter(x=>x.status==='unverified').length} 篇</span><span>缺额 ${c.shortfall??Math.max(0,j.requested-(c.completed||[]).length)} 篇</span></div>${j.error?`<p class="error">${esc(j.error)}</p>`:''}<div class="job-buttons">${['running','queued'].includes(j.status)?`<button class="outline" data-cancel="${esc(j.id)}">${j.cancel_requested?'已请求停止':'取消任务'}</button>`:`<button class="outline" data-retry="${esc(j.id)}">从检查点重试</button>`}</div><details><summary>候选、来源与证据缺口（${(c.candidates||[]).length}）</summary>${(c.candidates||[]).map((x,i)=>`<div class="candidate"><strong>${esc(x.title)}</strong><br><span>${esc(statusNames[x.status]||x.status)} · ${esc(x.source)} · ${esc(x.publication_status)}</span><p>${esc(x.reason||x.relevance_reason||'')}</p>${!['running','queued'].includes(j.status)&&['no_fulltext','unverified','pending'].includes(x.status)?`<label class="field">补充正文 PDF<input type="file" accept=".pdf,application/pdf" data-upload-job="${esc(j.id)}" data-index="${i}"></label>`:''}</div>`).join('')}${bullet(c.diagnostics)}<pre>${esc(JSON.stringify(c.search_log||[],null,2))}</pre></details></article>`;}).join(''):'<div class="empty"><h3>还没有分析批次</h3><p>选择一个课题，确认研究范围后启动分析。示例模式不调用真实 API。</p></div>');
  $('refreshJobs').onclick=async()=>{if(state.demo){toast('示例模式没有后台任务');return;}try{await loadProject();}catch(e){toast(e.message);}};
  $('alternate').querySelectorAll('[data-cancel],[data-retry]').forEach(b=>b.onclick=busy(async()=>{await api(`/api/jobs/${b.dataset.cancel||b.dataset.retry}/${b.dataset.cancel?'cancel':'retry'}`,{method:'POST'});await loadProject();}));
  $('alternate').querySelectorAll('[data-upload-job]').forEach(input=>input.onchange=async()=>{if(!input.files[0])return;try{input.disabled=true;const form=new FormData();form.append('file',input.files[0]);await api(`/api/jobs/${input.dataset.uploadJob}/candidates/${input.dataset.index}/pdf`,{method:'POST',body:form});toast('正文已上传，请从检查点重试以核对身份并分析');}catch(e){toast(e.message);}finally{input.disabled=false;}});
}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
$('export').onclick=async()=>{if(!requireService())return;if(!state.project)return;try{const kind=$('exportKind').value;download(await api(`/api/projects/${state.project.id}/export?kind=${kind}`,{binary:true}),kind==='json'?'papers.json':`research-${kind}.zip`);}catch(e){toast(e.message);}};
for(const id of ['search','tagFilter','dateFilter','priorityFilter','statusFilter'])$(id).addEventListener('input',renderPapers);
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{state.view=b.dataset.view;document.querySelectorAll('[data-view]').forEach(t=>{t.classList.toggle('active',t===b);t.setAttribute('aria-selected',String(t===b));});renderPapers();});
document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{state.nav=b.dataset.nav;render();});
$('projectSelect').onchange=async()=>{state.project=state.projects.find(p=>p.id===$('projectSelect').value);try{if(state.demo)render();else await loadProject();}catch(e){toast(e.message);}};
$('connect').onclick=connectionForm;$('settings').onclick=()=>state.demo?connectionForm():settingsForm();$('newProject').onclick=newProjectForm;$('newBatch').onclick=batchForm;$('editScope').onclick=scopeForm;
$('topSettings').onclick=()=>state.demo?connectionForm():settingsForm();
$('logout').onclick=()=>{state.token='';sessionStorage.removeItem('pw-token');enterDemo();toast('已退出私人空间');};
$('help').onclick=()=>showModal('GUIDE · 使用说明','<h2>从问题到证据，再到行动</h2><p>1. 部署者将前端发布至 GitHub Pages，另部署私人分析服务。</p><p>2. 连接服务并登录，配置模型 API 与外部 Norman 技能。</p><p>3. 创建课题，上传参考 PDF 或输入课题名称，检查研究范围。</p><p>4. 运行默认五篇分析。缺全文或未核验的候选不会凑数。</p><p>5. 浏览精读证据和待执行研究行动，导出私人文献库。</p><div class="callout">模型核验不是人工复核，也不等于独立复现。研究行动卡是建议方案。</div><p>源码与部署说明随本项目提供。示例全部为合成内容。</p>');
render();
if(state.base&&state.token)loadWorkspace().catch(e=>{enterDemo();toast('私人服务暂不可用：'+e.message);});
