import hashlib
import html
import io
import json
import re
import zipfile
import os
import datetime as dt
import uuid
import shutil
import subprocess
from pathlib import Path

from markdown_it import MarkdownIt
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from .config import MAX_PAGES
from .visual_review import project_visual_evidence, report_visuals, DETAIL_FIELDS, meaningful

WATERMARK = '分析采用 norman-paper-reading 技能｜作者：N同学｜小红书：N同学｜B站/抖音：耐心的N同学\nAnalysis performed using the norman-paper-reading skill | Author: N同学 | Xiaohongshu: N同学 | Bilibili/Douyin: 耐心的N同学'


def ocr_page(path, page):
    """OCR an unmodified source page with fixed, non-shell Tesseract arguments."""
    import pypdfium2 as pdfium
    executable = shutil.which('tesseract')
    if not executable:
        raise ValueError('扫描页需要 OCR：请安装 Tesseract 及 chi_sim、chi_tra、eng 语言包')
    document = pdfium.PdfDocument(path)
    try:
        original = document[page - 1]
        scale = min(3, 2200 / max(original.get_size()))
        bitmap = original.render(scale=scale)
        try:
            buffer = io.BytesIO()
            bitmap.to_pil().save(buffer, format='PNG')
        finally:
            bitmap.close()
            original.close()
    finally:
        document.close()
    result = subprocess.run([executable, 'stdin', 'stdout', '-l', 'chi_sim+chi_tra+eng',
                             '--oem', '1', '--psm', '3'], input=buffer.getvalue(),
                            capture_output=True, timeout=120, check=False)
    if result.returncode:
        raise ValueError('扫描页 OCR 未成功，请检查 Tesseract 中英文语言包或上传更清晰正文')
    return result.stdout.decode('utf-8', errors='replace').strip()


def inspect_pdf(path, *, page_records=None):
    path = Path(path)
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
    texts = []
    for number, page in enumerate(r.pages, 1):
        try:
            text = page.extract_text() or ''
        except Exception:
            text = ''
        method, error = 'pdf_text', ''
        # Sparse pages can be figures or scans; OCR helps locate them but never
        # constitutes visual inspection of a figure/table/equation.
        if len(re.sub(r'\s', '', text)) < 40 or text.count('\ufffd') > max(2, len(text) * .05):
            try:
                recognized = ocr_page(path, number)
                if len(recognized.strip()) > len(text.strip()):
                    text, method = recognized, 'tesseract:chi_sim+chi_tra+eng:oem1:psm3'
            except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
                error = str(exc) if isinstance(exc, ValueError) else '扫描页 OCR 超时或不可用'
        texts.append(text)
        if page_records is not None:
            page_records.append({'page': number, 'method': method,
                                 'readable': bool(text.strip()), 'notice': error})
    if sum(len(t.strip()) for t in texts) < 100:
        raise ValueError('PDF 缺少可可靠读取的文本；扫描页 OCR 不可用或识别不足，请补充清晰正文')
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
        evidence.append({'id': e['id'], 'kind': 'text', 'locator': '; '.join(str(blocks[x].get('locator') or ('PDF p.' + str(blocks[x].get('page', '?')))) for x in e['source_block_ids']), 'source_ids': e['source_block_ids'], 'observation': e['observation'], 'inspection': 'verified',
                         'inspection_method': 'source_text_location', 'scientific_verification': 'not_established'})
        links.append({'claim_id': cid, 'evidence_id': e['id'], 'relation': 'supports', 'strength': 'uncertain', 'rationale': e['interpretation']})
    result = {'schema_version': 1, 'paper': {'title': meta['title'], 'url': meta.get('url', ''), 'version': meta.get('publication_status', 'unknown'), 'source_sha256': analysis.get('source_sha256', ''), 'scope': analysis.get('coverage', {})}, 'claims': claims, 'evidence': evidence, 'links': links, 'branches': [], 'action_status':analysis.get('action_status',''), 'actions': [dict(id=a['id'], gap=a['gap'], question=a['title'], hypothesis=a['hypothesis'], method=a['method'], controls=a['controls'], decision_rule='支持：'+a['supporting']+'；削弱：'+a['weakening'], resources=a['resources'], feasibility='requires_resources', evidence_ids=a['evidence_ids'], priority=a['priority'], deliverable=a['deliverable']) for a in analysis['actions']]}


    result['research_logic'] = analysis.get('research_logic')
    result['visuals'] = report_visuals(analysis)
    if analysis.get('visual_review_audit'):
        result['visual_review_audit'] = analysis['visual_review_audit']
    for key in ('doi', 'authors', 'journal', 'first_publication_date',
                'first_publication_date_status', 'publication_date',
                'publication_date_status', 'publication_date_precision',
                'publication_dates', 'online_date', 'print_date', 'year',
                'issue_year', 'volume', 'issue', 'pages', 'article_number',
                'publication_status', 'versions', 'source'):
        if key in meta:
            result['paper'][key] = meta[key]
    result['paper']['source_version'] = analysis.get('source_version', '未核验')
    result['project_context'] = analysis.get('project_context') or {
        'scope_snapshot': None,
        'notice': '旧记录未保留阅读时的课题配置，不推定其条件等于当前配置'}
    result['verification_status'] = analysis.get('verification_status', 'unverified')
    result['actions'] = [dict(a, question=a.get('question') or a['title'],
                              decision_rule='支持：' + a['supporting'] + '；削弱：' + a['weakening'],
                              feasibility='requires_resources', status='pending') for a in analysis['actions']]
    return result


