import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {createReferencePdfExtractor} from '../pdf-reference.js';

const file = (content='%PDF-1.7\nfixed offline PDF fixture') => new Blob([content], {type:'application/pdf'});
const text = (...strings) => strings.map(str => ({str, hasEOL:false}));
function fixture(pages, {metadata={info:{}}, rejected=null, pending=false}={}) {
  const state={destroyed:0, cleaned:[], parameters:null, signal:null, pageCalls:[]};
  const document={
    numPages:pages.length,
    getMetadata:async()=>metadata,
    async getPage(number){
      state.pageCalls.push(number);
      if(pages[number-1] instanceof Error)throw pages[number-1];
      return {getTextContent:async()=>({items:pages[number-1]}),cleanup:()=>state.cleaned.push(number)};
    },
  };
  const loadDocument=async(parameters,{signal})=>{
    state.parameters=parameters;state.signal=signal;
    return {promise:pending?new Promise(()=>{}):rejected?Promise.reject(rejected):Promise.resolve(document),destroy:async()=>{state.destroyed+=1;}};
  };
  return {state,extract:createReferencePdfExtractor({loadDocument,cryptoImpl:webcrypto,timeoutMs:1000})};
}

test('local text extraction retains page locators and a real byte fingerprint without claiming visual verification',async()=>{
  const source=file(),{extract,state}=fixture([text('Research question'),[{str:'研究',hasEOL:false},{str:'范围',hasEOL:true},{str:'方法与对照',hasEOL:false}]]),progress=[];
  const result=await extract(source,{onProgress:value=>progress.push(value)});
  assert.equal(result.sha256,createHash('sha256').update(Buffer.from(await source.arrayBuffer())).digest('hex'));
  assert.deepEqual(result.text_pages,[{page:1,text:'Research question'},{page:2,text:'研究范围\n方法与对照'}]);
  assert.equal(result.pages,2);assert.equal(result.text_page_count,2);assert.equal(result.text_characters,result.text_pages.reduce((sum,p)=>sum+p.text.length,0));
  assert.deepEqual(result.unread_pages,[]);assert.equal(result.extraction_status,'text-only');
  assert.match(result.warnings[0],/未进行 OCR、原图或公式视觉核验/);assert.equal(result.verified,undefined);
  assert.deepEqual(progress.at(-1),{stage:'extracting',page:2,totalPages:2});
  assert.equal(state.destroyed,1);assert.deepEqual(state.cleaned,[1,2]);
});

test('the parser receives local bytes and disables fetching a source document, scripting evaluation and rendering extras',async()=>{
  const {extract,state}=fixture([text('Usable research text')]);await extract(file());
  const p=state.parameters;assert.ok(p.data instanceof Uint8Array);assert.equal(p.url,undefined);assert.equal(p.password,undefined);
  for(const key of ['useWorkerFetch','useWasm','enableXfa','isEvalSupported','isOffscreenCanvasSupported','isImageDecoderSupported','useSystemFonts'])assert.equal(p[key],false);
  for(const key of ['stopAtErrors','disableAutoFetch','disableStream','disableRange','disableFontFace'])assert.equal(p[key],true);
  assert.match(p.cMapUrl,/\/vendor\/pdfjs\/cmaps\/$/);assert.match(p.standardFontDataUrl,/\/vendor\/pdfjs\/standard_fonts\/$/);
});

test('blank and failed pages are explicitly unread while usable page text remains available',async()=>{
  const {extract,state}=fixture([text('A real method'),text('   '),new Error('unsafe internal data')]);
  const result=await extract(file());assert.equal(result.pages,3);assert.deepEqual(result.unread_pages,[2,3]);
  assert.deepEqual(result.text_pages,[{page:1,text:'A real method'}]);assert.match(result.warnings.join('\n'),/第 3 页解析失败/);
  assert.doesNotMatch(result.warnings.join('\n'),/unsafe/);assert.equal(state.destroyed,1);
});

test('an all-image or blank PDF requires OCR and is never reported as successfully read',async()=>{
  const {extract,state}=fixture([[],text(' \n ')]);
  await assert.rejects(extract(file()),error=>error.code==='needs-ocr'&&/OCR/.test(error.message));assert.equal(state.destroyed,1);
});

test('fully damaged pages fail distinctly from a scan and never fabricate text',async()=>{
  const {extract,state}=fixture([new Error('secret parser details'),new Error('another detail')]);
  await assert.rejects(extract(file()),error=>error.code==='invalid'&&/所有页面均解析失败/.test(error.message)&&!error.message.includes('secret'));
  assert.equal(state.destroyed,1);
});

test('renamed non-PDF content is refused before the loader runs',async()=>{
  const {extract,state}=fixture([text('Should not be used')]);
  await assert.rejects(extract(file('<html>renamed.pdf</html>')),error=>error.code==='invalid'&&/扩展名/.test(error.message));assert.equal(state.parameters,null);
});

test('the 50 MB limit is checked before reading the file and rechecked on actual bytes',async()=>{
  const {extract,state}=fixture([text('Should not be used')]);let read=false;
  await assert.rejects(extract({size:50*1024*1024+1,arrayBuffer:async()=>{read=true;throw new Error();}}),/50 MB/);assert.equal(read,false);
  await assert.rejects(extract({size:20,arrayBuffer:async()=>new ArrayBuffer(50*1024*1024+1)}),/50 MB/);assert.equal(state.parameters,null);
});

test('page counts over 300 stop before page extraction and destroy the loading task',async()=>{
  const {extract,state}=fixture(Array.from({length:301},()=>text('Do not extract')));
  await assert.rejects(extract(file()),error=>error.code==='too-many-pages'&&/300 页/.test(error.message));assert.deepEqual(state.pageCalls,[]);assert.equal(state.destroyed,1);
});

