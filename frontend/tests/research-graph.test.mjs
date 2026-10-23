import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import cytoscape from '../vendor/cytoscape/cytoscape.esm.min.mjs';
import {normalizeGraph,graphElements,graphNodeAppearance,graphLayout,graphSnapshotHtml,graphSnapshotStyle,demoGraphForPapers,syntheticGraphFixture,safePaperUrl,MAX_GRAPH_NODES,graphQueryLimit} from '../research-graph.js';

const papers=[{id:'R001',title:'中文无 DOI 方法研究',authors:['张甲'],year:2024,source_id:'https://openalex.org/W1',citation_count:0,analysis:{summary:'实际保存的研究总结',scientific_question:'实际科学问题',future_insights:'借鉴分层记录技术重复与独立样本，并在本课题用匹配对照验证。',evidence:[{id:'E01',claim:'实际来源的证据',source_block_ids:['B01']}]}},{id:'R002',title:'中文无 DOI 方法研究',authors:['李乙'],year:2025,source_id:'https://openalex.org/W2',reference_ids:['https://openalex.org/W1','https://openalex.org/W9']},{id:'R003',title:'A separate bilingual method',doi:'10.5555/method',reference_ids:['https://openalex.org/W1','https://openalex.org/W9']},{id:'R004',title:'Later evaluation',reference_ids:['https://openalex.org/W2','10.5555/method']}];

test('saved reference identifiers create typed relations without merging same Chinese titles',()=>{
  const graph=demoGraphForPapers(papers);
  assert.equal(graph.nodes.length,4);
  const direct=graph.edges.filter(edge=>edge.type==='direct_citation');
  assert.deepEqual(direct.map(edge=>[edge.source,edge.target]),[['R002','R001'],['R003','R001'],['R004','R002'],['R004','R003']]);
  const shared=graph.edges.find(edge=>edge.type==='shared_references'&&edge.source==='R002'&&edge.target==='R003');
  assert.deepEqual(shared.basis.shared_reference_ids,['https://openalex.org/w1','https://openalex.org/w9']);
  const co=graph.edges.find(edge=>edge.type==='co_citation'&&edge.source==='R002'&&edge.target==='R003');
  assert.deepEqual(co.basis.citing_paper_ids,['R004']);
  assert.equal(graph.edges.some(edge=>edge.type==='semantic_similarity'),false);
  assert.match(graph.nodes[0].reference_value,/匹配对照/);
});

test('a library without saved references has no invented links and semantic requires actual vectors',()=>{
  const graph=demoGraphForPapers(papers.map(({reference_ids,...paper})=>paper),{view:'semantic'});
  assert.deepEqual(graph.edges,[]);assert.equal(graph.availability.available,false);assert.match(graph.availability.reason,/内容向量/);
  const ambiguous=demoGraphForPapers([{id:'A',title:'One',doi:'10.5555/same'},{id:'B',title:'Other',doi:'10.5555/same'},{id:'C',title:'Citing',references:['10.5555/same']}]);
  assert.equal(ambiguous.edges.some(edge=>edge.type==='direct_citation'),false,'ambiguous identity is never resolved by last-write wins');
});

test('normalization drops malformed, duplicate, missing-endpoint, self, and untyped edges',()=>{
  const graph=normalizeGraph({nodes:[{id:'A',title:'A'},{id:'B',title:'B'},{id:'A',title:'dup'},{id:'empty',title:''}],edges:[{id:'A',source:'A',target:'B',type:'citation',directed:false},{id:'self',source:'A',target:'A',type:'semantic_similarity'},{id:'missing',source:'A',target:'Z',type:'direct_citation'},{id:'made-up',source:'A',target:'B',type:'related'},{id:'duplicate',source:'A',target:'B',type:'co_citation'},{id:'duplicate',source:'A',target:'B',type:'co_citation'}]});
  assert.equal(graph.nodes.length,2);assert.equal(graph.edges.length,2);assert.equal(graph.edges[0].directed,true);assert.notEqual(graph.edges[0].id,'A');
  assert.equal(graph.edges[1].directed,false);
});

test('unknown data is distinguished and citation zero remains a known zero',()=>{
  const nodes=normalizeGraph({nodes:[{id:'a',title:'A',year:2020,citation_count:0},{id:'b',title:'B',year:2025,citation_count:100},{id:'c',title:'C',candidate:true}]}).nodes;
  const a=graphNodeAppearance(nodes[0],nodes),b=graphNodeAppearance(nodes[1],nodes),c=graphNodeAppearance(nodes[2],nodes);
  assert.equal(a.unknown_citations,false);assert.ok(b.size>a.size);assert.notEqual(a.color,b.color);assert.equal(c.unknown_year,true);assert.equal(c.unknown_citations,true);assert.equal(c.color,'#e4e4e2');assert.equal(c.border_style,'dashed');
});

test('graph elements limit initially to fifty, keep only displayed endpoints and separate relation types',()=>{
  const graph=syntheticGraphFixture(),direct=graphElements(graph),semantic=graphElements(graph,{view:'semantic'}),shared=graphElements(graph,{relation:'shared_references'});
  assert.equal(direct.edges.length,4);assert.equal(semantic.edges.length,3);assert.equal(shared.edges.length,1);assert.ok(semantic.edges.every(edge=>edge.type==='semantic_similarity'));
  assert.equal(graphElements({nodes:Array.from({length:80},(_,i)=>({id:`R${i}`,title:`文献 ${i}`}))}).nodes.length,50);
  const library=Array.from({length:80},(_,i)=>({id:`R${i}`,title:`文献 ${i}`})),initial=demoGraphForPapers(library),expanded=demoGraphForPapers(library,{limit:100});assert.equal(initial.nodes.length,50);assert.equal(initial.total_nodes,80);assert.equal(expanded.nodes.length,80);
  assert.deepEqual(graphElements(demoGraphForPapers(papers),{search:'李乙'}).nodes.map(node=>node.id),['R002']);
});