def markdown_note(meta, a):
    logic = a.get('research_logic') or {}
    def value(item):
        return json.dumps(item, ensure_ascii=False) if isinstance(item, (dict, list)) else str(item)
    def fields(items, labels=None):
        for key, item in items.items():
            text.append('**' + (labels or {}).get(key, key) + '**：' + value(item))
    text = [f'# {meta["title"]}', '', '## 1. 题录与阅读范围',
            '> extend · DOI: ' + str(meta.get('doi') or '未提供') + ' · 来源: ' + str(meta.get('url') or '未提供')]
    fields({k: meta.get(k, '未核验') for k in ('authors', 'journal', 'first_publication_date', 'first_publication_date_status', 'publication_date', 'publication_dates', 'year', 'volume', 'issue', 'pages', 'publication_status', 'versions')},
           {'authors':'作者', 'journal':'期刊或会议', 'first_publication_date':'来源记录中最早发表日期（未知时不推定）', 'first_publication_date_status':'首次发表日期来源边界', 'publication_date':'已知发表日期（保留核实精度）', 'publication_dates':'来源提供的在线和印刷日期差异', 'year':'卷期年份', 'volume':'卷', 'issue':'期', 'pages':'页码', 'publication_status':'发表状态', 'versions':'版本关系'})
    text.extend(['分析日期：' + a.get('analyzed_date', '未记录'), '### 阅读范围与核验状态',
                 value(logic.get('reading_scope', a.get('coverage', {}))), a.get('verification_status', '未核验'),
                 '结构校验通过不证明科学结论成立；研究行动均为待执行建议。'])
    context = a.get('project_context')
    if context:
        text.extend(['### 本次阅读时的课题配置', value(context),
                     '此配置是分析时的条件快照；后续修改课题配置不会追溯改变原始报告。'])
    else:
        text.append('阅读时的课题配置未记录；不推定原始条件等于当前配置。')
    text.extend(['## 2. 论文总结', a['summary'], '## 3. 科学问题与研究主线', a['scientific_question']])
    if logic.get('storyline'):
        fields(logic['storyline'], {'author_question':'作者明确的问题', 'reconstructed_question':'分析者重建的问题', 'gap':'既有方法缺口', 'hypothesis':'核心假设', 'reasoning':'问题到结论的推理链'})
    text.extend(['## 4. 研究流程示意', '![分析者绘制，非论文原图](assets/research-flow.svg)',
                 '## 5. 重建研究设计'])
    design = logic.get('study_design') or {}
    text.append('论文类型：' + design.get('type', 'unknown'))
    fields(design.get('fields') or {})
    for key, label in [('variables','变量'),('samples','样本'),('equipment','设备'),('parameters','参数'),('controls','对照'),('repeats','独立重复'),('statistics','统计单位与方法')]:
        text.extend(['### ' + label, a[key]])
    text.append('## 6. 关键设计决策')
    for i, decision in enumerate(logic.get('design_decisions', []), 1):
        text.append('### D' + str(i).zfill(2))
        fields(decision, {'decision':'作者选择', 'problem':'解决的问题', 'rationale':'选择理由', 'rationale_origin':'理由来源', 'cost':'引入的代价', 'alternative':'合理替代', 'source_block_ids':'来源块'})
    if not logic.get('design_decisions'):
        text.append('本记录尚未单独核验设计决策，不能推定作者动机。')
    visuals = report_visuals(a)
    if visuals:
        text.append('## 7. 精选原图、表格与公式核验')
    for v in visuals:
        text.extend(['### ' + v['label'], f'![原始整页，保留上下文]({v["asset_path"]})',
                     f'来源：{v["locator"]}；{v["kind"]}；原始整页可能包含相邻图表。',
                     '视觉模型核验 · 未经人工复核', v['explanation']])
        if v.get('source_url'):
            text.append('原文来源：' + v['source_url'])
        if v['kind'] == 'equation' and meaningful(v.get('latex')):
            text.append('原式转写（与原页对照）：\n\n$$\n' + v['latex'] + '\n$$')
        labels = {'claim':'支持的结论', 'comparison':'比较对象与面板', 'axes_units':'坐标与单位', 'statistical_unit':'统计单位', 'uncertainty':'效应与不确定性', 'consistency':'正文图注公式一致性', 'purpose':'公式用途', 'symbols':'公式符号与单位', 'measurand':'被测量', 'applicability':'适用条件', 'panels':'子图', 'error_bars':'误差条', 'effect_size':'效应大小', 'limitations':'局限'}
        fields({key: v[key] for key in (*DETAIL_FIELDS, 'limitations') if key != 'latex' and meaningful(v.get(key))}, labels)
    text.extend(['## 8. 结论、证据与局限', '### 作者报告的结果与解释', a['author_conclusions'], '### 分析者判断或推断', a['analyst_inference']])
    fields(logic.get('conclusion_layers') or {}, {'author_results':'作者报告的结果', 'author_interpretation':'作者解释', 'analyst_inference':'分析者推断', 'unverified_hypotheses':'尚待验证的假设'})
    for e in a['evidence']:
        text.extend(['### ' + e['id'], e['claim'], '性质：' + e.get('origin', 'analyst_inference'),
                     '观察：'+e['observation'], '定位：'+', '.join(e['source_block_ids']), '解释：'+e['interpretation'], '边界：'+e['limits']])
    for pitfall in logic.get('pitfalls', []):
        text.append('检查：' + pitfall['kind'] + '；' + pitfall['assessment'] + '；来源：' + ', '.join(pitfall.get('source_block_ids', [])))
    text.extend(['### 未读与未核验材料'] + ['- ' + x for x in a.get('unread', [])])
    text.append('## 9. 需要重点精读的部分')
    for priority in logic.get('reading_priorities', []):
        fields(priority, {'kind':'类型', 'locator':'具体位置', 'reason':'精读原因', 'decision_impact':'影响的研究判断', 'source_block_ids':'来源块'})
    text.extend(['- ' + x for x in a['reading_list']])
    text.extend(['## 10. 未来研究启示', a['future_insights'], '### 迁移条件', a['transfer_conditions']])
    fields(logic.get('transfer_insights') or {}, {'direct':'可以直接借鉴', 'adapt':'需要修改后验证', 'avoid':'目前不宜迁移', 'judgement_change':'本课题判断如何改变'})
    text.extend(['## 11. 下一步研究规划与行动卡', '### 复现检查清单'] + ['- ' + x for x in a['reproduction_checklist']])
    for action in a['actions']:
        text.extend(['### ' + action['id'] + ' ' + action['title'] + '（待执行）'])
        for key, label in [('evidence_ids','证据'),('gap','缺口'),('question','待回答问题'),('hypothesis','可被否定的假设'),('method','方法'),('data','数据'),('experimental_unit','独立实验单位'),('controls','基线与对照'),('confounds','混杂控制'),('supporting','支持方向'),('weakening','否定或削弱方向'),('criteria_basis','判断依据'),('resources','已知或缺少资源'),('prerequisites','前置条件'),('priority','优先级'),('deliverable','交付成果'),('sample_size_basis','样本量与阈值依据'),('stopping_criteria','停止条件')]:
            text.append(f'**{label}**：' + value(action.get(key, '未报告；执行前须明确')))
    if not a['actions']:
        text.append(a.get('action_status', '证据不足，须先补齐资料。'))
    text.extend(['### 优先研究路线图', a['roadmap'], '### 来源与阅读记录'] + ['- ' + x for x in a['sources']])
    if (a.get('reading_skill') == 'norman-paper-reading'
            and (a.get('skill_applied') is True or a.get('structural_validation') == 'norman_native_passed')):
        text.extend(['', WATERMARK.replace('\n', '  \n')])
    else:
        text.extend(['', '分析使用 Paper Workbench 内置研究流程；未应用 norman-paper-reading 技能。'])
    return '\n\n'.join(text) + '\n'


