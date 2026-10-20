// Public scholarly data only. Never forwards model credentials to a source.
const plain = value => typeof value==='string'?value.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,100000):'';
const doiOf = value => String(value||'').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').toLowerCase();
export function publicDocumentUrl(value) {
  try {
    const url=new URL(value),host=url.hostname.toLowerCase().replace(/\.$/,'');
    if(url.protocol!=='https:'||url.username||url.password||!host.includes('.')||host.includes(':')||/^\d+(?:\.\d+){3}$/.test(host)||/(?:^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host))return null;
    url.hash='';return url.href;
  }catch{return null;}
}
export function abstractFromIndex(index) {
  if(!index||typeof index!=='object'||Array.isArray(index))return '';
  const words=[];
  for(const [word,positions] of Object.entries(index))if(Array.isArray(positions))for(const position of positions)if(Number.isInteger(position)&&position>=0&&position<20000)words[position]=word;
  return words.filter(Boolean).join(' ').slice(0,100000);
}
export function openAlexPaper(item) {
  const doi=doiOf(item?.doi),title=plain(item?.title||item?.display_name);
  if(!title||!/^10\.\d{4,9}\/\S+$/i.test(doi))return null;
  const locations=[item.best_oa_location,item.primary_location,...(Array.isArray(item.locations)?item.locations:[])].filter(Boolean);
  const published=locations.some(x=>x.is_published===true||x.version==='publishedVersion');
  return {title,doi,authors:(Array.isArray(item.authorships)?item.authorships:[]).map(x=>plain(x.author?.display_name)).filter(Boolean),year:Number.isInteger(item.publication_year)?item.publication_year:null,publication_date:plain(item.publication_date),journal:plain(item.primary_location?.source?.display_name),url:'https://doi.org/'+encodeURI(doi),abstract:abstractFromIndex(item.abstract_inverted_index),abstract_source:'OpenAlex',publication_status:item.type==='preprint'?'preprint':published?'published':'unknown',versions:[doi],source:'OpenAlex',status:'pending',pdf_urls:[...new Set(locations.filter(x=>x.is_oa===true).map(x=>publicDocumentUrl(x.pdf_url)).filter(Boolean))].slice(0,3)};
}
export function mergeSourcePaper(existing,incoming) {
  if(!existing.abstract&&incoming.abstract){existing.abstract=incoming.abstract;existing.abstract_source=incoming.abstract_source||incoming.source;}
  existing.pdf_urls=[...new Set([...(existing.pdf_urls||[]),...(incoming.pdf_urls||[])])].slice(0,3);
  existing.sources=[...new Set([...(existing.sources||[existing.source]),incoming.source])];
  existing.versions=[...new Set([...(existing.versions||[]),...(incoming.versions||[])])];
  if(existing.publication_status==='unknown'&&incoming.publication_status!=='unknown')existing.publication_status=incoming.publication_status;
}
function textIdentity(extracted,paper) {
  // A DOI in a different paper's references is not document identity. Require
  // the target title on the first readable page, where document headings occur.
  const first=(extracted.text_pages||[])[0]?.text?.slice(0,6000)||'';
  const normalize=value=>value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const title=normalize(paper.title);if(title.length>=12)return normalize(first).includes(title);
  const heading=first.slice(0,1500).toLowerCase(),doi=paper.doi.toLowerCase(),offset=heading.indexOf(doi);
  return title.length>=6&&normalize(heading).includes(title)&&offset>=0&&!/[\p{L}\p{N}/_.%+-]/u.test(heading[offset+doi.length]||'');
}
function pageBudget(extracted,limit=60000) {
  let remaining=limit;const blocks=[];
  for(const page of extracted.text_pages||[]){if(!remaining)break;const content=page.text.slice(0,remaining);if(content)blocks.push({id:'PDF-P'+page.page,page:page.page,locator:'PDF 第 '+page.page+' 页',text:content});remaining-=content.length;}
  return blocks;
}
// Keep a hard bound even when Content-Length is missing or dishonest.
async function pdfBytes(response,signal) {
  const max=50*1024*1024;if(Number(response.headers?.get('content-length'))>max)throw new Error('全文超过 50 MB，未下载。');
  if(!response.body?.getReader)throw new Error('浏览器不支持受限流式下载，未获取全文。');
  const reader=response.body.getReader(),chunks=[];let length=0;const abort=()=>reader.cancel().catch(()=>{});signal?.addEventListener('abort',abort,{once:true});
  try{for(;;){if(signal?.aborted)throw new Error('已取消');const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>max)throw new Error('全文超过 50 MB，已停止下载。');chunks.push(value);}}
  finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});}
  if(signal?.aborted)throw new Error('全文下载已取消或超时。');
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
export function createResearchSources({request,extractPdf}) {
  async function discover(query,from,signal) {
    const url=new URL('https://api.openalex.org/works');url.searchParams.set('search',query.slice(0,500));url.searchParams.set('per-page','40');if(from!==null)url.searchParams.set('filter',`from_publication_date:${from}-01-01`);
    const response=await request(url.href,{},signal,25000);if(!response.ok)throw new Error(`OpenAlex 检索失败（HTTP ${response.status}），已继续其他来源。`);
    const payload=await response.json();if(!Array.isArray(payload.results))throw new Error('OpenAlex 未返回有效题录。');return payload.results.map(openAlexPaper).filter(Boolean);
  }
  async function supplement(paper,signal) {
    if(paper.enrichment_attempted)return;
    const response=await request('https://api.openalex.org/works/https://doi.org/'+encodeURIComponent(paper.doi),{},signal,15000);
    if(!response.ok)throw new Error(`OpenAlex DOI 补充不可用（HTTP ${response.status}）。`);
    const item=openAlexPaper(await response.json());if(!item||item.doi!==paper.doi)throw new Error('OpenAlex DOI 补充未匹配当前论文身份。');mergeSourcePaper(paper,item);paper.enrichment_attempted=true;
  }
  async function acquire(paper,signal) {
    const diagnostics=paper.source_gaps||=[];
    for(const value of (paper.pdf_urls||[]).slice(0,2)){
      const url=publicDocumentUrl(value);if(!url)continue;
      try{
        const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,45000);
        let bytes;try{const response=await request(url,{},controller.signal,20000);if(!response.ok)throw new Error(`全文下载 HTTP ${response.status}`);bytes=await pdfBytes(response,controller.signal);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
        if(signal?.aborted)throw new Error('已取消');
        const extracted=await extractPdf({name:'article.pdf',size:bytes.length,arrayBuffer:async()=>bytes.buffer});
        if(signal?.aborted)throw new Error('已取消');
        if(!textIdentity(extracted,paper))throw new Error('下载文字未匹配 DOI 或论文标题，未作为全文使用');
        const blocks=pageBudget(extracted);return {basis:'fulltext',blocks,url,sha256:extracted.sha256,pages:extracted.pages,unread_pages:extracted.unread_pages||[],warnings:extracted.warnings||[],characters_available:extracted.text_characters,characters_sent:blocks.reduce((sum,x)=>sum+x.text.length,0)};
      }catch(error){if(signal?.aborted)throw error;diagnostics.push('开放全文：'+error.message);}
    }
    if(paper.abstract){const abstract=paper.abstract.slice(0,60000);return {basis:'abstract',blocks:[{id:'ABSTRACT-1',page:null,locator:(paper.abstract_source||paper.source)+' abstract',text:abstract}],url:paper.url,pages:0,unread_pages:[],warnings:diagnostics,characters_available:paper.abstract.length,characters_sent:abstract.length};}
    return null;
  }
  return {discover,supplement,acquire};
}
