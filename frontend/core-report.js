// Application-owned completion rules. Model flags never establish completion.
const rows=value=>Array.isArray(value)?value:[];
const substantive=value=>typeof value==='string'&&value.trim()&&!/^(未报告|未核验|未知|不适用|unknown|unverified|n\/a)[。.;；\s]*$/i.test(value.trim());
export function coreReportStatus(analysis,source){
  const ids=new Set(rows(source?.blocks).map(x=>x.id)),blocks=new Map(rows(source?.blocks).map(x=>[x.id,x])),coverage=analysis.core_coverage||{},gaps=[];
  if(source?.basis!=='fulltext')gaps.push('等待论文正文');
  if(source?.characters_sent<source?.characters_available)gaps.push('正文阅读尚未覆盖全部可读内容');
  if(rows(source?.unread_pages).length)gaps.push('等待识别不可读页面');
  for(const [key,label] of [['question','科学问题'],['methods','方法或论证过程'],['results','关键结果']]){
    const item=coverage[key];
    if(!substantive(item?.summary)||!rows(item?.source_block_ids).length||!item.source_block_ids.every(id=>ids.has(id)))gaps.push('等待'+label+'的正文定位');
    else if(['methods','results'].includes(key)&&item.source_block_ids.every(id=>['abstract','metadata','references'].includes(blocks.get(id)?.section)||['abstract','metadata'].includes(blocks.get(id)?.kind)))gaps.push(label+'不能仅由摘要或题录支持');
  }
  const evidence=rows(analysis.evidence).filter(e=>substantive(e.claim)&&substantive(e.observation)&&rows(e.source_block_ids).length&&e.source_block_ids.every(id=>ids.has(id)));
  if(!evidence.length)gaps.push('等待可定位的关键结论证据');
  const required=[...new Set(rows(analysis.required_visual_pages).filter(p=>Number.isInteger(p)&&p>0&&p<=source?.pages))];
  const checked=new Set(rows(analysis.visuals).filter(v=>v.inspection_status==='verified'&&v.image_supplied===true&&v.source_sha256===source?.sha256&&v.inspection_id).map(v=>v.page));
  if(required.some(p=>!checked.has(p)))gaps.push('等待核心图表或公式的原页解释');
  return {status:gaps.length?'processing':'completed',gaps,required_visual_pages:required};
}
export function sourceGroups(blocks,limit=45000){
  const groups=[];let current=[],length=0;
  for(const block of rows(blocks)){
    const content=String(block.text||'');
    for(let offset=0;offset<content.length;offset+=limit){
      const text=content.slice(offset,offset+limit);
      if(length+text.length>limit&&current.length){groups.push(current);current=[];length=0;}
      current.push({...block,text});length+=text.length;
    }
  }
  if(current.length)groups.push(current);return groups;
}
export const CORE_READING_PROMPT='必须返回 core_coverage:{question:{summary,source_block_ids:[]},methods:{summary,source_block_ids:[]},results:{summary,source_block_ids:[]},study_type} 以及 required_visual_pages:[实际PDF页码]。理论论文methods对应推导、results对应命题；综述对应检索与综合结果。每项只引用实际正文块。列出直接支撑关键结论且必须查看的图表或公式原页，不以固定页数截断。无法定位时留空，不自行声称完成。';
