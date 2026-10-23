"""Local bibliography readers. Input text is data, never executable code."""
import datetime as dt
import json
import re
import uuid
import xml.etree.ElementTree as ET

from .discovery import doi, identity, same_paper, source_ids


def normalize_metadata(row, source='用户导入'):
    title = str(row.get('title') or '').strip()
    if not title:
        raise ValueError('题录缺少标题')
    authors = row.get('authors') or []
    if isinstance(authors, str):
        authors = re.split(r'\s+and\s+|;|；', authors)
    if not isinstance(authors, list):
        raise ValueError('作者应为姓名数组或以分号分隔的文字')
    year = re.search(r'\b(?:18|19|20|21)\d{2}\b', str(row.get('year') or row.get('publication_date') or ''))
    meta = {key: row[key] for key in ('title_en', 'title_aliases', 'source_ids', 'ids', 'external_ids', 'source_id', 'openalex_id', 'language',
             'referenced_works', 'related_works', 'citation_count', 'publication_date', 'first_publication_date',
             'volume', 'issue', 'pages', 'publication_status', 'content_urls', 'has_content', 'versions') if key in row}
    meta.update(title=title[:1500], authors=[str(a).strip()[:300] for a in authors[:100] if str(a).strip()],
                doi=doi(str(row.get('doi') or '')), year=int(year[0]) if year else None,
                journal=str(row.get('journal') or '')[:600], abstract=str(row.get('abstract') or '')[:200000],
                url=str(row.get('url') or '')[:3000], pdf_urls=[str(u) for u in row.get('pdf_urls', [])[:20]],
                source=source, retrieved_at=dt.datetime.now(dt.timezone.utc).isoformat())
    meta.setdefault('versions', [meta['doi']] if meta['doi'] else [])
    meta.setdefault('publication_status', 'unknown')
    for key in ('source_ids', 'ids', 'external_ids', 'content_urls', 'has_content'):
        if key in meta and not isinstance(meta[key], dict):
            raise ValueError(key + ' 应为对象')
    for key in ('title_aliases', 'referenced_works', 'related_works', 'versions'):
        if key in meta and not isinstance(meta[key], list):
            raise ValueError(key + ' 应为数组')
    meta['source_ids'] = source_ids(meta)
    meta['identity_token'] = str(row.get('identity_token') or uuid.uuid4())[:100]
    return meta


def parse_ris(text):
    records, row = [], {}
    tag, value = None, ''
    def put():
        if tag:
            row.setdefault(tag, []).append(value.strip())
    for line in text.splitlines() + ['ER  -']:
        match = re.match(r'^([A-Z0-9]{2})\s{1,2}-\s?(.*)$', line)
        if match:
            put()
            tag, value = match.groups()
            if tag == 'ER':
                def first(*keys):
                    return next((row[k][0] for k in keys if row.get(k)), '')
                if row:
                    records.append(dict(title=first('TI', 'T1', 'CT'), authors=row.get('AU', row.get('A1', [])),
                        year=first('PY', 'Y1', 'DA'), doi=first('DO'), journal=first('JO', 'JF', 'T2'),
                        abstract=first('AB', 'N2'), url=first('UR'), volume=first('VL'), issue=first('IS'),
                        pages=first('SP') + ('–' + first('EP') if first('EP') else ''),
                        source_ids={'ris': first('ID', 'AN')} if first('ID', 'AN') else {}))
                row, tag, value = {}, None, ''
        elif tag:
            value += '\n' + line
    return records


def _bib_fields(body):
    """Parse balanced braces and quoted values, including CJK field content."""
    fields, i = {}, 0
    while i < len(body):
        match = re.search(r'([\w-]+)\s*=\s*', body[i:])
        if not match:
            break
        key = match[1].lower()
        i += match.end()
        begin, depth, quoted = i, 0, False
        if i < len(body) and body[i] in '{"':
            opening = body[i]
            depth, quoted = (1, False) if opening == '{' else (0, True)
            i += 1
            begin = i
            while i < len(body):
                c = body[i]
                if c == '\\':
                    i += 2
                    continue
                if opening == '{':
                    depth += (c == '{') - (c == '}')
                    if depth == 0:
                        break
                elif c == '"':
                    break
                i += 1
            fields[key] = body[begin:i].replace('{', '').replace('}', '').strip()
            i += 1
        else:
            end = body.find(',', i)
            end = end if end >= 0 else len(body)
            fields[key] = body[i:end].strip()
            i = end + 1
    return fields


