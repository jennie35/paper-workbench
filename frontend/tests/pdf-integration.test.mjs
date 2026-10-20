// Real PDF.js text-core acceptance with synthetic files. This uses PDF.js's Node
// fake worker and local resource reads; it does not validate browser Worker/CSP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto, createHash} from 'node:crypto';
import * as pdfjs from '../vendor/pdfjs/legacy/build/pdf.mjs';
import {createReferencePdfExtractor} from '../pdf-reference.js';

const VENDOR = new URL('../vendor/pdfjs/', import.meta.url);
const FIXTURES = new URL('./fixtures/', import.meta.url);

function realExtractor() {
  const fetched = [], state = {destroyed:0};
  class LocalBinaryDataFactory {
    async fetch({kind, filename}) {
      const folder = kind === 'cMapUrl' ? 'cmaps/' : kind === 'standardFontDataUrl' ? 'standard_fonts/' : null;
      assert.ok(folder, 'only packaged text resources may be requested');
      assert.match(filename, /^[A-Za-z0-9_-]+\.(?:bcmap|pfb|ttf)$/);
      fetched.push({kind, filename});
      return new Uint8Array(await readFile(new URL(folder + filename, VENDOR)));
    }
  }
  const loadDocument = async parameters => {
    const loading = pdfjs.getDocument({...parameters, BinaryDataFactory: LocalBinaryDataFactory});
    return {promise:loading.promise, async destroy() {state.destroyed += 1; await loading.destroy();}};
  };
  return {extract:createReferencePdfExtractor({loadDocument, cryptoImpl:webcrypto, timeoutMs:15000}), fetched, state};
}

async function sourceFile(filename) {
  const bytes = await readFile(new URL(filename, FIXTURES));
  return {name:filename, size:bytes.length, async arrayBuffer() {return Uint8Array.from(bytes).buffer;}};
}

test('real PDF.js reads a synthetic CJK PDF using bundled CMaps and records its blank page', async () => {
  const file = await sourceFile('cjk-reference-with-blank.pdf');
  const {extract, fetched, state} = realExtractor();
  const result = await extract(file);
  assert.equal(result.pages, 2);
  assert.equal(result.text_page_count, 1);
  assert.deepEqual(result.unread_pages, [2]);
  assert.match(result.text_pages[0].text, /全彩模型色差测量与几何质量评价/);
  assert.match(result.text_pages[0].text, /如何控制测量条件并建立可重复的实验对照/);
  assert.match(result.text_pages[0].text, /color measurement and reproducible controls/);
  assert.ok(fetched.some(item => item.kind === 'cMapUrl'), 'CJK parsing must exercise the packaged CMaps');
  assert.equal(result.sha256, createHash('sha256').update(new Uint8Array(await file.arrayBuffer())).digest('hex'));
  assert.match(result.warnings.join('\n'), /第 2 页/);
  assert.equal(result.extraction_status, 'text-only');
  assert.equal(result.verified, undefined);
  assert.equal(state.destroyed, 1);
});

test('real PDF.js extracts actual English source text without claiming image verification', async () => {
  const {extract, state} = realExtractor();
  const result = await extract(await sourceFile('english-reference.pdf'));
  assert.equal(result.pages, 1);
  assert.deepEqual(result.unread_pages, []);
  assert.match(result.text_pages[0].text, /Synthetic reference PDF: measurement methods and controls\./);
  assert.equal(result.text_characters, result.text_pages[0].text.length);
  assert.match(result.warnings.join('\n'), /未进行 OCR、原图或公式视觉核验/);
  assert.equal(state.destroyed, 1);
});

test('real PDF.js rejects an image-only synthetic PDF as needing OCR', async () => {
  const {extract, state} = realExtractor();
  await assert.rejects(extract(await sourceFile('scan-only.pdf')), error => error.code === 'needs-ocr');
  assert.equal(state.destroyed, 1);
});

test('real PDF.js rejects an encrypted synthetic PDF and cleans up its task', async () => {
  const {extract, state} = realExtractor();
  await assert.rejects(extract(await sourceFile('encrypted-reference.pdf')), error => error.code === 'encrypted');
  assert.equal(state.destroyed, 1);
});
