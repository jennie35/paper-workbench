// Pure, escaped HTML projections of saved research records; no model calls.
import {researchFlowSvg,designMap,storylineMap,evidenceActionMap} from './research-diagrams.js?v=20261024-progress1';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const rows=value=>Array.isArray(value)?value.filter(x=>x!=null):[];
// Omit empty presentation placeholders, never concrete uncertainty or limitations.
const placeholderKey=value=>value.trim().replace(/[\s，,；;：:。.!！?？]/gu,'');
const PLACEHOLDERS=new Set([
  '已取得的来源未报告或未核验，需核对原文','未报告或尚未核验；不自行补设','未记录；需补充实际来源',
  '当前来源不足以判断，需在精读中核对','未定位；需取得原文确认','尚未分开记录',
  '现有记录未重建设计决策，需从方法和讨论中核对','当前证据不足，尚无有依据的综合记录',
  '未核验；不代替作者说明','核心图表及公式尚未定位或目视核验','无法由当前来源完成原图核验',
  '待核对正文、图注、表格及公式的一致性',
  '未提供真实样本','未指定真实设备','正式研究需从全文核对',
  '已提供的来源未报告足够信息，需核对原文','证据不足时保留原判断',
].map(placeholderKey));
const placeholder=value=>{
  const s=value.trim().replace(/[。.!！]+$/u,'');
  return !s||PLACEHOLDERS.has(placeholderKey(s))||/^(?:未报告(?:或(?:尚未)?核验)?|尚未核验|未核验|未记录|未提供|无|暂无|待补充|待核对|未定位|不适用|未知|unknown|unreported|not reported|not available|not provided|not verified|not applicable|n\/?a|null|none|undefined|[-—–]+)$/iu.test(s)
    ||/^(?:not (?:reported|provided|available|verified)|unreported)(?: in| from| by)? (?:the )?(?:supplied |provided |available |current )?(?:abstract|paper|source|text|full ?text|materials?)$/iu.test(s)
    ||/^(?:(?:原文|论文|摘要|当前资料|已取得的来源|已取得来源)(?:中)?)?(?:未报告|未提供|未说明|未核验)(?:(?:具体)?(?:信息|数值|相关信息|设备(?:型号)?|样本量|统计方法|独立实验单位|参数|对照|随机化|盲法|重复次数))?$/u.test(s);
};
const content=value=>typeof value==='string'?(placeholder(value)?'':value.trim()):typeof value==='number'||typeof value==='boolean'?String(value):value==null?'':Array.isArray(value)?value.map(content).filter(Boolean).join('；'):Object.entries(value).flatMap(([key,item])=>{const text=content(item);return text?[`${key}：${text}`]:[];}).join('\n');
export const hasReportContent=value=>Boolean(content(value));
const referenceContent=value=>{
  if(Array.isArray(value))return [...new Set(value.map(referenceContent).filter(Boolean))].join('；');
  if(value&&typeof value==='object')return Object.entries(value).flatMap(([key,item])=>{const text=referenceContent(item);return text?[`${key}：${text}`]:[];}).join('\n');
  const text=content(value),s=text.trim().replace(/[。.!！]+$/u,'');
  // A generic evidence-acquisition task does not explain how a paper can help.
  if(/^(?:先|需|需要|待)?(?:取得|获取|补充|补齐|核对|确认|阅读)(?:并(?:核对|阅读|确认))?(?:论文)?(?:原文|全文)(?:方法)?(?:[，,；; ]*(?:后|再|然后|之后|后再)?(?:判断|确认|评估)(?:其|本课题)?(?:是否|能否)?(?:适用|适用性|迁移|借鉴|具有参考价值))?$/u.test(s))return '';
  return text;
};
const referenceFields=['project_reference','reference_value','topic_reference_value','project_relevance','topic_relevance','research_relevance','relevance_summary','future_insights','research_implications'];
const firstReference=(...values)=>values.map(referenceContent).find(Boolean)||'';
const transferValues=analysis=>[analysis.research_logic?.transfer_insights,analysis.research_logic?.transfer,analysis.transfer_insights,analysis.transfer].map(object).find(value=>Object.keys(value).length)||{};
// Project value is a projection of saved analysis, never generated from a title.
// Prefer a supplied topic-specific explanation over old structural defaults.
export function referenceValue(analysis){
  const a=object(analysis),logic=object(a.research_logic),transfer=transferValues(a);
  for(const key of referenceFields){
    const text=firstReference(a[key],logic[key]);if(text)return text;
  }
  const seen=new Set(),borrow=[['可以借鉴',firstReference(transfer.direct,transfer.direct_transfer)],['修改后验证',firstReference(transfer.adapt,transfer.adapt_then_validate)]].flatMap(([label,value])=>{
    const text=referenceContent(value);if(!text||seen.has(text))return [];seen.add(text);return [`${label}：${text}`];
  });
  return borrow.join('；')||referenceContent(transfer.judgement_change)||referenceContent(transfer.judgment_change);
}
const present=value=>rows(value).filter(hasReportContent);
const p=value=>hasReportContent(value)?`<p>${esc(content(value))}</p>`:'';
const list=value=>Array.isArray(value)?(present(value).length?`<ul>${present(value).map(x=>`<li>${esc(content(x))}</li>`).join('')}</ul>`:''):p(value);
const dl=values=>{const items=values.filter(([,value])=>hasReportContent(value));return items.length?`<dl>${items.map(([label,value])=>`<dt>${esc(label)}</dt><dd>${esc(content(value))}</dd>`).join('')}</dl>`:'';};
const source=value=>present(value).length?`<p class="reader-meta">来源定位：${esc(present(value).join(' · '))}</p>`:'';
const titled=(title,html)=>html?`<h3>${esc(title)}</h3>${html}`:'';
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const numberedOriginal=(kind,label)=>{
  const number='(?:[A-Z]\\.?\\d+(?:[.\\-]\\d+)*[a-z]?|\\d+(?:[.\\-]\\d+)*[a-z]?|[IVXLCDM]+|[一二三四五六七八九十百]+)(?![A-Za-z0-9])';
  const prefix={figure:'(?:fig(?:ure)?\\.?|图)',table:'(?:table|表)',equation:'(?:eq(?:uation)?\\.?|公式|式)'}[kind];
  return Boolean(prefix&&(new RegExp(prefix+'\\s*[（(]?'+number,'iu').test(label)||(kind==='equation'&&new RegExp('^[（(]?'+number+'[）)]?$','iu').test(label))));
};
export const safeOriginalImage=value=>typeof value==='string'&&value.length<=3000000&&/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)?value:'';
// Verification is supplied by the application after an image request, never by
// the language model's evidence_review status or a PDF download alone.
export function verifiedOriginals(analysis){
  const a=object(analysis),expected=a.source_metadata?.sha256||a.coverage?.pdf_sha256;
  return rows(a.visuals).map(object).filter(v=>{
    const page=Number(v.page||v.source_page),label=content(v.label||v.locator);
    return v.inspection_status==='verified'&&['vision_model','manual','visual_tool'].includes(v.inspection_method)
      &&typeof v.inspection_id==='string'&&v.inspection_id.length>0&&typeof v.inspected_at==='string'&&Number.isFinite(Date.parse(v.inspected_at))
      &&Number.isInteger(page)&&page>=1&&page<=300&&Number(v.source_page||page)===page
      &&sha(v.image_sha256)&&sha(v.source_sha256)&&(!sha(expected)||expected.toLowerCase()===v.source_sha256.toLowerCase())
      &&['figure','table','equation'].includes(v.kind||v.type)&&hasReportContent(v.explanation)
      &&numberedOriginal(v.kind||v.type,label)
      &&(v.asset_path===`assets/page-${page}.png`||v.asset_path===`assets/page-${page}.jpg`);
  });
}
export function originalsHtml(analysis,{mode='asset',mathRenderer=globalThis.temml?.renderToString}={}){
  return verifiedOriginals(analysis).map(v=>{
    const page=Number(v.page||v.source_page),data=safeOriginalImage(v.image_data_url),filename=v.asset_path.split('/').pop();
    if(mode==='embedded'&&!data)return '';
    const image=mode==='asset'?`data-asset="${esc(filename)}"`: `src="${esc(mode==='embedded'?data:v.asset_path)}"`;
    const url=(()=>{try{const u=new URL(v.source_url);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}})();
    const details=dl([['比较对象',v.comparison],['面板与坐标单位',[content(v.panels),content(v.axes_units)].filter(Boolean).join('；')],['统计单位',v.statistical_unit],['误差条',v.error_bars],['效应大小',v.effect_size],['不确定性',v.uncertainty],['正文与图注一致性',v.consistency],['公式用途',v.purpose],['符号与单位',v.symbols],['被测量',v.measurand],['适用条件',v.applicability],['解释边界',v.limitations]]);
    let formula='';
    if(hasReportContent(v.latex)){
      const latex=String(v.latex).slice(0,4000);formula=`<p class="verified-equation">\\[${esc(latex)}\\]</p>`;
      if(typeof mathRenderer==='function')try{formula=mathRenderer(latex,{displayMode:true,throwOnError:false,trust:false});}catch{/* Original page and source TeX remain available. */}
    }
    return `<div class="verified-visual" data-visual-record="${esc(v.inspection_id)}"><h3>${esc(v.label||v.locator)}</h3><p class="visual-stamp">${v.inspection_method==='vision_model'?'视觉模型核验 · 未经人工复核':'保存的实际图像查看记录'} · ${esc(v.inspected_at.slice(0,10))}</p><figure><img ${image} alt="${esc(v.label||v.locator)} · 论文原页第 ${page} 页"><figcaption>原论文 PDF 第 ${page} 页 · ${esc(v.locator||v.label)} · ${mode==='asset'?'点击放大':'保留原页供对照'}${url?` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">原文来源 ↗</a>`:''}</figcaption></figure><p class="visual-explanation">${esc(v.explanation)}</p>${formula}${details}<details><summary>来源与查看记录</summary><p>PDF SHA256：${esc(v.source_sha256)}<br>原页图像 SHA256：${esc(v.image_sha256)}<br>查看记录：${esc(v.inspection_id)}</p></details></div>`;
  }).join('');
}
const links=value=>rows(value).map(url=>{try{const u=new URL(url);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?`<li><a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a></li>`:'';}catch{return '';}}).join('');
export const STUDY_LABELS={experiment:'实验研究',experimental:'实验研究',method:'方法研究',theory:'理论研究',review:'综述研究',dataset:'数据集与基准',system:'系统研究',mixed:'混合研究',unknown:'类型未核验'};
const DESIGN_LABELS={variables:'变量',samples:'样本',experimental_unit:'独立实验单位',independent_unit:'独立实验单位',equipment:'设备',parameters:'参数',controls:'对照',randomization:'随机化',blinding:'盲法',replication:'重复层级',repeats:'重复层级',exclusion_rules:'排除规则',statistics:'统计方法',inputs_outputs:'输入与输出',inputs:'输入',outputs:'输出',baseline_fairness:'基线公平性',data_splits:'训练与测试划分',train_test_split:'训练与测试划分',leakage:'数据泄漏',data_leakage:'数据泄漏',ablations:'消融',external_validation:'外部验证',assumptions:'假设',definitions:'定义',derivation:'推导',propositions:'关键命题',applicability:'适用条件',counterexamples:'反例',search_scope:'检索范围',selection:'筛选方法',selection_method:'筛选方法',evidence_classes:'证据分类',bias:'偏倚',heterogeneity:'异质性'};
const ORIGIN_LABELS={paper_fact:'作者报告的结果',author_interpretation:'作者解释',analyst_inference:'分析者判断或推断',hypothesis:'尚待验证的假设',author:'作者说明（需来源定位）',analyst:'分析者重建',unknown:'来源尚未核验'};
Object.assign(DESIGN_LABELS,{study_type:'研究类型',repetition_levels:'重复层级',baselines_fairness:'基线公平性',ablation:'消融',derivations:'推导',key_propositions:'关键命题',evidence_classification:'证据分类',review_type:'综述类型'});

