"""Application receipts for actual image requests, separate from model assertions.

Receipts establish which source page was sent to a vision model, not scientific
truth or independent human review. Old, unattested checkpoints remain audit data.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import uuid

from .db import now


DETAIL_FIELDS = ('claim', 'comparison', 'axes_units', 'statistical_unit',
                 'uncertainty', 'consistency', 'purpose', 'symbols', 'measurand',
                 'applicability', 'panels', 'error_bars', 'effect_size', 'latex')


def meaningful(value):
    if not isinstance(value, str) or not value.strip():
        return False
    return not re.fullmatch(r'(?:(?:此项核验记录[：:]\s*)?(?:尚未核验|未核验|未报告|不适用|未知|unverified|unknown|not reported|n/?a)|已提供的来源未报告足够信息，需核对原文)[\s。.;；]*', value.strip(), re.I)


def identified_label(value, kind=None):
    if not meaningful(value):
        return False
    number = r'(?:[A-Z]?\d+[a-z]?|[一二三四五六七八九十]+)'
    patterns = {'figure': rf'(?:\bfig(?:ure)?\.?\s*|图\s*){number}',
                'table': rf'(?:\btable\s*|表\s*){number}',
                'equation': rf'(?:\b(?:equation|eq\.?)\s*|公式\s*|式\s*)\(?{number}\)?|^\(?{number}\)?$'}
    selected = [patterns[kind]] if kind in patterns else patterns.values()
    return any(re.search(pattern, value, re.I) for pattern in selected)


def _local_file(root, relative):
    root = Path(root).resolve()
    path = root / relative
    # Do not accept symbolic replacements, including linked parent directories.
    return path if path.resolve() == path and path.is_relative_to(root) and path.is_file() else None


def inspection_receipt(result, image, page, source_sha256):
    """Called only after provider.json(..., images=[image]) actually returned."""
    if not isinstance(result, dict) or result.get('readable') is not True or result.get('unread'):
        raise ValueError(f'PDF 第 {page} 页图表或公式未能可靠核验')
    image = Path(image)
    if not image.is_file() or image.resolve() != image:
        raise ValueError('原始页图像不存在或路径不可靠')
    items = result.get('items')
    if not isinstance(items, list):
        raise ValueError('视觉核验未返回图表记录列表')
    accepted = []
    for item in items:
        if not isinstance(item, dict) or item.get('kind') not in ('figure', 'table', 'equation') or item.get('readable') is False:
            continue
        if not identified_label(item.get('label'), item['kind']) or not meaningful(item.get('explanation')):
            continue
        # Keep only observations returned by this image request. A model cannot
        # supply receipt/provenance fields or certify another page in its JSON.
        accepted.append({key: item[key].strip() for key in
                         ('label', 'kind', 'explanation', 'limitations', *DETAIL_FIELDS)
                         if isinstance(item.get(key), str)})
    return {'readable': True, 'unread': [], 'items': accepted,
            'raw_response': deepcopy(result),
            'inspection': {'schema_version': 1, 'method': 'vision_model',
                           'inspection_id': str(uuid.uuid4()),
                           'page': page, 'asset_path': f'assets/page-{page}.png',
                           'source_sha256': source_sha256,
                           'image_sha256': hashlib.sha256(image.read_bytes()).hexdigest(),
                           'inspected_at': now()}}


def checked_visual_records(folder, records=None, *, source_sha256=None, page_count=300):
    """Recheck source/image fingerprints before exposing any verified item."""
    root = Path(folder).resolve()
    pdf = _local_file(root, 'paper.pdf')
    if pdf is None:
        return []
    actual_source = hashlib.sha256(pdf.read_bytes()).hexdigest()
    if source_sha256 and source_sha256 != actual_source:
        return []
    if records is None:
        path = _local_file(root, 'visual-checkpoints.json')
        try:
            records = json.loads(path.read_text('utf-8-sig')) if path else {}
        except (OSError, ValueError):
            return []
    if not isinstance(records, dict):
        return []
    checked = []
    for key, record in records.items():
        if not str(key).isdigit() or not 1 <= int(key) <= page_count or not isinstance(record, dict):
            continue
        page = int(key)
        stamp = record.get('inspection')
        if (record.get('readable') is not True or record.get('unread') or not isinstance(stamp, dict)
                or stamp.get('schema_version') != 1 or stamp.get('method') != 'vision_model'
                or type(stamp.get('page')) is not int or stamp['page'] != page
                or stamp.get('asset_path') != f'assets/page-{page}.png'
                or not stamp.get('inspection_id') or not stamp.get('inspected_at')
                or stamp.get('source_sha256') != actual_source
                or not isinstance(record.get('items'), list)):
            continue
        image = _local_file(root, stamp['asset_path'])
        if image and stamp.get('image_sha256') == hashlib.sha256(image.read_bytes()).hexdigest():
            checked.append((page, record))
    return sorted(checked)


def verified_visuals(records, source_url=''):
    visuals = []
    for page, record in records:
        stamp = record['inspection']
        for item in record['items']:
            if (not isinstance(item, dict) or item.get('kind') not in ('figure', 'table', 'equation')
                    or item.get('readable') is False
                    or not identified_label(item.get('label'), item['kind']) or not meaningful(item.get('explanation'))):
                continue
            value = {key: item[key] for key in ('label', 'kind', 'explanation', 'limitations', *DETAIL_FIELDS)
                     if isinstance(item.get(key), str)}
            value.update(page=page, source_page=page,
                         locator=f'PDF 第 {page} 页 · {value["label"]}',
                         limitations=value.get('limitations', ''),
                         verification_status='verified', inspection_status='verified',
                         inspection_method='vision_model', asset_path=stamp['asset_path'],
                         source_sha256=stamp['source_sha256'], image_sha256=stamp['image_sha256'],
                         inspection_id=stamp['inspection_id'],
                         inspected_at=stamp.get('inspected_at', ''), source_url=source_url)
            visuals.append(value)
    return visuals


def stamp_visual_evidence(analysis, records, blocks=(), source_url=''):
    """Rebuild verified review rows from actual vision observations only."""
    visuals = verified_visuals(records, source_url)
    previous_visuals = analysis.get('visuals')
    if isinstance(previous_visuals, list):
        _keep_audit(analysis, 'unattested_visuals', [row for row in previous_visuals if row not in visuals])
    analysis['visuals'] = visuals
    logic = analysis.get('research_logic')
    if not isinstance(logic, dict):
        return
    raw_reviews = logic.get('evidence_review')
    original = [row for row in raw_reviews if isinstance(row, dict)] if isinstance(raw_reviews, list) else []
    reviews = []
    for visual in visuals:
        row = {key: visual.get(key, '') for key in DETAIL_FIELDS}
        row.update({key: visual[key] for key in ('kind', 'locator', 'page', 'source_page', 'label',
                    'explanation', 'verification_status', 'inspection_status', 'inspection_method',
                    'asset_path', 'source_sha256', 'image_sha256', 'source_url', 'inspection_id', 'inspected_at')})
        row['claim'] = row['claim'] or visual['explanation']
        row['source_block_ids'] = [b['id'] for b in blocks if isinstance(b, dict) and b.get('page') == visual['page'] and b.get('id')]
        reviews.append(row)
    _keep_audit(analysis, 'text_model_evidence_review', [row for row in original if row not in reviews])
    logic['evidence_review'] = reviews


def _keep_audit(analysis, key, rows):
    if not rows:
        return
    audit = analysis.get('visual_review_audit')
    if not isinstance(audit, dict):
        audit = {}
        analysis['visual_review_audit'] = audit
    existing = audit.get(key)
    if not isinstance(existing, list):
        existing = []
        audit[key] = existing
    for row in rows:
        if row not in existing:
            existing.append(deepcopy(row))


def project_visual_evidence(analysis, folder=None, source_url=''):
    """Read-only projection shared by API and exports; never trust saved flags."""
    result = deepcopy(analysis)
    blocks, records = [], []
    if folder is not None:
        records = checked_visual_records(folder, source_sha256=result.get('source_sha256'))
        source = _local_file(folder, 'source/source_map.json')
        try:
            mapping = json.loads(source.read_text('utf-8-sig')) if source else {}
            blocks = mapping.get('blocks', []) if isinstance(mapping, dict) else []
        except (OSError, ValueError):
            pass
    stamp_visual_evidence(result, records, blocks if isinstance(blocks, list) else [], source_url)
    coverage = result.get('coverage')
    if isinstance(coverage, dict):
        coverage['visual_pages_checked'] = [page for page, _ in records]
    return result


def report_visuals(analysis):
    """Report projection; legacy flags alone never supply item-level evidence."""
    rows = analysis.get('visuals')
    return [v for v in rows if isinstance(v, dict)
            and v.get('inspection_status') == 'verified' and v.get('inspection_method') == 'vision_model'
            and v.get('verification_status') == 'verified' and type(v.get('page')) is int and v['page'] >= 1
            and v.get('source_page') == v['page'] and v.get('kind') in ('figure', 'table', 'equation')
            and v.get('asset_path') == f'assets/page-{v["page"]}.png'
            and meaningful(v.get('inspection_id')) and meaningful(v.get('inspected_at'))
            and all(re.fullmatch(r'[a-f0-9]{64}', str(v.get(key, ''))) for key in ('source_sha256', 'image_sha256'))
            and identified_label(v.get('label'), v.get('kind')) and meaningful(v.get('locator')) and meaningful(v.get('explanation'))] if isinstance(rows, list) else []
