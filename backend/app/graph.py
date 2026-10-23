"""A provenance graph, never a claim that similar papers cite each other."""
import datetime as dt
import hashlib
import itertools
import math
import re
import html

from .discovery import doi


def reference_key(value):
    if isinstance(value, dict):
        value = value.get('openalex') or value.get('DOI') or value.get('doi') or value.get('id') or ''
    value = str(value or '').strip()
    match = re.search(r'(?:^|/)(W\d+)$', value, re.I)
    if match:
        return match[1].upper()
    normalized = doi(value)
    return 'doi:' + normalized if re.match(r'^10\.\d{4,9}/', normalized) else value


def aliases(meta):
    values = [meta.get('openalex_id'), meta.get('doi'), *(meta.get('source_ids') or meta.get('ids') or {}).values()]
    return {reference_key(x) for x in values if x}


def references(meta):
    return {reference_key(x) for x in meta.get('referenced_works', meta.get('references', [])) if reference_key(x)}


def node(record):
    analysis = record.get('analysis') or {}
    borrowing = (analysis.get('research_logic') or {}).get('transfer_insights') or {}
    value = analysis.get('reference_value') or '\n'.join(str(borrowing.get(k) or '') for k in ('direct', 'adapt', 'judgement_change')).strip()
    return {key: record.get(key) for key in ('id', 'title', 'title_en', 'authors', 'year', 'citation_count', 'publication_status', 'doi', 'url', 'created_at')} | {
        'paper_id': record['id'] if re.fullmatch(r'R\d+', record['id']) else None,
        'candidate': record.get('candidate', False), 'reading_status': analysis.get('report_status') or ('completed' if analysis.get('verified') else 'candidate'),
        'summary': analysis.get('summary', ''), 'reference_value': value,
        'scientific_question': analysis.get('scientific_question', ''),
        'author_results': (analysis.get('research_logic') or {}).get('conclusion_layers', {}).get('author_results') or analysis.get('author_conclusions', ''),
        'evidence': [{k: e.get(k) for k in ('id', 'claim', 'source_block_ids')} for e in analysis.get('evidence', []) if isinstance(e, dict)]}


