import test from 'node:test';
import assert from 'node:assert/strict';
import {importPreviewHtml} from '../research-import-ui.js';
test('ambiguous title aliases are shown for review and never preselected',()=>{
  const html=importPreviewHtml([{id:'first',metadata:{title:'顏色測量',authors:['张三']},warnings:['作者信息待确认'],possible_duplicates:[{title:'颜色测量',paper_id:'R001'}]},{id:'second',metadata:{title:'Other',authors:[]}}]);
  assert.match(html,/疑似简繁或题名别名重复/);assert.match(html,/颜色测量/);assert.match(html,/作者信息待确认/);
  assert.doesNotMatch(html.match(/<input[^>]*data-import-id="first"[^>]*>/)[0],/checked/);
  assert.match(html.match(/<input[^>]*data-import-id="second"[^>]*>/)[0],/checked/);
});
test('untrusted imported titles and warnings remain escaped text',()=>{
  const html=importPreviewHtml([{id:'" onfocus="bad',metadata:{title:'<script>bad()</script>',authors:['<img src=x>']},warnings:['<svg onload=bad>'],possible_duplicates:['<a>bad</a>']}]);
  assert.doesNotMatch(html,/<script>|<img|<svg|<a>/);assert.match(html,/&lt;script&gt;/);
});
