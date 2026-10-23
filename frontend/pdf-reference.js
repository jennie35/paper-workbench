import {selectVisualPages,imageSha256,sourceImageBytes} from './paper-visuals.js?v=20261023-core1';
// References default to text only. Explicit paper analysis may capture bounded
// source page images; rendering never marks those pages visually inspected.
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 300;
const TIMEOUT_MS = 120_000;
const VENDOR = new URL('./vendor/pdfjs/', import.meta.url);
const TEXT_ONLY_WARNING = '仅提取 PDF 文字作为研究范围参考；未进行 OCR、原图或公式视觉核验。';

class ReferencePdfError extends Error {
  constructor(message, code) { super(message); this.name = 'ReferencePdfError'; this.code = code; }
}

function report(callback, value) {
  // A progress display must not interrupt extraction or turn a valid file into an error.
  try { callback?.(value); } catch { /* UI callback only */ }
}

async function boundedCleanup(cleanup) {
  let timer;
  try { await Promise.race([Promise.resolve().then(cleanup), new Promise(resolve => { timer = setTimeout(resolve, 1500); })]); }
  catch { /* Cleanup must not replace the file's useful error. */ }
  finally { clearTimeout(timer); }
}

function pageText(items) {
  return (Array.isArray(items) ? items : [])
    .filter(item => typeof item?.str === 'string')
    .map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n')
    .replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]) +(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '')
    .trim();
}

function readableError(error) {
  if (error instanceof ReferencePdfError) return error;
  if (error?.name === 'AbortError') return new ReferencePdfError('PDF 解析已取消。', 'cancelled');
  if (error?.name === 'PasswordException') {
    return new ReferencePdfError('此 PDF 已加密或需要密码。请先在本机解密并另存后再添加。', 'encrypted');
  }
  if (error?.name === 'InvalidPDFException' || error?.name === 'FormatError') {
    return new ReferencePdfError('无法可靠读取此 PDF，文件可能损坏。请重新导出有效 PDF 后再添加。', 'invalid');
  }
  return new ReferencePdfError('PDF 文字提取失败。请确认文件可正常打开，并使用含可复制文字的 PDF；扫描件需先完成 OCR。', 'extraction-failed');
}