test('password-protected PDFs surface a safe Chinese instruction and close the task',async()=>{
  const passwordError=Object.assign(new Error('raw password details'),{name:'PasswordException'}),{extract,state}=fixture([],{rejected:passwordError});
  await assert.rejects(extract(file()),error=>error.code==='encrypted'&&/解密/.test(error.message)&&!error.message.includes('raw'));
  assert.equal(state.destroyed,1);
});

test('encrypted documents that open without a prompt are still refused from metadata',async()=>{
  const {extract,state}=fixture([text('Restricted content')],{metadata:{info:{EncryptFilterName:'Standard'}}});
  await assert.rejects(extract(file()),error=>error.code==='encrypted');assert.deepEqual(state.pageCalls,[]);assert.equal(state.destroyed,1);
});

test('stalled parsing times out, aborts its work and destroys the loading task',async()=>{
  const state={destroyed:0,signal:null};
  const extract=createReferencePdfExtractor({cryptoImpl:webcrypto,timeoutMs:20,loadDocument:async(_,context)=>{state.signal=context.signal;return {promise:new Promise(()=>{}),destroy:async()=>{state.destroyed+=1;}};}});
  await assert.rejects(extract(file()),error=>error.code==='timeout'&&/已停止工作线程/.test(error.message));
  assert.equal(state.signal.aborted,true);assert.equal(state.destroyed,1);
});

test('registered worker cleanup runs after page failures and progress callback errors do not corrupt extraction',async()=>{
  let cleaned=0;
  const extract=createReferencePdfExtractor({cryptoImpl:webcrypto,loadDocument:async(_,context)=>{context.registerCleanup(()=>{cleaned+=1;});return {promise:Promise.resolve({numPages:1,getPage:async()=>({getTextContent:async()=>({items:text('Usable text')}),cleanup(){}})})};}});
  const result=await extract(file(),{onProgress:()=>{throw new Error('UI bug');}});assert.equal(result.text_page_count,1);assert.equal(cleaned,1);
});

const sourcePng='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
function renderFixture({dataUrl=sourcePng,stall=false}={}){
  const state={rendered:[],canvases:[],destroyed:0,cancelled:0};let renderStarted;
  const started=new Promise(resolve=>{renderStarted=resolve;});
  const document={numPages:5,getPage:async number=>({getTextContent:async()=>({items:text(number===1?'Actual article title':`Figure ${number} caption Table ${number} (fixture)`)}),getViewport:({scale})=>({width:2400*scale,height:3200*scale}),render:()=>{state.rendered.push(number);renderStarted();return {promise:stall?new Promise(()=>{}):Promise.resolve(),cancel(){state.cancelled++;}};},cleanup(){}})};
  const extract=createReferencePdfExtractor({cryptoImpl:webcrypto,loadDocument:async()=>({promise:Promise.resolve(document),destroy:async()=>state.destroyed++}),canvasFactory:()=>{const canvas={width:0,height:0,getContext:()=>({}),toDataURL:()=>dataUrl};state.canvases.push(canvas);return canvas;}});
  return {extract,state,started};
}

test('explicit paper rendering captures at most three bounded source pages with actual image and PDF fingerprints, never inspection stamps',async()=>{
  const {extract,state}=renderFixture(),sizes=[];const source=file();
  const result=await extract(source,{captureVisualPages:true,onProgress:event=>{if(event.stage==='rendering')sizes.push(state.canvases.at(-1).width*state.canvases.at(-1).height);}});
  assert.deepEqual(state.rendered,[2,3,4]);assert.equal(result.page_images.length,3);assert.equal(result.extraction_status,'text-with-rendered-pages');
  for(const image of result.page_images){assert.equal(image.source_sha256,result.sha256);assert.equal(image.image_sha256,createHash('sha256').update(Buffer.from(sourcePng.split(',')[1],'base64')).digest('hex'));assert.ok(image.width<=1400&&image.height<=1400);assert.equal(image.inspection_status,undefined);}
  assert.ok(sizes.every(pixels=>pixels<=1_600_000));assert.equal(state.destroyed,1);assert.ok(state.canvases.every(canvas=>canvas.width===0&&canvas.height===0));
  const reference=renderFixture();const textOnly=await reference.extract(file());assert.deepEqual(reference.state.rendered,[]);assert.equal(textOnly.page_images,undefined);
});

test('failed or oversized rendering retains source text without fabricated images or visual verification',async()=>{
  const {extract,state}=renderFixture({dataUrl:'data:image/png;base64,'+'A'.repeat(2_100_000)}),result=await extract(file(),{captureVisualPages:true});
  assert.equal(result.text_page_count,5);assert.deepEqual(result.page_images,[]);assert.equal(result.extraction_status,'text-only');assert.match(result.warnings.join(' '),/图像未取得/);assert.equal(result.verified,undefined);assert.equal(state.destroyed,1);
});

test('cancelling a stalled source-page render settles promptly and destroys rendering resources',async()=>{
  const {extract,state,started}=renderFixture({stall:true}),controller=new AbortController(),pending=extract(file(),{captureVisualPages:true,signal:controller.signal});
  await started;controller.abort();await assert.rejects(pending,error=>error.code==='cancelled');assert.equal(state.cancelled,1);assert.equal(state.destroyed,1);
  const alreadyCancelled=renderFixture(),cancelled=new AbortController();cancelled.abort();await assert.rejects(alreadyCancelled.extract(file(),{signal:cancelled.signal}),error=>error.code==='cancelled');assert.deepEqual(alreadyCancelled.state.rendered,[]);
});