export function reportSections(paper,{flowHtml='',visualMode='asset',mathRenderer=globalThis.temml?.renderToString,coverageHtml='',currentScope=null}={}){
  const a=object(paper.analysis),r=object(a.research_logic),scope=object(r.reading_scope),story=object(r.storyline),design=object(r.study_design),layers=object(r.conclusion_layers),transfer=transferValues(a),sourcePrefix=paper.id?String(paper.id)+':':'';
  const type=design.type||r.paper_type||'unknown',sections=[],add=(id,title,html)=>{if(html)sections.push([id,title,html]);};
  const gaps=[...new Set([...present(a.verification_gaps),...present(a.unread)])];
  const verification=a.verification_status||paper.verification_status||(a.verified===true?'已记录完成核验（以实际核验记录为准）':'尚无已完成全部核验的记录');
  // Retain the actual reading boundary even when optional analysis fields are omitted.
  const scopeHtml=dl([['作者',present(paper.authors).join(' · ')],['期刊或会议',paper.journal],['首次发表日期',paper.first_publication_date],['来源登记日期',paper.publication_date],['日期核对边界',paper.first_publication_date_status||paper.publication_date_status||paper.publication_date_source],['日期差异',paper.date_differences||paper.publication_dates||[paper.online_date,paper.print_date].filter(Boolean)],['卷期年份',[paper.volume,paper.issue,paper.year].filter(Boolean).join(' · ')],['页码',paper.pages],['DOI',paper.doi],['版本与状态',paper.publication_status],['分析日期',a.analyzed_date],['实际资料',scope.acquired||scope.materials||a.coverage?.scope||a.reading_basis],['已核验内容',scope.verified||scope.verified_content],['核验范围限制',scope.unverified||scope.unverified_content||gaps]])+`<p class="reader-meta">核验状态：${esc(verification)}</p>`+coverageHtml;
  add('scope','1. 题录与阅读范围',scopeHtml);
  const context=object(a.project_context?.scope_snapshot),contextKeys=['research_question','research_object','application_context','existing_methods','known_resources','constraints'];
  const contextHtml=dl([['核心科学问题',context.research_question||context.core_question],['研究阶段',context.research_stage],['研究对象与场景',[context.research_object,context.application_context].filter(Boolean).join('；')],['已有方法或系统',context.existing_methods],['当时已知资源',context.known_resources],['当时约束',context.constraints],['资料版本差异',context.version_differences]]);
  if(contextHtml){
    const changed=currentScope&&contextKeys.some(key=>content(context[key])!==content(currentScope[key]));
    sections[0][2]+=(changed?p('当前课题条件已改变。本报告仍沿用生成时的配置，旧建议需要重新核对适用性。'):'')+`<details><summary>本报告生成时的课题条件</summary>${contextHtml}</details>`;
  }
  add('summary','2. 论文总结',p(a.summary));
  add('storyline','3. 科学问题与研究主线',storylineMap(a,hasReportContent)+dl([['作者明确问题',story.author_question],['分析者重建问题',story.reconstructed_question||a.scientific_question],['已有方法缺口',story.gap],['核心假设',story.hypothesis],['推理链',story.reasoning||story.reasoning_chain]]));
  const flow=flowHtml||(hasReportContent(a.flow_steps)?`<div class="flow">${researchFlowSvg(present(a.flow_steps),a.source_basis)}</div>`:'');
  add('flow','4. 研究流程示意',flow?p('分析者绘制，非论文原图；仅重建作者已报告工作。')+flow:'');
  const fields=object(design.fields),legacy=['variables','samples','equipment','parameters','controls','repeats','statistics'];
  const designRows=Object.keys(fields).length?Object.entries(fields).map(([key,value])=>[DESIGN_LABELS[key]||key,value]):legacy.map(key=>[DESIGN_LABELS[key],a[key]]),designHtml=dl(designRows);
  add('design','5. 重建研究设计',designHtml?(type!=='unknown'?`<p class="reader-meta">${esc(STUDY_LABELS[type]||type)}</p>`:'')+designMap(a,hasReportContent)+`<details><summary>逐项研究设计</summary>${designHtml}</details>`+(type==='review'?p('综述的证据分类与作者综合，不构成新增实验；未实施荟萃分析时不得称为荟萃分析。'):''):'');
  add('decisions','6. 关键设计决策',rows(r.design_decisions).map((row,i)=>{
    const d=object(row),details=dl([['设计选择',d.decision||d.choice],['解决的问题',d.problem],['选择理由',d.rationale],['代价',d.cost||d.tradeoff],['合理替代方案',d.alternative],['可能影响',d.possible_effect]]);
    if(!details)return '';
    return `<h3>${esc(d.id||'D'+String(i+1).padStart(2,'0'))}${hasReportContent(d.decision||d.choice)?' · '+esc(content(d.decision||d.choice)):''}</h3>`+details+(d.rationale_origin||d.origin?p('理由来源：'+(ORIGIN_LABELS[d.rationale_origin||d.origin]||'来源尚未核验')):'')+source(d.source_block_ids);
  }).join(''));
  add('visuals','7. 原图、表格与公式核验',originalsHtml(a,{mode:visualMode,mathRenderer}));
  const pitfalls=rows(r.pitfalls).map(row=>{const x=object(row),assessment=p(x.assessment||x.finding);return assessment?`<details><summary>${esc(content(x.kind||x.issue)||'证据边界')}</summary>${assessment}${source(x.source_block_ids)}</details>`:'';}).join('');
  add('evidence','8. 结论、证据与局限',evidenceActionMap(a,sourcePrefix)+dl([['作者报告的结果',layers.author_results||a.author_results],['作者解释',layers.author_interpretation||a.author_conclusions],['分析者判断或推断',layers.analyst_inference||a.analyst_inference],['尚待验证的假设',layers.unverified_hypotheses||layers.hypotheses]])+rows(a.evidence).map(row=>{
    const e=object(row),body=p(e.observation)+p(e.interpretation)+(hasReportContent(e.limits)?p('局限：'+content(e.limits)):'');
    if(!body&&!hasReportContent(e.claim))return '';
    return `<div class="evidence-block"><h3>${esc([content(e.id),content(e.claim)].filter(Boolean).join(' · ')||'证据记录')}</h3>`+(e.origin?p('信息性质：'+(ORIGIN_LABELS[e.origin]||'来源尚未核验')):'')+body+source(e.source_block_ids)+'</div>';
  }).join('')+titled('易混淆概念检查',pitfalls));
  add('reading','9. 需要重点精读的部分',rows(r.reading_priorities).map(row=>{
    const x=object(row),details=dl([['精读原因',x.reason],['影响的研究判断',x.decision_impact||x.judgement_impact]]),locator=content(x.locator||x.section);
    if(!details&&!locator)return '';
    return `<h3>${esc(locator||'精读项')}${x.kind?' · '+esc(({section:'章节',figure:'原图',table:'表格',equation:'公式',detail:'实验细节',code:'代码'})[x.kind]||x.kind):''}</h3>`+details+source(x.source_block_ids);
  }).join('')||list(a.reading_list));
  const insightTexts=new Set(),once=value=>{const text=content(value);if(!text||insightTexts.has(text))return '';insightTexts.add(text);return text;};
  const referenceHtml=referenceFields.flatMap(key=>[a[key],r[key]]).map(value=>p(once(value))).join('')+dl([['可以直接借鉴',firstReference(transfer.direct,transfer.direct_transfer)],['需要修改后验证',firstReference(transfer.adapt,transfer.adapt_then_validate)],['目前不宜迁移',transfer.avoid||transfer.not_transferable],['如何改变本课题判断',transfer.judgement_change||transfer.judgment_change]].map(([label,value])=>[label,once(value)]));
  add('future','10. 未来研究启示',titled('对本课题的参考借鉴',referenceHtml)+titled('迁移条件',p(a.transfer_conditions))+titled('复现检查清单',list(a.reproduction_checklist)));
  const actionCards=rows(a.actions||r.actions).map((row,i)=>{
    const x=object(row),details=dl([['证据缺口',x.gap],['待回答问题',x.question],['可被否定的假设',x.hypothesis],['方法与数据',x.method],['独立实验单位',x.experimental_unit],['所需数据',x.data],['基线与对照',x.controls],['混杂控制',x.confounds],['支持方向',x.supporting],['削弱或否定方向',x.weakening],['判断依据',x.criteria_basis||x.decision_rule],['样本量与阈值依据',x.sample_size_basis],['资源条件',x.resources],['前置条件',x.prerequisites],['交付成果',x.deliverable],['停止条件',x.stopping_criteria||x.stopping_condition]]);
    if(!details&&!hasReportContent(x.title))return '';
    return `<h3>${esc(x.id||'A'+(i+1))}${hasReportContent(x.title||x.question)?' · '+esc(content(x.title||x.question)):''}${hasReportContent(x.priority)?` <span class="tag priority">${esc(x.priority)}</span>`:''}</h3><p class="reader-meta">待执行${present(x.evidence_ids).length?' · 依据证据：'+esc(present(x.evidence_ids).join(' · ')):''}</p>`+details;
  }).join(''),roadmap=p(a.roadmap||a.action_status);
  add('actions','11. 下一步研究规划与行动卡',actionCards||roadmap?p('以下均为待执行方案。样本量、阈值与允许误差须依据原文或先导实验确定。')+actionCards+roadmap:'');
  const sourceLinks=links(a.sources);
  const blocks=rows(a.source_blocks).filter(block=>hasReportContent(block.id)&&hasReportContent(block.text));
  add('sources','来源与核验边界',(sourceLinks?`<ul>${sourceLinks}</ul>`:'')+list(gaps)+blocks.map(block=>`<details id="source-${esc(encodeURIComponent(sourcePrefix+String(block.id)))}"><summary>${esc(block.id)}${hasReportContent(block.locator)?' · '+esc(block.locator):''}</summary><p>${esc(block.text)}</p></details>`).join(''));
  return sections;
}

