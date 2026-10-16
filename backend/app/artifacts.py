import hashlib
import html
import io
import json
import re
import zipfile
import os
from pathlib import Path

from markdown_it import MarkdownIt
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from .config import MAX_PAGES

WATERMARK = '分析采用 norman-paper-reading 技能｜作者：N同学｜小红书：N同学｜B站/抖音：耐心的N同学\nAnalysis performed using the norman-paper-reading skill | Author: N同学 | Xiaohongshu: N同学 | Bilibili/Douyin: 耐心的N同学'


def inspect_pdf(path):
    if path.stat().st_size > 50 * 1024 * 1024 or path.read_bytes()[:5] != b'%PDF-':
        raise ValueError('无效或超过 50 MB 的 PDF')
    try:
        r = PdfReader(path)
    except Exception as exc:
        raise ValueError('PDF 结构无法可靠读取，请提供完整有效的文件') from exc
    if r.is_encrypted:
        raise ValueError('PDF 已加密，请提供可读取版本')
    if not 0 < len(r.pages) <= MAX_PAGES:
        raise ValueError('PDF 页数必须在 1–300 页之间')
    texts = [p.extract_text() or '' for p in r.pages]
    if sum(len(t.strip()) for t in texts) < 100:
        raise ValueError('PDF 缺少可可靠读取的文本，扫描件需先进行 OCR')
    return texts


def challenge_image(folder):
    """Generate an actual visual OCR probe, not a text-only capability flag."""
    import pypdfium2 as pdfium
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    writer = PdfWriter()
    page = writer.add_blank_page(240, 100)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica-Bold')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b'BT /F1 45 Tf 35 35 Td (7319) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream)
    source = folder / 'probe.pdf'
    writer.write(source)
    doc = pdfium.PdfDocument(source)
    image = folder / 'probe.png'
    bitmap = doc[0].render(scale=2)
    bitmap.to_pil().save(image)
    doc.close()
    return image


def flow_svg(steps):
    esc = html.escape
    height = 70 + 105 * len(steps)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="{height}" viewBox="0 0 800 {height}" role="img"><title>分析者绘制的研究流程示意，非原论文图</title><rect width="800" height="100%" fill="#f1f5f4"/><text x="30" y="32" font-family="sans-serif" fill="#526760" font-size="16">分析者绘制 · 研究流程示意 · 非原论文图</text>']
    for i, step in enumerate(steps):
        y = 55 + i * 105
        out.append(f'<rect x="30" y="{y}" width="740" height="78" rx="12" fill="white" stroke="#cbd8d3"/><text x="48" y="{y+28}" font-family="sans-serif" font-size="16" fill="#173d34">{i+1:02d}</text>')
        chunks = [str(step)[j:j+36] for j in range(0, min(len(str(step)), 72), 36)]
        for k, line in enumerate(chunks):
            out.append(f'<text x="92" y="{y+28+k*23}" font-family="sans-serif" font-size="16" fill="#173d34">{esc(line)}</text>')
        if i < len(steps)-1:
            out.append(f'<path d="M400 {y+80} v18 m-5 -5 l5 5 5 -5" stroke="#557b6d" fill="none"/>')
    return ''.join(out) + '</svg>'


def evidence_bundle(meta, analysis, source_map):
    blocks = {b['id']: b for b in source_map['blocks']}
    claims, evidence, links = [], [], []
    for i, e in enumerate(analysis['evidence'], 1):
        cid = f'C{i:02d}'
        claims.append({'id': cid, 'statement': e['claim'], 'origin': e.get('origin', 'analyst_inference'), 'caveat': e['limits']})
        evidence.append({'id': e['id'], 'kind': 'text', 'locator': '; '.join(str(blocks[x].get('locator') or ('PDF p.' + str(blocks[x].get('page', '?')))) for x in e['source_block_ids']), 'source_ids': e['source_block_ids'], 'observation': e['observation'], 'inspection': 'verified'})
        links.append({'claim_id': cid, 'evidence_id': e['id'], 'relation': 'supports', 'strength': 'uncertain', 'rationale': e['interpretation']})
    return {'schema_version': 1, 'paper': {'title': meta['title'], 'url': meta.get('url', ''), 'version': meta.get('publication_status', 'unknown'), 'source_sha256': analysis.get('source_sha256', ''), 'scope': analysis.get('coverage', {})}, 'claims': claims, 'evidence': evidence, 'links': links, 'branches': [], 'action_status':analysis.get('action_status',''), 'actions': [dict(id=a['id'], gap=a['gap'], question=a['title'], hypothesis=a['hypothesis'], method=a['method'], controls=a['controls'], decision_rule='支持：'+a['supporting']+'；削弱：'+a['weakening'], resources=a['resources'], feasibility='requires_resources', evidence_ids=a['evidence_ids'], priority=a['priority'], deliverable=a['deliverable']) for a in analysis['actions']]}