def parse_bibtex(text):
    records, i = [], 0
    while match := re.search(r'@(\w+)\s*([\{(])', text[i:]):
        kind = match[1].lower()
        i += match.end()
        start, depth = i, 1
        close, opening = ('}', '{') if match[2] == '{' else (')', '(')
        while i < len(text) and depth:
            if text[i] == '\\':
                i += 2
                continue
            depth += (text[i] == opening) - (text[i] == close)
            i += 1
        body = text[start:i-1]
        if kind in ('comment', 'preamble', 'string') or ',' not in body:
            continue
        citation_key, body = body.split(',', 1)
        f = _bib_fields(body)
        records.append(dict(title=f.get('title', ''), authors=re.split(r'\s+and\s+', f.get('author', '')),
            year=f.get('year', f.get('date', '')), doi=f.get('doi', ''), journal=f.get('journal', f.get('booktitle', '')),
            abstract=f.get('abstract', ''), url=f.get('url', ''), volume=f.get('volume', ''), issue=f.get('number', ''),
            pages=f.get('pages', ''), source_ids={}, citation_key=citation_key.strip()))
    return records


def parse_endnote(text):
    if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
        raise ValueError('不接受含外部实体或DOCTYPE的XML')
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        raise ValueError('EndNote XML 格式无法解析') from None
    records = []
    def read(element, path):
        obj = element.find(path)
        return ''.join(obj.itertext()).strip() if obj is not None else ''
    for row in root.findall('.//record'):
        records.append(dict(title=read(row, './titles/title'), authors=[''.join(a.itertext()) for a in row.findall('./contributors/authors/author')],
            year=read(row, './dates/year'), doi=read(row, './electronic-resource-num'), journal=read(row, './titles/secondary-title'),
            abstract=read(row, './abstract'), url=read(row, './urls/related-urls/url'), volume=read(row, './volume'),
            issue=read(row, './number'), pages=read(row, './pages'), source_ids={}))
    return records


def parse_import(data, filename):
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        try:
            text = data.decode('gb18030')
        except UnicodeDecodeError:
            raise ValueError('题录需使用 UTF-8 或 GB18030 编码') from None
    suffix = filename.lower().rsplit('.', 1)[-1]
    if suffix == 'ris':
        rows = parse_ris(text)
    elif suffix in ('bib', 'bibtex'):
        rows = parse_bibtex(text)
    elif suffix == 'xml':
        rows = parse_endnote(text)
    elif suffix == 'json':
        obj = json.loads(text)
        rows = obj.get('papers', obj.get('records', [])) if isinstance(obj, dict) else obj
        if not isinstance(rows, list):
            raise ValueError('JSON 应为论文数组或包含 papers 的课题导出')
    else:
        raise ValueError('支持 RIS、BibTeX、EndNote XML 和研究库 JSON')
    if not rows:
        raise ValueError('文件没有可导入题录')
    if len(rows) > 1000:
        raise ValueError('单次最多导入 1000 篇题录')
    records = []
    for index, raw in enumerate(rows):
        if not isinstance(raw, dict):
            raise ValueError(f'第 {index+1} 条题录不是对象')
        row = raw.get('metadata') if isinstance(raw.get('metadata'), dict) else raw
        meta = normalize_metadata(row, source='用户导入 ' + suffix.upper())
        old_id = str(raw.get('id') or row.get('id') or '')[:100]
        records.append({'id': str(uuid.uuid4()), 'metadata': meta, 'legacy_id': old_id,
                        'analysis': raw.get('analysis') if isinstance(raw.get('analysis'), dict) else None,
                        'revisions': raw.get('revisions') if isinstance(raw.get('revisions'), list) else [],
                        'warnings': [] if meta['authors'] and meta['year'] else ['作者或年份不完整，导入后请补核题录']})
    # File-local exact duplicate records are visible before confirmation.
    for i, record in enumerate(records):
        record['duplicate_in_file'] = next((r['id'] for r in records[:i] if same_paper(r['metadata'], record['metadata'])), None)
    return records