test('Cytoscape local runtime accepts typed graph headlessly without a network or DOM',()=>{
  const data=graphElements(syntheticGraphFixture());const cy=cytoscape({headless:true,elements:data.elements,layout:{name:'circle'}});
  assert.equal(cy.nodes().length,4);assert.equal(cy.edges().length,4);cy.destroy();
});

test('all graph entry points respect the backend maximum of 200 nodes',()=>{
  const nodes=Array.from({length:250},(_,index)=>({id:`N${index}`,title:`Saved paper ${index}`}));
  assert.equal(MAX_GRAPH_NODES,200);assert.equal(graphQueryLimit(1000),200);assert.equal(graphQueryLimit(0),1);assert.equal(graphQueryLimit(undefined),50);
  assert.equal(normalizeGraph({nodes,limit:1000}).limit,200);assert.equal(graphElements({nodes},{limit:1000}).nodes.length,200);
  const local=demoGraphForPapers(nodes,{limit:1000});assert.equal(local.nodes.length,200);assert.equal(local.limit,200);assert.equal(local.total_nodes,250);
});

test('small-graph placement keeps every node separate and default labels remain short identifiers',()=>{
  const data=graphElements(syntheticGraphFixture(),{selectedId:'DEMO-01'}),cy=cytoscape({headless:true,elements:data.elements,layout:graphLayout(data.nodes.length)});
  const positions=cy.nodes().map(node=>node.position());for(let i=0;i<positions.length;i++)for(let j=i+1;j<positions.length;j++)assert.ok(Math.hypot(positions[i].x-positions[j].x,positions[i].y-positions[j].y)>90);
  assert.ok(data.elements.filter(item=>item.group==='nodes').every(item=>item.data.label.length<=13&&item.data.size<=44));assert.equal(graphLayout(20).name,'cose');assert.equal(graphLayout(4).fit,false);cy.destroy();
});

test('offline graph includes original basis, links, saved evidence and accessible text without scripts',()=>{
  const graph=demoGraphForPapers(papers),html=graphSnapshotHtml(graph,{reportHref:id=>`#report-${id}`});
  assert.match(html,/<svg/);assert.match(html,/matched_reference_id/);assert.match(html,/saved-reference-ids-v1/);assert.match(html,/实际科学问题/);assert.match(html,/实际来源的证据/);assert.match(html,/#report-R001/);assert.match(html,/前序研究/);
  assert.doesNotMatch(html,/<script|<iframe|https:\/\/cdn/);assert.match(graphSnapshotStyle,/@media/);
  assert.equal(graphSnapshotHtml({nodes:[]}), '');
});

test('synthetic graph is isolated and visibly labels fabricated years, citations and relationships',()=>{
  const graph=syntheticGraphFixture([{id:'REAL',title:'Private actual record',publication_status:'published'}]);
  assert.equal(graph.synthetic,true);assert.ok(graph.nodes.every(node=>node.id.startsWith('DEMO-')));assert.ok(graph.edges.every(edge=>edge.basis.synthetic===true));
  assert.match(graphSnapshotHtml(graph),/合成演示数据/);assert.match(graph.notices.join(''),/年份、被引数、连线均为合成演示/);
  assert.equal(syntheticGraphFixture([],{view:'semantic'}).view,'semantic');assert.equal(syntheticGraphFixture([],{relation:'co_citation'}).relation,'co_citation');
});

test('remote links, titles and caller-provided report links do not introduce active HTML',()=>{
  assert.equal(safePaperUrl('javascript:alert(1)'),'');assert.equal(safePaperUrl('https://user:password@example.org'), '');
  const html=graphSnapshotHtml({nodes:[{id:'x',title:'<img src=x onerror=alert(1)>',url:'javascript:alert(2)',summary:'</script><script>alert(3)</script>'}]},{reportHref:()=> 'javascript:alert(4)'});
  assert.doesNotMatch(html,/<img|<script|href="javascript:/);assert.match(html,/&lt;img/);assert.match(html,/#paper-x/);
});

test('bundled dependency provenance is pinned with license and integrity, no CDN loader',()=>{
  const info=JSON.parse(fs.readFileSync(new URL('../vendor/cytoscape/version.json',import.meta.url),'utf8'));
  assert.equal(info.version,'3.34.3');assert.equal(info.license,'MIT');assert.match(info.integrity,/^sha512-/);assert.match(info.tarball,/^https:\/\/registry\.npmjs\.org\/cytoscape\//);
  assert.match(fs.readFileSync(new URL('../vendor/cytoscape/LICENSE',import.meta.url),'utf8'),/Permission is hereby granted, free of charge/);
  const source=fs.readFileSync(new URL('../research-graph.js',import.meta.url),'utf8');assert.match(source,/\.\/vendor\/cytoscape\/cytoscape\.esm\.min\.mjs/);assert.doesNotMatch(source,/cdn\./);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL('../vendor/cytoscape/cytoscape.esm.min.mjs',import.meta.url))).digest('hex').length,64);
});
