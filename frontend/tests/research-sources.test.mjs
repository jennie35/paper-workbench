import test from 'node:test';
import assert from 'node:assert/strict';
import {abstractFromIndex,openAlexPaper,mergeSourcePaper,publicDocumentUrl,createResearchSources} from '../research-sources.js';

const doi='10.5555/synthetic-report';
const oa=(extra={})=>({doi:'https://doi.org/'+doi,title:'A synthetic measurement study',type:'article',publication_year:2026,publication_date:'2026-01-02',authorships:[{author:{display_name:'Fixture Author'}}],primary_location:{is_published:true,is_oa:true,source:{display_name:'Synthetic Journal'},pdf_url:'https://papers.example/study.pdf'},abstract_inverted_index:{A:[0],real:[1],abstract:[2]},...extra});
const extracted=(extra={})=>({sha256:'f'.repeat(64),pages:3,text_pages:[{page:1,text:'A synthetic measurement study DOI: '+doi},{page:2,text:'Measured controls in a fixed synthetic experiment.'}],text_characters:109,unread_pages:[3],warnings:['第 3 页没有可提取文字。'],...extra});
const pdf=()=>new Response(new TextEncoder().encode('%PDF-1.7 synthetic fixture bytes'),{headers:{'content-type':'application/pdf'}});

test('OpenAlex preserves real abstract order, DOI, publication version and only public OA PDF locations',()=>{
  assert.equal(abstractFromIndex({three:[2],one:[0],two:[1],bad:[-1,20000,'3']}),'one two three');
  const paper=openAlexPaper(oa());assert.equal(paper.abstract,'A real abstract');assert.equal(paper.doi,doi);assert.equal(paper.publication_status,'published');assert.equal(paper.source,'OpenAlex');assert.deepEqual(paper.pdf_urls,['https://papers.example/study.pdf']);
  assert.equal(openAlexPaper(oa({doi:null})),null);assert.equal(openAlexPaper(oa({type:'preprint'})).publication_status,'preprint');assert.equal(openAlexPaper(oa({primary_location:{source:{display_name:'Unknown'}}})).publication_status,'unknown');
  for(const value of ['http://papers.example/a.pdf','https://127.0.0.1/a','https://[::1]/a','https://user:key@papers.example/a','https://server.internal/a'])assert.equal(publicDocumentUrl(value),null);
});

test('source merging enriches a Crossref record while retaining identity, relations and provenance',()=>{
  const base={doi,title:'Crossref identity',source:'Crossref',abstract:'',pdf_urls:[],publication_status:'unknown',versions:[doi,'10.5555/preprint']};mergeSourcePaper(base,openAlexPaper(oa()));
  assert.equal(base.title,'Crossref identity');assert.equal(base.abstract_source,'OpenAlex');assert.equal(base.publication_status,'published');assert.deepEqual(base.sources,['Crossref','OpenAlex']);assert.equal(base.versions.includes('10.5555/preprint'),true);
});

test('open-source discovery and DOI supplementation do not receive model credentials and unsuccessful enrichment remains retryable',async()=>{
  const calls=[];let fail=true;const sources=createResearchSources({extractPdf:async()=>{},request:async(url,options)=>{calls.push({url,options});if(url.includes('/works/')){if(fail){fail=false;return new Response('{}',{status:429});}return Response.json(oa());}return Response.json({results:[oa(),oa({doi:null})]});}});
  assert.equal((await sources.discover('measurement controls',2024)).length,1);assert.match(calls[0].url,/from_publication_date/);const paper={doi,source:'Crossref',abstract:'',pdf_urls:[]};await assert.rejects(sources.supplement(paper),/429/);assert.equal(paper.enrichment_attempted,undefined);await sources.supplement(paper);assert.equal(paper.abstract,'A real abstract');assert.equal(paper.enrichment_attempted,true);assert.equal(calls.every(c=>!c.options.headers?.Authorization),true);
});

test('actual matching PDF text is preferred, bounded, fingerprinted, and missing pages remain explicit',async()=>{
  let parsed=0;const sources=createResearchSources({request:async()=>pdf(),extractPdf:async()=>{parsed++;return extracted({text_pages:[{page:1,text:'A synthetic measurement study DOI: '+doi+' '+ 'a'.repeat(61000)},{page:2,text:'never sent'}],text_characters:62000});}});const source=await sources.acquire(openAlexPaper(oa()));
  assert.equal(parsed,1);assert.equal(source.basis,'fulltext');assert.equal(source.characters_sent,60000);assert.equal(source.characters_available,62000);assert.deepEqual(source.unread_pages,[3]);assert.equal(source.sha256,'f'.repeat(64));assert.equal(source.blocks[0].id,'PDF-P1');assert.equal(source.blocks[0].page,1);assert.equal(source.blocks.some(block=>block.page===2),false);
});

test('unmatched, inaccessible and oversized PDFs never become a fulltext report and retain actual abstract fallback',async()=>{
  for(const mode of ['identity','network','size']){
    const sources=createResearchSources({request:async()=>{if(mode==='network')throw new Error('CORS blocked');if(mode==='size')return new Response('x',{headers:{'content-length':String(51*1024*1024)}});return pdf();},extractPdf:async()=>extracted({text_pages:[{page:1,text:'A different paper DOI 10.5555/synthetic-report-other'}]})});
    const paper=openAlexPaper(oa()),source=await sources.acquire(paper);assert.equal(source.basis,'abstract');assert.equal(source.blocks[0].text,'A real abstract');assert.ok(paper.source_gaps.length);assert.equal(source.sha256,undefined);
  }
});

test('a dishonest streaming body is cancelled at the hard 50 MB bound',async()=>{
  let cancelled=false,read=0;const sources=createResearchSources({extractPdf:async()=>{throw new Error('Must never parse oversized bytes');},request:async()=>({ok:true,headers:new Headers(),body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(++read===1?50*1024*1024:1)}),cancel:async()=>{cancelled=true;}})}})});
  const source=await sources.acquire(openAlexPaper(oa()));assert.equal(source.basis,'abstract');assert.equal(cancelled,true);assert.equal(read,2);assert.match(source.warnings[0],/50 MB/);
});

test('a different paper that merely cites the target DOI or title on a later page is rejected',async()=>{
  const sources=createResearchSources({request:async()=>pdf(),extractPdf:async()=>extracted({text_pages:[{page:1,text:'A different original paper with an unrelated heading and methods.'},{page:2,text:'References: A synthetic measurement study. DOI: '+doi}]})});
  const source=await sources.acquire(openAlexPaper(oa()));assert.equal(source.basis,'abstract');assert.match(source.warnings.join(' '),/未匹配/);
});

test('without any retrieved text a candidate yields no source; cancellation never silently downgrades to abstract',async()=>{
  const controller=new AbortController();const sources=createResearchSources({extractPdf:async()=>extracted(),request:async()=>{controller.abort();throw new Error('aborted fixture');}});await assert.rejects(sources.acquire(openAlexPaper(oa()),controller.signal),/aborted/);
  assert.equal(await sources.acquire(openAlexPaper(oa({abstract_inverted_index:null,primary_location:{}}))),null);
});
