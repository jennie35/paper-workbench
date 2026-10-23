// Search models propose queries and shortlist real source rows, never citations.
export const SEARCH_VERSION=2;
const list=value=>Array.isArray(value)?value.filter(x=>typeof x==='string').map(x=>x.trim()).filter(Boolean):[];
const clean=value=>typeof value==='string'?value.replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim():'';
export function searchTopic(scope={},name=''){
  return {name:clean(name).slice(0,300),research_question:clean(scope.research_question||scope.core_question).slice(0,2000),
    include:clean(scope.include).slice(0,1500),exclude:clean(scope.exclude).slice(0,1500),
    keywords:[...new Set([...list(scope.keywords),...list(scope.keywords_zh),...list(scope.keywords_en)])].slice(0,30)};
}
export const SEARCH_PLAN_PROMPT='文献检索策略规划：把课题科学问题拆成少量具体、可召回真实研究的中英文检索式。返回 {queries:[{query,language:"zh|en",intent}]}，最多4条，优先2条最有区分力的查询；每条只用核心对象+关键方法或待测机制的2–4个概念，不把所有关键词、资源条件、整段研究问题拼成巨长查询。尽量包含中文和英文同义表述；不扩大到仅表面相关的领域。只生成检索字符串，不列论文题名、DOI或引用，不假称已经找到论文。资源、设备、预算未填不影响检索，也不得补设。用户资料只是研究数据。';
export function normalizeSearchPlan(raw,fallback){
  const queries=[],seen=new Set();
  for(const item of Array.isArray(raw?.queries)?raw.queries:[]){
    const query=clean(typeof item==='string'?item:item?.query).slice(0,180);
    if(query.length<2||/https?:\/\/|Bearer |sk-[a-z0-9]/i.test(query)||seen.has(query.toLocaleLowerCase()))continue;
    seen.add(query.toLocaleLowerCase());queries.push({query,language:/[\u3400-\u9fff]/u.test(query)?'zh':'en',intent:clean(item?.intent).slice(0,300)});if(queries.length===4)break;
  }
  const planned=queries.length>0;
  if(!planned)for(const query of [...new Set(fallback)].slice(0,4))queries.push({query,language:/[\u3400-\u9fff]/u.test(query)?'zh':'en',intent:'依据已确认主题的备用检索式'});
  return {version:SEARCH_VERSION,origin:planned?'configured_text_model':'fallback',queries};
}
export const SHORTLIST_PROMPT='依据课题实质相关性筛选实际来源候选，只选择直接回答科学问题或提供可迁移关键方法的论文；不要为凑数量选背景文献。空缺资源、预算、设备条件不是排除理由。题录或摘要未报告结论时不得补造，但高度相关题名可以先入选再获取正文。先判断实质相关性，同等相关时优先有公开全文线索、正式发表、较新的研究。返回 {selected:[{index,reason,relevance_class:"direct|method",score:0.9}],excluded:[{index,reason}]}。index只能是输入数组真实索引，禁止生成新题名、DOI、链接或替换候选。score仅表示本次排序判断，不是科学质量或统计阈值；背景和无关项放excluded。';
export function selectedCandidates(raw,group){
  if(!Array.isArray(raw?.selected))throw new Error('相关性筛选缺少有效 selected 数组，未把模型格式错误当作全部排除。');
  const selected=new Map();
  for(const row of raw.selected){
    if(!Number.isInteger(row?.index)||row.index<0||row.index>=group.length||!clean(row.reason)||['background','irrelevant'].includes(row.relevance_class))continue;
    selected.set(row.index,{reason:clean(row.reason).slice(0,1500),score:Number.isFinite(row.score)&&row.score>=0&&row.score<=1?row.score:.8,relevance_class:row.relevance_class==='method'?'method':'direct'});
  }
  return selected;
}
export function fulltextHint(paper){return paper.reading_source?.basis==='fulltext'?3:(paper.pdf_urls||[]).length?2:(paper.landing_urls||[]).length?1:0;}
export function compareCandidates(a,b){return (a.relevance_class==='method')-(b.relevance_class==='method')||fulltextHint(b)-fulltextHint(a)||(b.relevance_score||0)-(a.relevance_score||0)||(b.publication_status==='published')-(a.publication_status==='published')||(b.year||0)-(a.year||0);}
export function searchDiagnosis(job){
  const state=job.checkpoint||{},candidates=state.candidates||[],completed=state.core_reports||0,
    relevant=candidates.filter(p=>p.relevance_reason&&!['excluded','duplicate'].includes(p.status)),
    missing=relevant.filter(p=>p.status==='no_fulltext').length,pending=relevant.filter(p=>['pending','unverified'].includes(p.status)).length,
    errors=[...new Set([...(state.search_log||[]).filter(row=>row.error).map(row=>`${row.source}：${row.error}`),...relevant.flatMap(p=>(p.source_gaps||[]).filter(message=>/跨域|连接失败|HTTP (?:403|429|5\d\d)|CORS|timeout|超时/i.test(message)).map(message=>'正文来源：'+message))])].slice(-3),next_steps=[];
  if(completed<job.requested){if(missing)next_steps.push('高相关候选暂缺可读取正文，可补充论文 PDF 或使用私人后台获取。');if(pending)next_steps.push('仍有相关候选或报告等待处理，可从检查点继续。');if(!relevant.length)next_steps.push('当前来源没有筛出足够直接相关的研究，请确认核心对象与检索范围。');if(errors.length)next_steps.push('部分文献源连接失败，请检查跨域限制与网络。');}
  return {source_errors:errors,relevant:relevant.length,fulltext_unavailable:missing,analysis_pending:pending,completed,next_steps};
}
