import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../demos/skill-offline/',import.meta.url));
const read=name=>readFileSync(path.join(root,name));
const json=name=>JSON.parse(read(name).toString('utf8'));
const html=read('index.html').toString('utf8');

test('skill demo links resolve within its portable folder without remote executable dependencies',()=>{
  const links=[...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match=>match[1]);assert.ok(links.length>0);
  for(const link of links){assert.doesNotMatch(link,/^[a-z]+:|^\/\//i);const resolved=path.resolve(root,decodeURIComponent(link.split(/[?#]/)[0]));assert.equal(path.relative(root,resolved).startsWith('..'),false);assert.ok(existsSync(resolved),link);}
  assert.doesNotMatch(html,/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=|\bfetch\s*\(/i);
});

test('synthetic demo source fingerprints agree with saved bytes and evidence across checkouts',()=>{
  for(const id of ['R001','R002']){
    const base=`2026-10-22/${id}/`,map=json(base+'source/source_map.json'),source=read(base+'source/'+map.path),fingerprint=createHash('sha256').update(source).digest('hex');
    assert.equal(source.includes(Buffer.from('\r\n')),false,'Demo source uses stable LF line endings');assert.equal(map.sha256,fingerprint);
    const evidence=json(base+'evidence.json');assert.equal(evidence.sources.find(item=>item.path==='source/'+map.path).sha256,fingerprint);assert.equal(map.synthetic,true);assert.equal(map.visual_inspection_performed,false);
  }
});

test('published demo preserves its fictional identity and cannot count as completed paper reading',()=>{
  const records=['R001','R002'].map(id=>json(`2026-10-22/${id}/metadata.json`));assert.deepEqual(records.map(item=>item.reading_status),['partial','candidate']);
  for(const record of records){assert.equal(record.synthetic,true);assert.match(record.title,/合成/);assert.equal(record.doi,'');assert.ok(record.authors.every(author=>author.includes('虚构')));}
});