def build_graph(records, view='citation', relation='direct_citation', limit=50):
    selected = records[:max(1, min(limit, 200))]
    timestamp = dt.datetime.now(dt.timezone.utc).isoformat()
    nodes, edges, notices = [node(r) for r in selected], [], []
    available, reason = True, ''
    mapping = {key: r['id'] for r in selected for key in aliases(r)}
    refs = {r['id']: references(r) for r in selected}
    def edge(a, b, kind, weight, basis, source_records):
        edges.append({'id': hashlib.sha256((a + ':' + b + ':' + kind).encode()).hexdigest()[:24],
            'source': a, 'target': b, 'type': kind, 'weight': weight, 'directed': kind == 'direct_citation',
            'basis': basis, 'source_records': source_records, 'retrieved_at': timestamp,
            'algorithm_version': 'bibliography-v1'})
    if view == 'semantic':
        try:
            from .embeddings import vectors
            encoded, version = vectors(selected) if len(selected) > 1 else ([], '')
            for (i, a), (j, b) in itertools.combinations(enumerate(selected), 2):
                similarity = sum(x*y for x, y in zip(encoded[i], encoded[j]))
                if math.isfinite(similarity) and similarity >= 0.7:
                    edge(a['id'], b['id'], 'semantic_similarity', round(similarity, 5),
                         {'cosine_similarity': round(similarity, 5), 'threshold': 0.7, 'input_fields': ['title', 'title_en', 'abstract'], 'model': version, 'max_input_tokens': 512},
                         [{'paper_id': a['id']}, {'paper_id': b['id']}])
            for e in edges:
                e['algorithm_version'] = version
            notices.append('主题相似性为模型计算结果，不表示引用关系或研究结论一致。阈值 0.70 是展示过滤值，不是科学判定标准。')
        except ValueError as error:
            available, reason = False, str(error)
    elif relation == 'direct_citation':
        for row in selected:
            for ref in refs[row['id']]:
                target = mapping.get(ref)
                if target and target != row['id']:
                    edge(row['id'], target, relation, 1, {'referenced_id': ref},
                        [{'paper_id': row['id'], 'field': 'referenced_works', 'source': row.get('source'), 'retrieved_at': row.get('retrieved_at')}])
    elif relation == 'shared_references':
        for a, b in itertools.combinations(selected, 2):
            common = refs[a['id']] & refs[b['id']]
            if common:
                edge(a['id'], b['id'], relation, len(common), {'shared_reference_ids': sorted(common), 'count': len(common)},
                     [{'paper_id': a['id'], 'field': 'referenced_works'}, {'paper_id': b['id'], 'field': 'referenced_works'}])
    elif relation == 'co_citation':
        for a, b in itertools.combinations(selected, 2):
            witnesses = [r for r in records if references(r) & aliases(a) and references(r) & aliases(b) and r['id'] not in (a['id'], b['id'])]
            if witnesses:
                edge(a['id'], b['id'], relation, len(witnesses), {'citing_paper_ids': [r['id'] for r in witnesses], 'count': len(witnesses)},
                     [{'paper_id': r['id'], 'field': 'referenced_works', 'source': r.get('source')} for r in witnesses])
    else:
        raise ValueError('未知引用关系类型')
    counts = {}
    for r in selected:
        for ref in references(r):
            target = mapping.get(ref)
            if target:
                counts[target] = counts.get(target, 0) + 1
    prior = [dict(n, count=counts[n['id']], source_records=[{'scope': '当前已取得题录集合'}]) for n in nodes if counts.get(n['id'])]
    derivative = [dict(node(r), count=len([x for x in references(r) if mapping.get(x)]), source_records=[{'scope': '当前已取得题录集合'}]) for r in records if any(mapping.get(x) for x in references(r))]
    return {'view': view, 'relation': relation, 'nodes': nodes, 'edges': edges,
            'prior_works': sorted(prior, key=lambda n: -n['count']), 'derivative_works': sorted(derivative, key=lambda n: -n['count']),
            'availability': {'available': available, 'reason': reason}, 'generated_at': timestamp,
            'limit': limit, 'total_nodes': len(records), 'notices': notices + ['图谱仅依据当前取得的题录与关系数据，不代表完整学科引用网络。']}