export function synthesisHtml(value){
  const s=object(value),card=(title,items,render)=>{const html=rows(items).map(render).join('');return titled(title,html);};
  const body=card('相互支持的结论',s.supports||s.agreements,row=>{const x=object(row),body=p(x.claim)+p(x.reason);return body?`<div class="synthesis-item">${body}${source(x.record_ids||x.paper_ids)}</div>`:'';})+
    card('冲突及可能原因',s.conflicts,row=>{const x=object(row),body=p(x.claim||x.issue)+dl([['可能原因',x.possible_causes],['需要补充的证据',x.needed_evidence]]);return body?`<div class="synthesis-item">${body}${source(x.record_ids||x.paper_ids)}</div>`:'';})+
    card('改变了哪些研究判断',s.judgement_changes||s.judgment_changes,row=>{const x=object(row),body=dl([['原判断',x.before],['更新后的判断',x.after],['依据',x.reason]]);return body?body+source(x.record_ids||x.paper_ids):'';})+
    card('优先验证的 1—3 项行动',rows(s.priority_actions||s.prioritized_actions).slice(0,3),row=>{const x=object(row),details=dl([['先做的理由',x.reason],['科学价值',x.scientific_value],['证据缺口',x.evidence_gap],['资源可行性',x.feasibility],['验证成本',x.validation_cost]]),label=[content(x.record_id||x.paper_id),content(x.action_id||x.title)].filter(Boolean).join(' · ');return details||label?`<div class="synthesis-action">${label?`<strong>${esc(label)}</strong>`:''}<span class="tag">待执行</span>${details}</div>`:'';})+
    card('暂缓、补证据或放弃的路线',s.route_decisions,row=>{const x=object(row),body=p(x.route)+p(({hold:'暂缓',need_evidence:'补证据',abandon:'放弃'})[x.decision]||x.decision)+p(x.reason);return body?`<div class="synthesis-item">${body}${source(x.record_ids||x.paper_ids)}</div>`:'';})+
    titled('综合覆盖与局限',p(s.coverage_note)+list(s.limitations));
  if(!body)return '';
  const metadata=[present(s.record_ids||s.source_paper_ids).length?'关联文献：'+present(s.record_ids||s.source_paper_ids).join(' · '):'',hasReportContent(s.created_at)?'更新：'+content(s.created_at):''].filter(Boolean).join('；');
  return `<p class="reader-meta">跨论文综合是分析者判断。排序依据科学价值、证据缺口、资源可行性与验证成本，不是论文质量排名。</p>`+body+(metadata?`<p class="reader-meta">${esc(metadata)}</p>`:'');
}
