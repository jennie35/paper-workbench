import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {selectVisualPages,sourceImageBytes,imageSha256,stampVisualReview,visualAsset} from '../paper-visuals.js';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const jpeg='data:image/jpeg;base64,'+Buffer.from([255,216,255,224,1,2,255,217]).toString('base64');
const source={sha256:'a'.repeat(64),pages:4,url:'https://papers.example/article.pdf'};
const metadata={model:'fixture-vision',checkedAt:'2026-10-22T09:00:00.000Z',inspectionId:'actual-request-fixture'};
const image=async(url=png)=>({page:2,mime:'incorrect-model-mime',image_data_url:url,image_sha256:await imageSha256(url,webcrypto),source_sha256:source.sha256});
const item={type:'figure',label:'Figure 2',readable:true,explanation:'The visible panel compares the measured control and treatment.',comparison:'Control versus treatment',axes_units:'Time (s) and displacement (mm)'};

test('visual selection ranks only pages with concrete figure, table or equation markers and caps to three unique source pages',()=>{
  const pages=[{page:1,text:'Article title'},{page:2,text:'Figure 1 Figure 2'},{page:3,text:'Table 1'},{page:4,text:'Equation 3 Figure 4 Figure 5'},{page:5,text:'图6与表2'}];
  assert.deepEqual(selectVisualPages(pages),[2,4,5]);assert.deepEqual(selectVisualPages(pages,1),[4]);
  assert.deepEqual(selectVisualPages([{page:1,text:'There may be figures'}]),[]);
});

test('selection and inspection support source numbering with fullwidth parentheses without treating bare references as figures',async()=>{
  const img=await image();
  for(const [type,label] of [['figure','Figure (S1)'],['figure','图（一）'],['table','Table（II）'],['table','表（A.1）'],['equation','公式（3）'],['equation','式 (A.1)'],['equation','Equation（S2）']]){
    assert.deepEqual(selectVisualPages([{page:2,text:'Original caption: '+label}]),[2],label);
    assert.equal(stampVisualReview({items:[{...item,type,label}]},img,source,metadata).length,1,label);
  }
  assert.equal(stampVisualReview({items:[{...item,type:'equation',label:'（3）'}]},img,source,metadata).length,1);
  assert.deepEqual(selectVisualPages([{page:2,text:'A reference citation (1); another reference （3）.'}]),[]);
});

test('only bounded PNG/JPEG bytes are accepted and the fingerprint covers the actual image bytes',async()=>{
  assert.equal(sourceImageBytes(png).mime,'image/png');assert.equal(sourceImageBytes(jpeg).mime,'image/jpeg');
  assert.equal(await imageSha256(png,webcrypto),createHash('sha256').update(Buffer.from(png.split(',')[1],'base64')).digest('hex'));
  for(const value of ['https://papers.example/image.png','data:image/svg+xml;base64,PHN2Zy8+','data:image/png;base64,SGVsbG8=','data:image/jpeg;base64,aW52YWxpZA==','data:image/png;base64,'+'A'.repeat(2_100_000)])assert.equal(sourceImageBytes(value),null);
});

test('inspection stamps come only from application provenance, readable numbered items and actual source image',async()=>{
  const img=await image(),records=stampVisualReview({items:[{...item,page:99,source_sha256:'forged',inspection_status:'verified',inspection_id:'forged',asset_path:'secrets.txt'}, {...item,label:'Figure'}, {...item,readable:false}, {...item,type:'equation',label:'(3)'}]},img,source,metadata);
  assert.equal(records.length,2);assert.equal(records[0].page,2);assert.equal(records[0].source_sha256,source.sha256);assert.equal(records[0].inspection_id,metadata.inspectionId);assert.equal(records[0].asset_path,'assets/page-2.png');
  assert.equal(records[0].inspection_method,'vision_model');assert.match(records[0].inspection_note,/未经人工复核/);assert.equal(records[1].label,'(3)');
  assert.deepEqual(stampVisualReview({items:[item]},{...img,source_sha256:'b'.repeat(64)},source,metadata),[]);
  assert.deepEqual(stampVisualReview({items:[item]},{...img,page:5},source,metadata),[]);
  assert.deepEqual(stampVisualReview({items:[item]},img,source,{}),[]);
  for(const [type,label] of [['figure','Fig. S1'],['figure','图 2a'],['table','Table II'],['table','Table A.1'],['equation','Eq. (S2)']])assert.equal(stampVisualReview({items:[{...item,type,label}]},img,source,metadata).length,1,label);
  assert.deepEqual(stampVisualReview({items:[{...item,label:'PDF 第 2 页'}]},img,source,metadata),[]);
});

test('image assets verify persisted bytes and extension, do not expose unstamped or tampered images, and support JPEG',async()=>{
  for(const url of [png,jpeg]){
    const [record]=stampVisualReview({items:[item]},await image(url),source,metadata),analysis={source_metadata:{sha256:source.sha256},visuals:[record]},filename=record.asset_path.split('/').at(-1);
    const blob=await visualAsset(analysis,filename,webcrypto);assert.ok(blob);assert.equal(blob.type,url===png?'image/png':'image/jpeg');
    assert.equal(await visualAsset(analysis,'../'+filename,webcrypto),null);
    assert.equal(await visualAsset({...analysis,visuals:[{...record,image_sha256:'0'.repeat(64)}]},filename,webcrypto),null);
    assert.equal(await visualAsset({...analysis,visuals:[{...record,inspection_status:'unverified'}]},filename,webcrypto),null);
    assert.equal(await visualAsset({...analysis,source_metadata:{sha256:'b'.repeat(64)}},filename,webcrypto),null);
  }
});

test('a readable flag with a placeholder explanation never creates a verified visual record',async()=>{
  const img=await image();
  for(const explanation of ['', '尚未核验。', '此项核验记录：尚未核验', '未报告', '未知；', 'UNVERIFIED', 'not reported.', 'N/A', '<p>尚未核验</p>', '已提供的来源未报告足够信息，需核对原文。'])assert.deepEqual(stampVisualReview({items:[{...item,explanation}]},img,source,metadata),[],explanation);
  const concrete='The control and treatment panels show different slopes; the statistical unit was not reported.';
  const [record]=stampVisualReview({items:[{...item,explanation:concrete}]},img,source,metadata);assert.equal(record.explanation,concrete);
});