def markdown_note(meta, a):
    text = [f'# {meta["title"]}', '', f'> extend · DOI: {meta.get("doi", "未提供")} · 来源: {meta.get("url", "未提供")}', '', '## 论文总结', a['summary'], '## 科学问题', a['scientific_question'], '## 阅读范围与核验状态', json.dumps(a.get('coverage', {}), ensure_ascii=False), a.get('verification_status', '未核验'), '## 完整研究脉络', '### 作者结论', a['author_conclusions'], '### 分析者推断', a['analyst_inference'], '## 分析者绘制的研究流程', '![分析者绘制，非原论文图](assets/research-flow.svg)', '## 关键设计与研究重建']
    for key, label in [('variables','变量'),('samples','样本'),('equipment','设备'),('parameters','参数'),('controls','对照'),('repeats','独立重复'),('statistics','统计单位与分析')]:
        text.extend(['### ' + label, a[key]])
    text.append('## 原图、表与必要公式核验')
    for v in a.get('visuals', []):
        text.extend(['### ' + v['label'], f'![原始整页，保留上下文](assets/page-{v["page"]}.png)', f'来源：PDF第 {v["page"]} 页；{v["kind"]}；原始整页可能包含相邻图表。', v['explanation'], '局限：' + v['limitations']])
    text.append('## 证据卡')
    for e in a['evidence']:
        text.extend(['### ' + e['id'], e['claim'], '观察：'+e['observation'], '定位：'+', '.join(e['source_block_ids']), '解释：'+e['interpretation'], '边界：'+e['limits']])
    text.extend(['## 待精读清单'] + ['- ' + x for x in a['reading_list']])
    text.extend(['## 未读与未核验材料'] + ['- ' + x for x in a.get('unread', [])])
    text.extend(['## 未来研究启示', a['future_insights'], '## 迁移条件', a['transfer_conditions'], '## 复现检查清单'] + ['- ' + x for x in a['reproduction_checklist']])
    text.append('## 研究行动卡（待执行）')
    for action in a['actions']:
        text.extend(['### ' + action['id'] + ' ' + action['title']])
        for key, label in [('evidence_ids','证据'),('gap','缺口'),('hypothesis','假设'),('method','方法'),('controls','对照'),('supporting','支持方向'),('weakening','削弱方向'),('resources','资源'),('priority','优先级'),('deliverable','交付成果'),('sample_size_basis','样本量与阈值依据')]:
            text.append(f'**{label}**：' + (', '.join(action[key]) if isinstance(action[key], list) else action[key]))
    text.extend(['## 优先研究路线图', a['roadmap'], '## 来源与阅读记录'] + ['- ' + x for x in a['sources']])
    text.extend(['', WATERMARK.replace('\n', '  \n')])
    return '\n\n'.join(text) + '\n'


def write_artifacts(folder, meta, analysis, source_map):
    folder = Path(folder)
    (folder / 'assets').mkdir(exist_ok=True)
    (folder / 'assets/research-flow.svg').write_text(flow_svg(analysis['flow_steps']), 'utf-8')
    (folder / 'reading-note.md').write_text(markdown_note(meta, analysis), 'utf-8')
    (folder / 'evidence.json').write_text(json.dumps(evidence_bundle(meta, analysis, source_map), ensure_ascii=False, indent=2), 'utf-8')
    (folder / 'analysis.json').write_text(json.dumps(analysis, ensure_ascii=False, indent=2), 'utf-8')


def rendered_note(markdown):
    # HTML disabled. Links remain text unless HTTPS; relative image assets are local.
    md = MarkdownIt('commonmark', {'html': False})
    md.validateLink = lambda url: not re.match(r'(?i)^(?:javascript|vbscript|data|file):', url)
    original_image = md.renderer.rules['image']
    def safe_image(tokens, idx, options, env):
        src = tokens[idx].attrGet('src') or ''
        if not re.fullmatch(r'assets/(?:research-flow\.svg|page-\d+\.png)', src):
            return '<span>[非本地图片已省略]</span>'
        return original_image(tokens, idx, options, env)
    md.renderer.rules['image'] = safe_image
    return md.render(markdown)


def export_zip(papers, kind, data_root):
    """One source note/evidence set feeds all exports. No credentials or PDFs."""
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as z:
        frontend = Path(os.getenv('FRONTEND_DIR', str(Path(__file__).resolve().parents[2] / 'frontend')))
        math_ready = kind == 'html' and (frontend / 'vendor/temml.min.js').is_file()
        if math_ready:
            for path in (frontend / 'vendor').glob('*'):
                if path.is_file():
                    z.write(path, 'vendor/' + path.name)
            z.write(frontend / 'math-init.js', 'math-init.js')
        index = []
        for p in papers:
            prefix = p['id']
            folder = Path(data_root) / p['analysis']['artifact_dir']
            if not folder.resolve().is_relative_to(Path(data_root).resolve()):
                raise ValueError('无效导出路径')
            note = markdown_note(p, p['analysis'])
            z.writestr(prefix + '/reading-note.md', note)
            for name in ['evidence.json', 'source/source_map.json']:
                path = folder / name
                if path.exists():
                    z.write(path, prefix + '/' + name)
            if kind == 'html':
                body = rendered_note(note)
                math = '<link rel="stylesheet" href="../vendor/Temml-Local.css"><script defer src="../vendor/temml.min.js"></script><script defer src="../math-init.js"></script>' if math_ready else ''
                z.writestr(prefix + '/index.html', '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+html.escape(p['title'])+'</title>'+math+'<style>body{max-width:960px;margin:40px auto;padding:20px;font:17px/1.8 system-ui;color:#183b35}img{max-width:100%;height:auto}pre{white-space:pre-wrap}h2{margin-top:2em}</style><a href="../index.html">返回文献库</a>'+body+'</html>')
            for path in (folder / 'assets').glob('*'):
                if path.suffix in ('.png', '.svg'):
                    z.write(path, prefix + '/assets/' + path.name)
            index.append(f'<li><a href="{prefix}/index.html">{html.escape(p["title"])}</a></li>')
        clean = json.loads(json.dumps(papers))
        for p in clean:
            p['analysis'].pop('artifact_dir', None)
        z.writestr('papers.json', json.dumps(clean, ensure_ascii=False, indent=2))
        if kind == 'html':
            z.writestr('index.html', '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>研究文献库</title><h1>研究文献库</h1><p>私人导出 · 研究行动均为待执行方案</p><ul>'+''.join(index)+'</ul></html>')
    return stream.getvalue()