def render_snapshot_html(graph):
    """Self-contained, accessible SVG snapshot; no JS, network or inferred edges."""
    esc = lambda value: html.escape(str(value), quote=True)
    relation = 'semantic_similarity' if graph.get('view') == 'semantic' else graph.get('relation', 'direct_citation')
    label = {'direct_citation': '直接引用', 'shared_references': '共同参考文献', 'co_citation': '共同被引', 'semantic_similarity': '计算的主题相似性'}.get(relation, relation)
    nodes = graph.get('nodes') or []
    edge_rows, shapes, links = [], [], []
    positions = {}
    radius = min(235, 70 + len(nodes) * 7)
    for i, n in enumerate(nodes):
        angle = 2 * math.pi * i / max(1, len(nodes)) - math.pi / 2
        positions[n['id']] = (480 + radius * math.cos(angle), 300 + radius * math.sin(angle))
    years = [n['year'] for n in nodes if type(n.get('year')) is int]
    oldest, newest = (min(years), max(years)) if years else (0, 0)
    for edge in graph.get('edges') or []:
        if edge.get('source') not in positions or edge.get('target') not in positions:
            continue
        x1, y1 = positions[edge['source']]
        x2, y2 = positions[edge['target']]
        arrow = ' marker-end="url(#arrow-' + esc(relation) + ')"' if edge.get('directed') else ''
        shapes.append(f'<line x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}" stroke="#8b9b96" stroke-width="1.2"{arrow}><title>{esc(label)} · {esc(edge.get("weight", ""))}</title></line>')
        edge_rows.append('<li><strong>' + esc(edge['source']) + ' → ' + esc(edge['target']) + '</strong> · ' + esc(label)
            + '<pre style="white-space:pre-wrap;overflow-wrap:anywhere">' + esc(__import__('json').dumps({k: edge.get(k) for k in ('basis', 'source_records', 'retrieved_at', 'algorithm_version')}, ensure_ascii=False, indent=2)) + '</pre></li>')
    for n in nodes:
        x, y = positions[n['id']]
        citations = n.get('citation_count')
        size = 8 + min(12, math.log1p(citations) * 2) if type(citations) is int and citations >= 0 else 8
        year = n.get('year')
        shade = 72 - int(46 * ((year-oldest)/(newest-oldest) if newest > oldest else 0.5)) if type(year) is int else 80
        color = f'hsl(160 17% {shade}%)'
        title = str(n.get('title') or n['id'])
        text = title[:12] + ('…' if len(title) > 12 else '')
        dashed = ' stroke-dasharray="3 2"' if citations is None or year is None else ''
        shape = f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{size:.2f}" fill="{color}" stroke="#263b34" stroke-width="1.5"{dashed}/><text x="{x:.2f}" y="{y+size+17:.2f}" fill="#21362f" text-anchor="middle" font-size="12">{esc(text)}</text>'
        detail = '<title>' + esc(title) + ' · ' + esc(year if year is not None else '年份未取得') + ' · ' + esc(citations if citations is not None else '引用量未取得') + '</title>'
        report_id = n.get('paper_id')
        if report_id and re.fullmatch(r'R\d+', report_id):
            href = report_id + '/index.html'
            shapes.append('<a href="' + esc(href) + '">' + detail + shape + '</a>')
            links.append('<li><a href="' + esc(href) + '">' + esc(n['id'] + ' · ' + title) + '</a></li>')
        else:
            shapes.append('<g>' + detail + shape + '</g>')
            links.append('<li>' + esc(n['id'] + ' · ' + title) + '（候选）</li>')
    if not nodes:
        return '<section><h3>' + esc(label) + '</h3><p>此导出尚无可绘制的题录关系。</p></section>'
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 620" role="img" aria-label="' + esc(label) + '论文关系图" style="width:100%;height:auto;max-height:680px;background:#f7f8f5"><defs><marker id="arrow-' + esc(relation) + '" viewBox="0 0 10 10" refX="15" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#8b9b96"/></marker></defs>' + ''.join(shapes) + '</svg>'
    return '<section class="graph-snapshot"><h3>' + esc(label) + '</h3><p>离线快照 · 环形布局位置不表示相似距离。颜色较深表示年份较近；已知引用量越大，节点越大；未知数据以虚线标识。</p>' + svg \
        + '<details><summary>论文目录及报告链接</summary><ul>' + ''.join(links) + '</ul></details>' \
        + '<details><summary>关系依据与来源（' + str(len(edge_rows)) + '）</summary><ul>' + ''.join(edge_rows) + '</ul></details>' \
        + '<p>保存时间：' + esc(graph.get('generated_at', '')) + '。仅展示已取得数据；主题相似性不代表引用或结论一致。</p></section>'


def render_graphs_html(graphs):
    if not isinstance(graphs, dict) or not graphs:
        return ''
    return '<section id="research-graphs"><h2>课题关系图谱</h2>' + ''.join(
        '<details' + (' open' if key == 'direct_citation' else '') + '><summary>'
        + html.escape({'direct_citation': '直接引用', 'shared_references': '共同参考文献', 'co_citation': '共同被引', 'semantic_similarity': '计算的主题相似性'}.get(key, key))
        + '</summary>' + render_snapshot_html(value) + '</details>' for key, value in graphs.items() if isinstance(value, dict)) + '</section>'
