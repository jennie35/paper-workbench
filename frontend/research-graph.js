// A graph is a projection of supplied relationships. This module never infers citations.
import cytoscape from './vendor/cytoscape/cytoscape.esm.min.mjs';
import {referenceValue,hasReportContent} from './research-view.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const list=value=>Array.isArray(value)?value:[];
const text=value=>typeof value==='string'?value.trim():'';
const finite=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
const count=value=>finite(value)&&Number(value)>=0?Math.floor(Number(value)):null;
export const MAX_GRAPH_NODES=200;
export const graphQueryLimit=value=>Math.max(1,Math.min(MAX_GRAPH_NODES,count(value)??50));
const labels={direct_citation:'直接引用',shared_references:'共同参考文献',co_citation:'共同被引',semantic_similarity:'计算的主题相似性'};
const readingLabel=value=>({completed:'正文核心报告',core_ready:'正文核心报告',processing:'报告整理中',unverified:'已保存分析',no_fulltext:'等待论文正文',recorded:'已入库',candidate:'候选文献',synthetic:'合成演示',partial:'分析草稿',abstract:'摘要候选'}[value]||value);
const aliases={citation:'direct_citation',direct:'direct_citation',bibliographic_coupling:'shared_references',semantic:'semantic_similarity',topic_similarity:'semantic_similarity'};
const relation=value=>labels[value]?value:aliases[value]||'';
const short=(value,n=62)=>Array.from(String(value??'')).slice(0,n).join('')+(Array.from(String(value??'')).length>n?'…':'');
const anchorId=value=>'graph-paper-'+Array.from(String(value)).map(char=>char.codePointAt(0).toString(16)).join('-');
const plain=value=>typeof value==='string'?value:typeof value==='number'?String(value):Array.isArray(value)?value.map(plain).filter(Boolean).join(' · '):Object.entries(object(value)).map(([key,item])=>`${key}：${plain(item)}`).filter(x=>!x.endsWith('：')).join('；');
export const graphRelationLabels=Object.freeze({...labels});
export function safePaperUrl(value){try{const url=new URL(value);return /^https?:$/.test(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}}
function normalizedNode(value,index){
  const node=object(value),paper=object(node.paper),a=object(node.analysis||paper.analysis),id=text(String(node.id??node.paper_id??paper.id??''));
  if(!id||id.length>200)return null;
  const title=text(node.title||paper.title);if(!title)return null;
  const year=count(node.year??paper.year),status=text(node.reading_status||node.status||a.verification_status)||(node.candidate?'candidate':'recorded');
  return {...node,id,title,title_en:text(node.title_en||paper.title_en),paper_id:node.paper_id??paper.id??(node.candidate?null:id),authors:list(node.authors||paper.authors).map(x=>typeof x==='string'?x:text(x?.name)).filter(Boolean),year:year!==null&&year>=1000&&year<=2200?year:null,citation_count:count(node.citation_count??node.cited_by_count??paper.citation_count),reading_status:status,candidate:Boolean(node.candidate||id.startsWith('candidate:')),doi:text(node.doi||paper.doi),url:safePaperUrl(node.url||paper.url),summary:text(node.summary||a.summary),scientific_question:text(node.scientific_question||a.scientific_question||a.research_logic?.storyline?.author_question),author_results:text(node.author_results||a.author_results||a.research_logic?.conclusion_layers?.author_results),reference_value:text(node.reference_value)||referenceValue(a),evidence:list(node.evidence||a.evidence).filter(x=>x&&typeof x==='object'&&hasReportContent(x.claim)).slice(0,5),index};
}
export function normalizeGraph(payload={}){
  const p=object(payload),seen=new Set(),nodes=list(p.nodes).flatMap((item,index)=>{const node=normalizedNode(item,index);if(!node||seen.has(node.id))return [];seen.add(node.id);return [node];});
  const edgeIds=new Set(),edges=list(p.edges).flatMap((item,index)=>{
    const edge=object(item),source=String(edge.source??''),target=String(edge.target??''),type=relation(edge.type||edge.relation),rawId=String(edge.id||`${type}:${source}:${target}:${index}`),id=seen.has(rawId)?`edge:${rawId}:${index}`:rawId;
    if(!type||source===target||!seen.has(source)||!seen.has(target)||edgeIds.has(id))return [];
    edgeIds.add(id);return [{...edge,id,source,target,type,weight:finite(edge.weight)&&Number(edge.weight)>=0?Number(edge.weight):1,directed:type==='direct_citation',basis:object(edge.basis),source_records:list(edge.source_records),retrieved_at:text(edge.retrieved_at),algorithm_version:text(edge.algorithm_version)}];
  });
  const table=value=>list(value).map((node,index)=>normalizedNode(node,index)).filter(Boolean);
  return {...p,view:p.view==='semantic'?'semantic':'citation',relation:relation(p.relation)||'direct_citation',nodes,edges,prior_works:table(p.prior_works),derivative_works:table(p.derivative_works),total_nodes:Math.max(nodes.length,count(p.total_nodes)||0),limit:graphQueryLimit(p.limit),notices:list(p.notices).map(plain).filter(Boolean),availability:object(p.availability)};
}
export function graphNodeAppearance(node,nodes=[]){
  const years=nodes.map(x=>x.year).filter(x=>x!==null&&Number.isFinite(x)),min=Math.min(...years),max=Math.max(...years),part=node.year===null?null:max===min?.6:(node.year-min)/(max-min);
  const shade=part===null?'#e4e4e2':`rgb(${Math.round(202-153*part)}, ${Math.round(210-145*part)}, ${Math.round(219-132*part)})`;
  const citations=count(node.citation_count),size=citations===null?23:Math.min(44,18+Math.log2(citations+1)*3.4);
  return {color:shade,size:Math.round(size*10)/10,unknown_year:part===null,unknown_citations:citations===null,border:node.candidate?'#997d61':/complet|verified|core_ready/u.test(node.reading_status)?'#3c6657':'#8b8e96',border_style:node.candidate||citations===null?'dashed':'solid'};
}
export function graphElements(payload,{view,relation:edgeType,search='',limit=50,selectedId=''}={}){
  const graph=normalizeGraph(payload),mode=view||graph.view,type=relation(edgeType)||graph.relation,q=text(search).toLocaleLowerCase();
  const matching=graph.nodes.filter(node=>!q||[node.title,node.title_en,node.id,...node.authors].join(' ').toLocaleLowerCase().includes(q));
  const nodes=matching.slice(0,graphQueryLimit(limit)),ids=new Set(nodes.map(x=>x.id));
  const edges=graph.edges.filter(edge=>ids.has(edge.source)&&ids.has(edge.target)&&(mode==='semantic'?edge.type==='semantic_similarity':edge.type===type));
  return {nodes,edges,elements:[...nodes.map((node,index)=>{const style=graphNodeAppearance(node,graph.nodes),angle=index*2*Math.PI/Math.max(nodes.length,1);return {group:'nodes',data:{id:node.id,label:short(node.id.replace(/^candidate:/,''),12),title:short(node.title,19),color:style.color,size:style.size,border:style.border,borderStyle:style.border_style},classes:node.id===selectedId?'selected-paper':'',position:{x:400+240*Math.cos(angle),y:300+230*Math.sin(angle)}};}),...edges.map(edge=>({group:'edges',data:{...edge,label:labels[edge.type],strength:Math.min(5,1+Math.log2(edge.weight+1)),arrow:edge.directed?'triangle':'none'},classes:edge.type==='semantic_similarity'?'semantic-edge':''}))]};
}
export function graphLayout(nodeCount){
  if(nodeCount<=8)return {name:'circle',radius:Math.max(105,nodeCount*23),avoidOverlap:true,nodeDimensionsIncludeLabels:false,spacingFactor:1.25,fit:false,animate:false};
  return {name:'cose',randomize:false,animate:false,fit:false,padding:48,nodeDimensionsIncludeLabels:false,nodeOverlap:35,componentSpacing:100,nodeRepulsion:()=>24000,idealEdgeLength:()=>155,edgeElasticity:()=>80,gravity:.12,numIter:900};
}
const field=(label,value)=>hasReportContent(value)?`<div><dt>${esc(label)}</dt><dd>${esc(plain(value))}</dd></div>`:'';
function edgeHtml(edge,nodes){
  const names=new Map(nodes.map(node=>[node.id,node.title]));
  return `<article class="graph-edge-record"><p class="graph-kicker">${esc(labels[edge.type])}</p><h4>${esc(names.get(edge.source)||edge.source)} ${edge.directed?'→':'↔'} ${esc(names.get(edge.target)||edge.target)}</h4><dl>${field('关系依据',edge.basis)}${field(edge.type==='semantic_similarity'?'相似度':'权重',edge.weight)}${field('来源记录',edge.source_records)}${field('取得时间',edge.retrieved_at)}${field('算法版本',edge.algorithm_version)}</dl><p class="graph-note">${edge.type==='semantic_similarity'?'根据实际保存的内容向量计算；不表示引用、因果或结论相互支持。':'关系依据来自当前检索和保存的参考文献记录；不代表全文已读或科学结论已核实。'}</p></article>`;
}
function nodeHtml(node,{snapshot=false,reportHref}={}){
  const link=safePaperUrl(node.url)||(node.doi?safePaperUrl(`https://doi.org/${node.doi}`):'');
  const proposedHref=reportHref?String(reportHref(node.paper_id||node.id)):`#paper-${encodeURIComponent(node.paper_id||node.id)}`;
  const href=/^(?:#|\.\.?\/|\/[^/])/.test(proposedHref)?proposedHref:safePaperUrl(proposedHref)||`#paper-${encodeURIComponent(node.paper_id||node.id)}`;
  return `<article class="graph-paper-detail"><p class="graph-kicker">${esc(node.id)} · ${node.candidate?'候选文献':esc(readingLabel(node.reading_status))}${node.year!==null?` · ${node.year}`:''}</p><h3>${esc(node.title)}</h3>${node.title_en?`<p class="graph-title-en">${esc(node.title_en)}</p>`:''}<p class="graph-note">${esc(node.authors.join(' · '))}</p><dl>${field('科学问题',node.scientific_question)}${field('主要发现',node.author_results||node.summary)}${field('对本课题的参考借鉴',node.reference_value)}${field('来源记录的被引次数',node.citation_count)}</dl>${node.evidence.length?`<h4>已保存的关键证据</h4><ul class="graph-evidence">${node.evidence.slice(0,3).map(item=>`<li><b>${esc(item.id||'')}</b> ${esc(item.claim)}${list(item.source_block_ids).length?`<small>来源：${esc(item.source_block_ids.join(' · '))}</small>`:''}</li>`).join('')}</ul>`:''}<div class="graph-detail-actions">${node.paper_id&&!node.candidate?(snapshot?`<a href="${esc(href)}">查看完整报告 →</a>`:`<button type="button" data-graph-action="report" data-id="${esc(node.paper_id)}">查看完整报告 →</button>`):''}${link?`<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">原文来源 ↗</a>`:''}${!snapshot?`<button type="button" data-graph-action="expand" data-id="${esc(node.id)}">发现相关文献</button>`:''}</div></article>`;
}
function tableHtml(rows,title,kind,{snapshot=false}={}){
  return `<section class="graph-works" aria-label="${esc(title)}"><h3>${esc(title)} <small>${rows.length}</small></h3><p class="graph-note">${kind==='prior'?'按当前图谱中保存的共同引用记录整理的背景研究。':'按当前检索范围内引用图谱文献的记录整理的后续研究。'}${!rows.length?' 当前没有可追溯的关系记录。':''}</p>${rows.length?`<div class="graph-table-scroll"><table><thead><tr><th scope="col">论文</th><th scope="col">年份</th><th scope="col">关系记录数</th></tr></thead><tbody>${rows.map(node=>`<tr><td>${snapshot?esc(node.title):`<button type="button" data-graph-action="select" data-id="${esc(node.id)}">${esc(node.title)}</button>`}</td><td>${node.year??'—'}</td><td>${count(node.count??node.shared_count??node.citation_count_in_graph)??'—'}</td></tr>`).join('')}</tbody></table></div>`:''}</section>`;
}

/** The optional onQuery({view,relation,limit}) must return a fresh graph payload.
 * onExpand(id,query) may return a fresh graph payload after adding only candidates.
 * A render() never sends requests. All requests go through these caller-owned hooks. */
export function createGraphView({container,onOpenReport=()=>{},onExpand,onQuery}={}){
  if(!container||typeof container.addEventListener!=='function')throw new TypeError('A graph container is required');
  let graph=normalizeGraph(),cy=null,selectedId='',edgeId='',mode='citation',edgeType='direct_citation',limit=50,search='',mobilePane='graph',tablePane='',pending=false,message='',destroyed=false,sequence=0,lastCanvasWidth=0;
  const doc=container.ownerDocument,win=doc.defaultView;
  const buttons=(active,value,label)=>`<button type="button" data-graph-action="${active}" data-value="${value}" aria-pressed="${active==='view'?mode===value:mobilePane===value}">${label}</button>`;
  function detail(node){const panel=container.querySelector('[data-graph-detail]');if(panel)panel.innerHTML=edgeId?edgeHtml(graph.edges.find(x=>x.id===edgeId)||{},graph.nodes):node?nodeHtml(node):'<p class="graph-note">选择论文查看研究问题、课题借鉴与关键证据。</p>';}
  function select(id,{mobile=false}={}){
    const node=[...graph.nodes,...graph.prior_works,...graph.derivative_works].find(x=>x.id===id);if(!node)return;
    selectedId=id;edgeId='';detail(node);container.querySelectorAll('[data-graph-action="select"]').forEach(el=>{el.setAttribute('aria-current',el.dataset.id===id?'true':'false');});
    if(cy){cy.nodes().removeClass('selected-paper');cy.$id(id).addClass('selected-paper');}
    if(mobile){mobilePane='detail';applyMobile();}
  }
  function fitGraph(){if(!cy)return;cy.resize();if(cy.width()<30||cy.height()<30)return;cy.fit(undefined,48);if(cy.zoom()>1)cy.zoom(1);cy.center();lastCanvasWidth=cy.width();}
  function applyMobile(){container.dataset.graphPane=mobilePane;container.querySelectorAll('[data-graph-action="pane"]').forEach(el=>el.setAttribute('aria-pressed',el.dataset.value===mobilePane));if(mobilePane==='graph'){cy?.resize();if(cy&&Math.abs(cy.width()-lastCanvasWidth)>30)fitGraph();}}
  function visible(){return graphElements(graph,{view:mode,relation:edgeType,search,limit,selectedId});}
  function mountCanvas(){
    cy?.destroy();cy=null;
    const target=container.querySelector('[data-graph-canvas]'),shown=visible();if(!target||!shown.nodes.length)return;
    try{
      cy=cytoscape({container:target,elements:shown.elements,wheelSensitivity:.12,minZoom:.15,maxZoom:1.6,boxSelectionEnabled:false,layout:graphLayout(shown.nodes.length),style:[{selector:'node',style:{'label':'data(label)','background-color':'data(color)','width':'data(size)','height':'data(size)','border-color':'data(border)','border-style':'data(borderStyle)','border-width':2,'color':'#525c69','font-size':10,'font-family':'system-ui,sans-serif','text-wrap':'wrap','text-max-width':110,'text-valign':'bottom','text-margin-y':7,'text-background-opacity':.9,'text-background-color':'#fafaf7','text-background-padding':'2px'}},{selector:'edge',style:{'width':'data(strength)','line-color':'#a1adb8','target-arrow-color':'#768797','target-arrow-shape':'data(arrow)','arrow-scale':1.1,'curve-style':'bezier','opacity':.85}},{selector:'.semantic-edge',style:{'line-style':'dashed','line-color':'#9e8f7c'}},{selector:'.selected-paper',style:{'label':'data(title)','font-size':11,'text-max-width':135,'color':'#252a35','border-width':3,'border-color':'#171e2a','overlay-opacity':.06,'overlay-color':'#c1c6c9','overlay-padding':5}},{selector:'.hover-paper',style:{'label':'data(title)','font-size':11,'text-max-width':135,'color':'#252a35','z-index':10}},{selector:'edge:selected',style:{'line-color':'#785f4d','target-arrow-color':'#785f4d','opacity':1}}]});
      cy.on('tap','node',event=>select(event.target.id(),{mobile:true}));
      cy.on('tap','edge',event=>{edgeId=event.target.id();detail();mobilePane='detail';applyMobile();});
      cy.on('mouseover','node',event=>{event.target.addClass('hover-paper');if(!edgeId)detail(graph.nodes.find(x=>x.id===event.target.id()));});
      cy.on('mouseout','node',event=>{event.target.removeClass('hover-paper');detail(graph.nodes.find(x=>x.id===selectedId));});
      fitGraph();const mounted=cy;win?.requestAnimationFrame?.(()=>{if(cy===mounted&&!destroyed)fitGraph();});
    }catch{target.innerHTML='<p class="graph-canvas-error">图谱画布暂不可用。可使用左侧文献列表和下方关系记录浏览全部内容。</p>';}
  }
  function paint({focusSearch=false}={}){
    if(destroyed)return;
    const shown=visible(),selected=graph.nodes.find(x=>x.id===selectedId)||shown.nodes[0];if(selected)selectedId=selected.id;
    const availability=graph.availability.available===false?plain(graph.availability.reason):'';
    const isSynthetic=graph.synthetic||graph.demo;
    container.classList.add('research-graph');container.dataset.graphPane=mobilePane;
    container.innerHTML=`<header class="graph-heading"><div><p class="graph-kicker">RELATION ATLAS · 文献关系</p><h2>从一篇论文，找到研究联系</h2></div><p class="graph-note">引用记录与主题相似分开展示；关系不等于结论得到支持。</p></header>${isSynthetic?'<p class="graph-synthetic">合成演示数据 · 不代表真实论文或真实引用关系</p>':''}<div class="graph-toolbar"><div class="graph-view-tabs" role="group" aria-label="图谱类型">${buttons('view','citation','引用关系')}${buttons('view','semantic','主题相似')}</div>${mode==='citation'?`<label>关系类型 <select data-graph-relation aria-label="引用关系类型">${Object.entries(labels).filter(([key])=>key!=='semantic_similarity').map(([key,label])=>`<option value="${key}"${edgeType===key?' selected':''}>${label}</option>`).join('')}</select></label>`:'<span class="graph-note">计算的主题相似性 · 非引用关系</span>'}<span class="graph-count">${shown.nodes.length} / ${graph.total_nodes} 篇 · ${shown.edges.length} 条关系</span></div><div class="graph-mobile-tabs" role="group" aria-label="图谱面板">${buttons('pane','list','文献')}${buttons('pane','graph','图谱')}${buttons('pane','detail','详情')}</div><p class="graph-status" role="status" aria-live="polite">${esc(pending?'正在读取关系数据…':message||availability||graph.notices.join('；'))}</p><div class="graph-workspace"><aside class="graph-paper-list" aria-label="图谱文献列表"><label class="graph-search-label">查找图中文献<input type="search" data-graph-search value="${esc(search)}" placeholder="标题、作者或编号" aria-label="搜索图谱文献"></label><ol>${shown.nodes.map(node=>`<li><button type="button" data-graph-action="select" data-id="${esc(node.id)}" aria-current="${node.id===selectedId}"><span>${esc(node.id)}${node.candidate?' · 候选':''}</span><strong>${esc(node.title)}</strong><small>${node.year??'年份未知'} · ${node.citation_count===null?'被引数据未知':`被引 ${node.citation_count}`}</small></button></li>`).join('')}</ol>${limit<MAX_GRAPH_NODES&&shown.nodes.length<Math.min(graph.total_nodes,MAX_GRAPH_NODES)?'<button type="button" class="graph-more" data-graph-action="more">再展示 50 篇</button>':''}${!shown.nodes.length?'<p class="graph-note">当前范围没有文献。可导入题录，或调整搜索词。</p>':''}</aside><section class="graph-center" aria-label="文献关系图谱"><div class="graph-canvas-controls" role="group" aria-label="图谱视角"><button type="button" data-graph-action="zoom-in" aria-label="放大图谱">＋</button><button type="button" data-graph-action="zoom-out" aria-label="缩小图谱">−</button><button type="button" data-graph-action="fit">居中</button></div><div class="graph-canvas" data-graph-canvas role="img" aria-label="${esc(mode==='semantic'?'主题相似图谱':'引用关系图谱')}；可使用文献列表和关系记录访问等同内容"></div>${!shown.edges.length?'<p class="graph-empty">当前范围尚无这种关系的可追溯记录。文献仍可阅读，系统不会补造连线。</p>':''}<div class="graph-legend"><span><i class="graph-year-scale"></i>较早 → 较新</span><span>● 大小：来源记录的被引次数</span><span>◌ 虚线边框：候选或被引数据未知</span><span>灰色：年份未知</span></div></section><aside class="graph-detail" data-graph-detail aria-label="论文与关系详情" aria-live="polite">${selected?nodeHtml(selected):'<p class="graph-note">选择论文查看详情。</p>'}</aside></div><div class="graph-table-tabs" role="group" aria-label="关系浏览"><button type="button" data-graph-action="table" data-value="edges" aria-pressed="${tablePane==='edges'}">关系依据 ${shown.edges.length}</button><button type="button" data-graph-action="table" data-value="prior" aria-pressed="${tablePane==='prior'}">前序研究 ${graph.prior_works.length}</button><button type="button" data-graph-action="table" data-value="derivative" aria-pressed="${tablePane==='derivative'}">后续研究 ${graph.derivative_works.length}</button></div><section class="graph-tables">${tablePane==='prior'?tableHtml(graph.prior_works,'前序研究','prior'):tablePane==='derivative'?tableHtml(graph.derivative_works,'后续研究','derivative'):tablePane==='edges'?`<div class="graph-edges-accessible">${shown.edges.map(edge=>`<button type="button" data-graph-action="edge" data-id="${esc(edge.id)}">${esc(edge.source)} ${edge.directed?'→':'↔'} ${esc(edge.target)} · ${esc(labels[edge.type])}</button>`).join('')||'<p class="graph-note">没有可显示的关系记录。</p>'}</div>`:''}</section>`;
    container.querySelectorAll('button,select').forEach(el=>{if(pending&&['view','expand','more'].includes(el.dataset.graphAction))el.disabled=true;});mountCanvas();applyMobile();
    if(focusSearch){const input=container.querySelector('[data-graph-search]');input?.focus();input?.setSelectionRange?.(search.length,search.length);}
  }
  async function query(){
    if(!onQuery){paint();return;}
    const ticket=++sequence;pending=true;message='';paint();
    try{const payload=await onQuery({view:mode,relation:edgeType,limit});if(ticket!==sequence||destroyed)return;if(payload){graph=normalizeGraph(payload);mode=graph.view;edgeType=graph.relation;limit=Math.max(limit,graph.limit);}}catch(error){if(ticket===sequence)message=`关系数据读取失败：${error?.message||'请重试'}`;}finally{if(ticket===sequence&&!destroyed){pending=false;paint();}}
  }
  async function click(event){
    const button=event.target.closest?.('[data-graph-action]');if(!button||!container.contains(button)||button.disabled)return;
    const action=button.dataset.graphAction,id=button.dataset.id,value=button.dataset.value;
    if(action==='select'){select(id,{mobile:true});return;}
    if(action==='report'){onOpenReport(id);return;}
    if(action==='pane'){mobilePane=value;applyMobile();return;}
    if(action==='view'){mode=value;edgeId='';await query();return;}
    if(action==='more'){if(limit>=MAX_GRAPH_NODES)return;limit=graphQueryLimit(limit+50);await query();return;}
    if(action==='table'){tablePane=tablePane===value?'':value;paint();return;}
    if(action==='edge'){edgeId=id;detail();mobilePane='detail';applyMobile();return;}
    if(action==='fit'){fitGraph();return;}
    if(action==='zoom-in'||action==='zoom-out'){if(cy)cy.zoom({level:Math.max(.15,Math.min(1.6,cy.zoom()*(action==='zoom-in'?1.25:.8))),renderedPosition:{x:cy.width()/2,y:cy.height()/2}});return;}
    if(action==='expand'){
      if(!onExpand){message='发现更多文献需要连接私人后台；当前图谱保留已保存记录。';paint();return;}
      const ticket=++sequence;pending=true;message='';paint();
      try{const result=await onExpand(id,{view:mode,relation:edgeType,limit});if(ticket!==sequence||destroyed)return;if(Array.isArray(result?.nodes)){graph=normalizeGraph(result);message='已更新候选文献；候选不计入已完成报告。';}else{message=result?.notice||'已发现候选文献；候选不计入已完成报告。';if(onQuery){const fresh=await onQuery({view:mode,relation:edgeType,limit});if(ticket!==sequence||destroyed)return;if(fresh)graph=normalizeGraph(fresh);}}}catch(error){if(ticket===sequence)message=`发现相关文献失败：${error?.message||'请重试'}`;}finally{if(ticket===sequence&&!destroyed){pending=false;paint();}}
    }
  }
  const change=event=>{if(event.target.matches('[data-graph-relation]')){edgeType=event.target.value;edgeId='';void query();}};
  const input=event=>{if(event.target.matches('[data-graph-search]')){search=event.target.value;paint({focusSearch:true});}};
  container.addEventListener('click',click);container.addEventListener('change',change);container.addEventListener('input',input);
  const resize=()=>{cy?.resize();if(cy&&Math.abs(cy.width()-lastCanvasWidth)>30)fitGraph();};const observer=typeof win?.ResizeObserver==='function'?new win.ResizeObserver(resize):null;observer?.observe(container);
  return {render(payload){if(destroyed)return;sequence++;pending=false;graph=normalizeGraph(payload);mode=graph.view;edgeType=graph.relation;limit=graph.limit;message='';paint();},destroy(){destroyed=true;sequence++;observer?.disconnect();cy?.destroy();cy=null;container.removeEventListener('click',click);container.removeEventListener('change',change);container.removeEventListener('input',input);container.innerHTML='';container.classList.remove('research-graph');delete container.dataset.graphPane;},getState(){return {view:mode,relation:edgeType,limit,selected_id:selectedId};}};
}

export const graphSnapshotStyle=`.graph-snapshot{margin:2em 0;padding:20px;border:1px solid #d7d9db;background:#fbfbf8}.graph-snapshot svg{width:100%;height:auto;max-height:680px}.graph-snapshot details{margin:12px 0}.graph-snapshot summary{cursor:pointer}.graph-snapshot dl{display:grid;gap:10px}.graph-snapshot dt{font-size:12px;color:#686d77}.graph-snapshot dd{margin:4px 0 0;white-space:pre-wrap}.graph-snapshot table{width:100%;border-collapse:collapse}.graph-snapshot th,.graph-snapshot td{padding:10px;text-align:left;border-bottom:1px solid #dedfe1}.graph-snapshot .graph-note,.graph-snapshot small{color:#686d77;font-size:12px}.graph-snapshot .graph-detail-actions{display:flex;gap:16px;flex-wrap:wrap}.graph-snapshot .graph-paper-detail h3{font-size:20px}.graph-snapshot .graph-kicker{font-size:11px;color:#786552}@media(max-width:600px){.graph-snapshot{padding:12px}.graph-snapshot th,.graph-snapshot td{padding:6px}}`;

const identityKeys=paper=>[paper.id,paper.paper_id,paper.openalex_id,paper.source_id,...Object.values(object(paper.source_ids)),paper.doi?`doi:${paper.doi}`:''].map(value=>String(value||'').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//,'doi:')).filter(Boolean);
const referenceKey=value=>{
  if(typeof value==='string')return value.trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//,'doi:').replace(/^(10\.\d{4,9}\/)/,'doi:$1');
  const ref=object(value);return referenceKey(ref.doi?`doi:${ref.doi}`:ref.openalex_id||ref.source_id||ref.id||'');
};
/** An offline library can show only exact saved reference identifiers. No title-only matching,
 * estimated vectors, missing-reference filling, or synthetic citations are introduced. */
export function demoGraphForPapers(papers,{view='citation',relation:edgeType='direct_citation',limit=50,synthetic=false}={}){
  const raw=list(papers),allNodes=raw.map((node,index)=>normalizedNode(node,index)).filter(Boolean),nodes=allNodes.slice(0,graphQueryLimit(limit)),nodeIds=new Set(nodes.map(node=>node.id)),allIds=new Set(allNodes.map(node=>node.id)),lookup=new Map(),references=new Map();
  raw.forEach(paper=>{if(allIds.has(String(paper.id)))for(const key of identityKeys(paper)){const id=String(paper.id);lookup.set(key,lookup.has(key)&&lookup.get(key)!==id?null:id);}});
  raw.forEach(paper=>{const metadata=object(paper.source_metadata||paper.analysis?.source_metadata),refs=list(paper.referenced_works||paper.reference_ids||paper.references||metadata.referenced_works||metadata.reference_ids||metadata.references);references.set(String(paper.id),new Set(refs.map(referenceKey).filter(Boolean)));});
  const edges=[],stamp='saved-reference-ids-v1',retrievedAt='';
  for(const node of nodes)for(const ref of references.get(node.id)||[]){const target=lookup.get(ref);if(target&&target!==node.id&&nodeIds.has(target))edges.push({id:`direct:${node.id}:${target}`,source:node.id,target,type:'direct_citation',weight:1,directed:true,basis:{matched_reference_id:ref,scope:'仅当前库内已保存的精确标识'},source_records:[{paper_id:node.id,reference_id:ref}],algorithm_version:stamp,retrieved_at:retrievedAt});}
  const coCiting=new Map();
  for(const [citingId,refs] of references){const targets=[...new Set([...refs].map(ref=>lookup.get(ref)).filter(id=>nodeIds.has(id)))].sort();for(let i=0;i<targets.length;i++)for(let j=i+1;j<targets.length;j++){const key=JSON.stringify([targets[i],targets[j]]),sources=coCiting.get(key)||[];sources.push(citingId);coCiting.set(key,sources);}}
  for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
    const a=nodes[i].id,b=nodes[j].id,shared=[...(references.get(a)||[])].filter(ref=>references.get(b)?.has(ref));
    if(shared.length)edges.push({id:`shared:${a}:${b}`,source:a,target:b,type:'shared_references',weight:shared.length,directed:false,basis:{shared_reference_ids:shared,scope:'当前库记录的参考文献交集'},source_records:[a,b],algorithm_version:stamp});
    const citing=coCiting.get(JSON.stringify([a,b].sort()))||[];
    if(citing.length)edges.push({id:`co:${a}:${b}`,source:a,target:b,type:'co_citation',weight:citing.length,directed:false,basis:{citing_paper_ids:citing,scope:'仅当前库中同时引用两篇论文的记录'},source_records:citing,algorithm_version:stamp});
  }
  const type=relation(edgeType)||'direct_citation',matching=edges.filter(edge=>edge.type===type),isDemo=synthetic||(raw.length>0&&raw.every(paper=>paper.publication_status==='synthetic'));
  return normalizeGraph({view,relation:type,nodes,edges,limit,total_nodes:allNodes.length,synthetic:isDemo,availability:{available:view!=='semantic'&&matching.length>0,reason:view==='semantic'?'主题相似性需要私人后台生成中英文内容向量；当前离线记录没有已计算的相似度。':matching.length?'':'当前研究库尚未保存这种引用关系。可以连接私人后台补充来源，系统不会补造连线。'},notices:['离线关系仅依据已保存的精确参考文献标识；没有完整外部引用索引。'],prior_works:[],derivative_works:[]});
}

/** Explicitly invented relationships for the isolated UI demo only. Never call for a private library. */
export function syntheticGraphFixture(papers=[],{view='citation',relation:edgeType='direct_citation',limit=50}={}){
  const supplied=list(papers).filter(paper=>paper.publication_status==='synthetic'),base=supplied.length?supplied:[{id:'DEMO-01',title:'合成示例：研究设计与变量框架'},{id:'DEMO-02',title:'合成示例：测量协议与时空匹配'},{id:'DEMO-03',title:'合成示例：误差分解与独立验证'},{id:'DEMO-04',title:'合成示例：从证据形成可检验行动'}];
  const nodes=base.slice(0,4).map((paper,index)=>({...paper,year:2021+index,citation_count:[16,7,3,0][index],reading_status:'synthetic',summary:paper.analysis?.summary||'仅演示图谱交互，不对应真实论文或科学发现。',reference_value:referenceValue(paper.analysis)||'合成示例：先核对研究对象、实验单位和协议，再判断是否能迁移。',publication_status:'synthetic'}));
  const edges=[],add=(source,target,type,weight)=>{if(!nodes[source]||!nodes[target])return;edges.push({id:`synthetic:${type}:${source}:${target}`,source:nodes[source].id,target:nodes[target].id,type,weight,directed:type==='direct_citation',basis:{synthetic:true,description:'人工构造的演示关系；不是真实引用记录或真实计算结果'},source_records:['synthetic-ui-fixture'],algorithm_version:'synthetic-ui-fixture-v1'});};
  add(1,0,'direct_citation',1);add(2,0,'direct_citation',1);add(3,1,'direct_citation',1);add(3,2,'direct_citation',1);add(1,2,'shared_references',1);add(1,2,'co_citation',1);add(0,1,'semantic_similarity',.88);add(1,2,'semantic_similarity',.79);add(2,3,'semantic_similarity',.73);
  return normalizeGraph({synthetic:true,view,relation:edgeType,nodes,edges,limit,total_nodes:nodes.length,availability:{available:true},notices:['年份、被引数、连线均为合成演示；不代表真实学术数据。'],prior_works:nodes.length?[{...nodes[0],count:2}]:[],derivative_works:nodes.length>3?[{...nodes[3],count:2}]:[]});
}
/** Portable graph snapshot: no network, runtime dependency, inferred edge or invented citation. */
export function graphSnapshotHtml(payload,{reportHref}={}){
  const graph=normalizeGraph(payload),shown=graphElements(graph,{view:graph.view,relation:graph.relation,limit:50});if(!shown.nodes.length)return '';
  const positions=new Map(shown.nodes.map((node,index)=>{const angle=index*2*Math.PI/shown.nodes.length-Math.PI/2;return [node.id,{x:480+330*Math.cos(angle),y:335+235*Math.sin(angle)}];}));
  const lines=shown.edges.map(edge=>{const a=positions.get(edge.source),b=positions.get(edge.target),target=shown.nodes.find(node=>node.id===edge.target),radius=graphNodeAppearance(target,graph.nodes).size/2+6,distance=Math.hypot(b.x-a.x,b.y-a.y),end=edge.directed?{x:b.x-(b.x-a.x)*radius/distance,y:b.y-(b.y-a.y)*radius/distance}:b;return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}" stroke="${edge.type==='semantic_similarity'?'#9e8f7c':'#aeb8c1'}" stroke-width="${Math.min(5,1+Math.log2(edge.weight+1))}"${edge.type==='semantic_similarity'?' stroke-dasharray="5 4"':''}${edge.directed?' marker-end="url(#graph-arrow)"':''}><title>${esc(labels[edge.type])}：${esc(edge.source)} ${edge.directed?'→':'↔'} ${esc(edge.target)}</title></line>`;}).join('');
  const circles=shown.nodes.map(node=>{const p=positions.get(node.id),style=graphNodeAppearance(node,graph.nodes);return `<a href="#${anchorId(node.id)}"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${style.size/2}" fill="${esc(style.color)}" stroke="${style.border}" stroke-width="2"${style.border_style==='dashed'?' stroke-dasharray="4 3"':''}/><text x="${p.x.toFixed(1)}" y="${(p.y+style.size/2+16).toFixed(1)}" text-anchor="middle" font-size="12" fill="#303744">${esc(short(node.title,19))}</text><title>${esc(node.title)} · ${node.year??'年份未知'} · ${node.citation_count===null?'被引未知':`被引${node.citation_count}`}</title></a>`;}).join('');
  return `<section class="graph-snapshot" aria-label="保存的文献关系图谱"><h2>文献关系图谱 · ${graph.view==='semantic'?'计算的主题相似性':esc(labels[graph.relation])}</h2>${graph.synthetic||graph.demo?'<p>合成演示数据，不代表真实论文或引用关系。</p>':''}<p class="graph-note">离线快照 · 显示 ${shown.nodes.length}/${graph.total_nodes} 篇 · ${shown.edges.length} 条保存的关系。年份颜色由浅至深，被引次数决定大小；未知年份为灰色。关系不表示因果或结论得到支持。${graph.generated_at?` · 数据时间 ${esc(graph.generated_at)}`:''}</p>${graph.notices.map(notice=>`<p class="graph-note">${esc(notice)}</p>`).join('')}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 670" role="img" aria-label="保存的论文关系；点击节点定位对应记录"><defs><marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0 0 L0 6 L7 3 z" fill="#aeb8c1"/></marker></defs>${lines}${circles}</svg><details><summary>查看全部关系依据（${shown.edges.length}）</summary>${shown.edges.map(edge=>edgeHtml(edge,graph.nodes)).join('')||'<p>当前没有可追溯的关系记录。</p>'}</details>${shown.nodes.map(node=>`<details id="${anchorId(node.id)}"><summary>${esc(node.id)} · ${esc(node.title)}</summary>${nodeHtml(node,{snapshot:true,reportHref})}</details>`).join('')}${tableHtml(graph.prior_works,'前序研究','prior',{snapshot:true})}${tableHtml(graph.derivative_works,'后续研究','derivative',{snapshot:true})}</section>`;
}