async function loadPdfDocument(parameters, {signal, registerCleanup}) {
  let pdfjs;
  try { pdfjs = await import('./vendor/pdfjs/legacy/build/pdf.mjs'); }
  catch { throw new ReferencePdfError('PDF 解析组件加载失败。请刷新网页，并使用支持模块工作线程的新版浏览器。', 'parser-unavailable'); }
  if (signal.aborted) throw signal.reason;
  if (typeof globalThis.Worker !== 'function') {
    throw new ReferencePdfError('当前浏览器不支持 PDF 解析工作线程，请使用新版浏览器。', 'worker-unavailable');
  }
  // Explicit Worker avoids a main-thread fallback for an untrusted PDF.
  let nativeWorker;
  try { nativeWorker = new Worker(new URL('legacy/build/pdf.worker.mjs', VENDOR), {type: 'module'}); }
  catch { throw new ReferencePdfError('浏览器无法启动 PDF 工作线程。请刷新网页或使用新版浏览器。', 'worker-unavailable'); }
  let worker, loadingTask;
  let rejectWorker;
  const workerFailure = new Promise((_, reject) => { rejectWorker = reject; });
  const workerFailed = () => rejectWorker(new ReferencePdfError('PDF 工作线程加载失败。请刷新网页，并检查浏览器是否允许本网站运行工作线程。', 'worker-unavailable'));
  nativeWorker.addEventListener('error', workerFailed, {once: true});
  nativeWorker.addEventListener('messageerror', workerFailed, {once: true});
  const terminate = () => { try { nativeWorker.terminate(); } catch { /* already closed */ } };
  signal.addEventListener('abort', terminate, {once: true});
  registerCleanup(async () => {
    try {
      // Do not allow a damaged document to keep a worker alive during cleanup.
      if (loadingTask) await boundedCleanup(() => loadingTask.destroy());
    } finally {
      signal.removeEventListener('abort', terminate);
      nativeWorker.removeEventListener('error', workerFailed);
      nativeWorker.removeEventListener('messageerror', workerFailed);
      try { worker?.destroy(); } finally { terminate(); }
    }
  });
  worker = new pdfjs.PDFWorker({port: nativeWorker, verbosity: 0});

  // Only packaged CMaps/fonts may be fetched, with no credentials or redirects.
  // Document URLs, links, scripts and attachments are never requested or executed.
  class LocalBinaryDataFactory {
    async fetch({kind, filename}) {
      const directory = kind === 'cMapUrl' ? 'cmaps/' : kind === 'standardFontDataUrl' ? 'standard_fonts/' : null;
      if (!directory || typeof filename !== 'string' || !/^[A-Za-z0-9_-]+\.(?:bcmap|pfb|ttf)$/.test(filename)) {
        throw new Error('Unsupported PDF resource');
      }
      const response = await fetch(new URL(directory + filename, VENDOR), {
        signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error('Packaged PDF resource unavailable');
      return new Uint8Array(await response.arrayBuffer());
    }
  }
  loadingTask = pdfjs.getDocument({...parameters, worker, BinaryDataFactory: LocalBinaryDataFactory});
  return {promise: Promise.race([loadingTask.promise, workerFailure]), destroy: () => loadingTask.destroy()};
}

/**
 * Create a parser with an injectable document loader for fixed, offline tests.
 * Production callers should use extractReferencePdf(file, {onProgress}).
 * No text is interpreted as an instruction; the result remains untrusted source material.
 */
export function createReferencePdfExtractor({
  loadDocument = loadPdfDocument,
  cryptoImpl = globalThis.crypto,
  timeoutMs = TIMEOUT_MS,
  canvasFactory = () => globalThis.document?.createElement('canvas'),
} = {}) {
  return async function extract(file, {onProgress,signal,captureVisualPages=false,visualPages=null} = {}) {
    if (!file || !Number.isFinite(file.size) || typeof file.arrayBuffer !== 'function') {
      throw new ReferencePdfError('请选择一个 PDF 文件。', 'missing-file');
    }
    if (file.size > MAX_BYTES) throw new ReferencePdfError('PDF 超过 50 MB，请压缩或拆分后再添加。', 'too-large');
    if (file.size < 8) throw new ReferencePdfError('文件不是有效的 PDF。', 'invalid');
    if (!cryptoImpl?.subtle?.digest) throw new ReferencePdfError('当前页面无法计算文件指纹，请通过 HTTPS 或本机地址打开看板。', 'crypto-unavailable');
    const controller = new AbortController(), cleanups = [];
    let rejectAbort;
    const aborted = new Promise((_, reject) => {rejectAbort=reject;});
    let task, cancelled = false, timer;
    const ensureActive = () => { if (cancelled) throw controller.signal.reason; };
    const abort = () => {cancelled=true;const error=new ReferencePdfError('PDF 解析已取消。','cancelled');controller.abort(error);rejectAbort(error);};
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    const registerCleanup = cleanup => {
      if (cancelled) void boundedCleanup(cleanup);
      else cleanups.push(cleanup);
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        cancelled = true;
        const error = new ReferencePdfError('PDF 解析超时，已停止工作线程。请压缩或拆分文件后重试。', 'timeout');
        controller.abort(error); reject(error);
      }, timeoutMs);
    });
    const extraction = (async () => {
      report(onProgress, {stage: 'loading', page: 0, totalPages: 0});
      const buffer = await file.arrayBuffer(); ensureActive();
      const bytes = new Uint8Array(buffer);
      // Recheck actual length rather than trusting a filename, MIME or supplied size.
      if (bytes.byteLength > MAX_BYTES) throw new ReferencePdfError('PDF 超过 50 MB，请压缩或拆分后再添加。', 'too-large');
      if (!/^%PDF-\d\.\d/.test(new TextDecoder('ascii').decode(bytes.subarray(0, 8)))) {
        throw new ReferencePdfError('文件不是有效的 PDF，请勿仅修改扩展名。', 'invalid');
      }
      const hash = await cryptoImpl.subtle.digest('SHA-256', bytes); ensureActive();
      const sha256 = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
      task = await loadDocument({
        data: bytes,
        cMapUrl: new URL('cmaps/', VENDOR).href, cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', VENDOR).href,
        useWorkerFetch: false, useWasm: false,
        disableAutoFetch: true, disableStream: true, disableRange: true,
        disableFontFace: true, useSystemFonts: false,
        isEvalSupported: false, enableXfa: false, stopAtErrors: true,
        isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
        verbosity: 0,
      }, {signal: controller.signal, registerCleanup}); ensureActive();
      if (!task || !task.promise) throw new ReferencePdfError('PDF 解析器未能启动，请刷新网页后重试。', 'parser-unavailable');
      // Leave onPassword unset: PDF.js rejects rather than prompting or retrying passwords.
      const document = await task.promise; ensureActive();
      const pages = document.numPages;
      if (!Number.isInteger(pages) || pages < 1) throw new ReferencePdfError('PDF 没有可读取的页面。', 'invalid');
      if (pages > MAX_PAGES) throw new ReferencePdfError('PDF 超过 300 页，请拆分后再添加。', 'too-many-pages');
      const metadata = await document.getMetadata?.(); ensureActive();
      if (metadata?.info?.EncryptFilterName) throw new ReferencePdfError('此 PDF 已加密。请先在本机解密并另存后再添加。', 'encrypted');
      const text_pages = [], unread_pages = [], failed_pages = [];
      let text_characters = 0;
      report(onProgress, {stage: 'extracting', page: 0, totalPages: pages});
      for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
        ensureActive(); let page;
        try {
          page = await document.getPage(pageNumber); ensureActive();
          const content = await page.getTextContent({includeMarkedContent: false}); ensureActive();
          const text = pageText(content?.items);
          if (text.replace(/\s/g, '')) { text_pages.push({page: pageNumber, text}); text_characters += text.length; }
          else unread_pages.push(pageNumber);
        } catch (error) {
          ensureActive();
          if (error?.name === 'PasswordException') throw error;
          unread_pages.push(pageNumber); failed_pages.push(pageNumber);
        } finally { try { page?.cleanup(); } catch { /* no rendering resources */ } }
        report(onProgress, {stage: 'extracting', page: pageNumber, totalPages: pages});
      }
      if (!text_pages.length) {
        if (failed_pages.length === pages) throw new ReferencePdfError('PDF 所有页面均解析失败，无法可靠读取。请重新导出有效 PDF 后再添加。', 'invalid');
        throw new ReferencePdfError('未提取到可用文字。此文件可能是扫描件或图像型 PDF，请先完成 OCR 后再添加。', 'needs-ocr');
      }
      const warnings = [captureVisualPages?'已提取 PDF 文字，并尝试渲染选定页图；渲染本身不代表原图或公式已核验。':TEXT_ONLY_WARNING];
      if (unread_pages.length) warnings.push(`第 ${unread_pages.join('、')} 页没有可提取文字或无法读取，未将这些页面纳入研究范围依据。`);
      if (failed_pages.length) warnings.push(`第 ${failed_pages.join('、')} 页解析失败；已保留其他可读取页面的文字。`);
      const page_images=[];
      if(captureVisualPages){
        for(const pageNumber of (Array.isArray(visualPages)?[...new Set(visualPages)].filter(n=>Number.isInteger(n)&&n>=1&&n<=pages):selectVisualPages(text_pages))){
          ensureActive();let page,canvas,renderTask;
          const cancelRender=()=>{try{renderTask?.cancel();}catch{}if(canvas){canvas.width=0;canvas.height=0;}};
          controller.signal.addEventListener('abort',cancelRender,{once:true});
          try{
            page=await document.getPage(pageNumber);ensureActive();
            const original=page.getViewport({scale:1});
            if(!Number.isFinite(original.width)||!Number.isFinite(original.height)||original.width<=0||original.height<=0)throw new Error('页面尺寸无效');
            const scale=Math.min(1400/Math.max(original.width,original.height),Math.sqrt(1_600_000/(original.width*original.height)));
            const viewport=page.getViewport({scale});canvas=canvasFactory();
            if(!canvas?.getContext||!canvas?.toDataURL)throw new Error('页面图像组件不可用');
            canvas.width=Math.max(1,Math.floor(viewport.width));canvas.height=Math.max(1,Math.floor(viewport.height));
            const context=canvas.getContext('2d',{alpha:false});if(!context)throw new Error('页面画布不可用');
            renderTask=page.render({canvasContext:context,viewport,background:'#ffffff'});await renderTask.promise;ensureActive();
            let image_data_url=canvas.toDataURL('image/png');
            if(!sourceImageBytes(image_data_url))image_data_url=canvas.toDataURL('image/jpeg',0.72);
            const image=sourceImageBytes(image_data_url),image_sha256=await imageSha256(image_data_url,cryptoImpl);ensureActive();
            if(!image||!image_sha256)throw new Error('页面图像超过大小上限或格式无效');
            page_images.push({page:pageNumber,mime:image.mime,image_data_url,image_sha256,source_sha256:sha256,width:canvas.width,height:canvas.height});
            report(onProgress,{stage:'rendering',page:pageNumber,totalPages:pages});
          }catch(error){ensureActive();warnings.push(`PDF 第 ${pageNumber} 页图像未取得：${error.message}`);}
          finally{controller.signal.removeEventListener('abort',cancelRender);try{page?.cleanup();}catch{}if(canvas){canvas.width=0;canvas.height=0;}}
        }
      }
      return {sha256, pages, text_pages, text_characters, text_page_count: text_pages.length, unread_pages, warnings, extraction_status:page_images.length?'text-with-rendered-pages':'text-only',...(captureVisualPages?{page_images}: {})};
    })();
    try { return await Promise.race([extraction, timeout, aborted]); }
    catch (error) { throw readableError(error); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
      // The injected loader contract may register extra worker resources. Always
      // destroy the loading task as well, including password and page-count errors.
      cancelled = true;
      if (task && !cleanups.length) await boundedCleanup(() => task.destroy?.());
      await Promise.allSettled(cleanups.map(cleanup => boundedCleanup(cleanup)));
      if (!controller.signal.aborted) controller.abort(new ReferencePdfError('PDF 解析已结束。', 'finished'));
    }
  };
}

export async function extractReferencePdf(file, options = {}) {
  return createReferencePdfExtractor()(file, options);
}