def write_artifacts(folder, meta, analysis, source_map):
    folder = Path(folder)
    (folder / 'assets').mkdir(exist_ok=True)
    (folder / 'assets/research-flow.svg').write_text(flow_svg(analysis['flow_steps']), 'utf-8')
    (folder / 'reading-note.md').write_text(markdown_note(meta, analysis), 'utf-8')
    (folder / 'evidence.json').write_text(json.dumps(evidence_bundle(meta, analysis, source_map), ensure_ascii=False, indent=2), 'utf-8')
    (folder / 'analysis.json').write_text(json.dumps(analysis, ensure_ascii=False, indent=2), 'utf-8')


def write_record_index(data_root, number, meta, analysis, *, on_created=None):
    """Dated note/evidence views reference one canonical PDF/image set in DATA.

    Prepare inside DATA and promote only a complete view. Never overwrite an
    existing different source or delete a canonical source while indexing.
    """
    root = Path(data_root).resolve()
    canonical = (root / analysis.get('artifact_dir', '')).resolve()
    if not analysis.get('artifact_dir') or not canonical.is_relative_to(root) or canonical == root:
        return None
    if not (canonical / 'reading-note.md').is_file() or not (canonical / 'evidence.json').is_file():
        return None
    date = str(analysis.get('analyzed_date') or dt.datetime.now(dt.timezone.utc).date().isoformat())
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):
        raise ValueError('分析日期无效，不能建立长期目录')
    day = dt.date.fromisoformat(date).isoformat()
    final = root / day / f'R{number:03d}'
    if final.resolve() != final or not final.resolve().is_relative_to(root):
        raise ValueError('长期记录目录必须位于配置主目录内')
    manifest = {'schema_version': 1, 'paper_id': f'R{number:03d}', 'doi': meta.get('doi', ''),
                'source_sha256': analysis.get('source_sha256', ''),
                'canonical_artifact_dir': canonical.relative_to(root).as_posix(),
                'notice': '此目录是主目录内的日期视图；PDF、来源映射和原图仅在 canonical_artifact_dir 保存一份。'}
    if final.exists():
        saved = json.loads((final / 'record.json').read_text('utf-8'))
        if any(saved.get(k) != manifest[k] for k in ('doi', 'source_sha256', 'canonical_artifact_dir')):
            raise ValueError('长期记录目录已有不同来源，已保留旧版；请检查台账后恢复')
        return final.relative_to(root).as_posix()
    stage = root / '.staging' / ('record-' + uuid.uuid4().hex)
    if stage.resolve() != stage or not stage.resolve().is_relative_to(root):
        raise ValueError('临时目录必须位于配置主目录内')
    (stage / 'source').mkdir(parents=True)
    (stage / 'assets').mkdir()
    relative = Path(os.path.relpath(canonical, final)).as_posix()
    note = (canonical / 'reading-note.md').read_text('utf-8').replace('](assets/', '](' + relative + '/assets/')
    (stage / 'reading-note.md').write_text(note, 'utf-8')
    (stage / 'evidence.json').write_bytes((canonical / 'evidence.json').read_bytes())
    (stage / 'record.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), 'utf-8')
    for kind in ('source', 'assets'):
        pointer = {'relative_path': relative + '/' + kind, 'canonical_artifact_dir': manifest['canonical_artifact_dir']}
        if kind == 'source':
            pointer.update(original_pdf=relative + '/paper.pdf', source_map=relative + '/source/source_map.json')
        (stage / kind / 'reference.json').write_text(json.dumps(pointer, ensure_ascii=False), 'utf-8')
    final.parent.mkdir(parents=True, exist_ok=True)
    stage.rename(final)
    if on_created:
        on_created(final)
    return final.relative_to(root).as_posix()


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


def export_zip(papers, kind, data_root, *, bundle=None):
    """One source note/evidence set feeds all exports. No credentials or PDFs."""
    stream = io.BytesIO()
    from .exporting import clean_export, offline_index, project_markdown
    projected_papers = []
    root = Path(data_root).resolve()
    for p in papers:
        folder = root / p['analysis']['artifact_dir']
        if folder == root or folder.resolve() != folder or not folder.is_relative_to(root):
            raise ValueError('无效导出路径')
        projected_papers.append(dict(p, analysis=project_visual_evidence(p['analysis'], folder, p.get('url', ''))))
    papers = projected_papers
    bundle = dict(bundle or {'schema_version': 2, 'project': {'name': '研究文献库'},
                            'jobs': [], 'references': []}, papers=papers)
    bundle = clean_export(bundle)
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
            folder = root / p['analysis']['artifact_dir']
            note = markdown_note(p, p['analysis'])
            z.writestr(prefix + '/reading-note.md', note)
            evidence_path = folder / 'evidence.json'
            try:
                evidence = json.loads(evidence_path.read_text('utf-8-sig')) if evidence_path.resolve() == evidence_path and evidence_path.is_file() else {}
            except (OSError, ValueError):
                evidence = {}
            evidence = evidence if isinstance(evidence, dict) else {}
            evidence.update(research_logic=p['analysis'].get('research_logic'),
                            visuals=report_visuals(p['analysis']),
                            visual_review_audit=p['analysis'].get('visual_review_audit', {}))
            z.writestr(prefix + '/evidence.json', json.dumps(clean_export(evidence), ensure_ascii=False, indent=2))
            source_path = folder / 'source/source_map.json'
            if source_path.resolve() == source_path and source_path.is_file():
                z.write(source_path, prefix + '/source/source_map.json')
            if kind == 'html':
                body = rendered_note(note)
                math = '<link rel="stylesheet" href="../vendor/Temml-Local.css"><script defer src="../vendor/temml.min.js"></script><script defer src="../math-init.js"></script>' if math_ready else ''
                z.writestr(prefix + '/index.html', '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+html.escape(p['title'])+'</title>'+math+'<style>body{max-width:960px;margin:40px auto;padding:20px;font:17px/1.8 system-ui;color:#183b35}img{max-width:100%;height:auto}pre{white-space:pre-wrap}h2{margin-top:2em}</style><a href="../index.html">返回文献库</a>'+body+'</html>')
            allowed_assets = {'research-flow.svg', *[Path(v['asset_path']).name for v in report_visuals(p['analysis'])]}
            for path in (folder / 'assets').glob('*'):
                if path.resolve() == path and path.is_file() and path.name in allowed_assets:
                    z.write(path, prefix + '/assets/' + path.name)
            index.append(f'<li><a href="{prefix}/index.html">{html.escape(p["title"])}</a></li>')
        z.writestr('papers.json', json.dumps(clean_export(papers), ensure_ascii=False, indent=2))
        z.writestr('research.json', json.dumps(bundle, ensure_ascii=False, indent=2))
        z.writestr('project.md', project_markdown(bundle))
        if kind == 'html':
            from .graph import render_graphs_html
            z.writestr('index.html', offline_index(bundle).replace('</body>', render_graphs_html(bundle.get('graphs')) + '</body>'))
    return stream.getvalue()
