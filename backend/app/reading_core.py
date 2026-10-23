"""Source-based completion gates, independent of visual or schema claims."""
import re
import unicodedata

from .schemas import CoreCoverage
from .visual_review import meaningful

CORE_RULES = '''core_coverage 必须填写 study_type 和 question/methods/results，每项含简明 summary
及实际正文 source_block_ids。question 对应科学问题；methods 对应实际方法或理论假设推导、
综述检索筛选方式；results 对应实际结果、理论命题或综述证据综合。不能用题录、摘要或未来建议
冒充正文方法和结果。关键结论若依赖具体图表或公式，其原始 PDF 页码必须列入 required_visual_pages。
正文块附有由程序识别的 section。methods/results 不能仅引用 abstract/metadata/frontmatter/references。
若定位块 section=unknown，必须填写 supporting_excerpt：从该段实际复制一个简短定位摘录
（12至600字符），程序将核对它确实存在于相应正文中；不能从题名或文首作者信息推断方法。
理论论文 methods 对应 argument 假设推导，综述 methods/results 可来自 synthesis 检索与证据综合。
行动 evidence_ids 只填明确支持这项行动的证据，不默认关联全部证据。'''


def heading_section(line):
    """Recognise common headings without accepting a model's section labels."""
    value = unicodedata.normalize('NFKC', line).strip()
    if re.match(r'^(?:abstract|摘要|摘\s*要)\s*[:：]', value, re.I):
        return 'abstract'
    if re.match(r'^(?:key\s*words?|关键词|关\s*键\s*词)\s*[:：]', value, re.I):
        return 'metadata'
    value = re.sub(r'^\s*(?:第[一二三四五六七八九十\d]+[章节]|[\d一二三四五六七八九十]+(?:\.\d+)*[.、)）]?|[IVXLC]+[.)])\s*', '', value, flags=re.I)
    value = value.strip(' :：.。')
    if len(value) > 90:
        return None
    patterns = {
        'abstract': r'abstract|摘要|摘\s*要',
        'introduction': r'introduction|background|引言|绪论|背景|研究背景',
        'methods': r'(?:materials? and )?methods?|methodology|experimental(?: setup| design| methods?)?|implementation|研究方法|材料与方法|实验方法|方法|实验(?:设计|装置|部分)|测试方法',
        'results': r'results?(?: and discussion)?|experimental results?|结果|研究结果|实验结果|结果与讨论|测试结果',
        'discussion': r'discussion|讨论|分析与讨论|结果分析',
        'conclusion': r'conclusions?(?: and future work)?|结论|结语|总结',
        'references': r'references|bibliography|参考文献|引用文献',
        'argument': r'theoretical(?: framework| analysis| model)?|proofs?|derivation|formalization|理论(?:模型|分析|推导)|数学模型|模型构建|证明|关键命题',
        'synthesis': r'evidence synthesis|literature review|review methodology|search strategy|study selection|检索策略|文献检索|文献筛选|证据综合|研究进展|文献综述',
    }
    return next((section for section, pattern in patterns.items() if re.fullmatch(pattern, value, re.I)), None)


def sectioned_blocks(texts, page_records):
    """Retain page/line ranges; labels come only from source text headings."""
    blocks, section, heading = [], 'unknown', ''
    for page, text in enumerate(texts, 1):
        lines, buffer, start_line, paragraph = text.splitlines() or [text], [], 1, 0

        def flush(end_line):
            nonlocal buffer, paragraph
            content = '\n'.join(buffer).strip()
            if content:
                paragraph += 1
                blocks.append({'id': f'P{page:04d}-B{paragraph:04d}', 'page': page,
                               'paragraph': paragraph, 'line_start': start_line, 'line_end': end_line,
                               'locator': f'PDF 第 {page} 页 · 段落 {paragraph} · 行 {start_line}–{end_line}',
                               'text': content, 'section': section, 'section_heading': heading,
                               'frontmatter': page == 1 and paragraph == 1 and section == 'unknown' and len(content) < 300,
                               'extraction_method': page_records[page - 1]['method']})
            buffer = []

        for number, line in enumerate(lines, 1):
            detected = heading_section(line)
            # Structured abstracts often contain bare Methods/Results labels.
            # They stay abstract until a numbered main heading, introduction,
            # keyword boundary, or later page establishes the body.
            numbered = bool(re.match(r'^\s*(?:\d|[一二三四五六七八九十]+[、.])', line))
            if section == 'abstract' and page == 1 and not numbered and detected in ('methods', 'results', 'conclusion'):
                detected = None
            if detected:
                flush(number - 1)
                section, heading = detected, line.strip()
                start_line = number
            elif not line.strip():
                flush(number - 1)
                start_line = number + 1
                continue
            elif sum(len(part) for part in buffer) + len(line) > 2400 and buffer:
                flush(number - 1)
                start_line = number
            if section == 'metadata' and not detected and buffer:
                flush(number - 1)
                section, heading, start_line = 'unknown', '', number
            # Long single lines still have bounded blocks and stable source IDs.
            for offset in range(0, max(1, len(line)), 2400):
                if offset:
                    flush(number)
                    start_line = number
                buffer.append(line[offset:offset + 2400])
        flush(len(lines))
    return blocks


def _normal_text(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', str(value or ''))).casefold()


def validate_core_report(analysis, source_map):
    """Require located core content; this is not a scientific truth validator."""
    raw = analysis.get('core_coverage')
    if not raw:
        raise ValueError('核心报告尚未完成：需要正文中的科学问题、方法与关键结果来源定位')
    coverage = CoreCoverage.model_validate(raw).model_dump()
    blocks = {block['id']: block for block in source_map.get('blocks', [])
              if isinstance(block, dict) and block.get('id')}
    for key, label in [('question', '科学问题'), ('methods', '方法或推导／综述筛选'), ('results', '关键结果')]:
        row = coverage[key]
        if not meaningful(row['summary']):
            raise ValueError(f'核心报告尚未完成：{label}没有可分析正文内容')
        if not set(row['source_block_ids']).issubset(blocks):
            raise ValueError(f'核心报告的{label}引用了不存在的正文来源块')
        for block_id in row['source_block_ids']:
            block = blocks[block_id]
            if (str(block_id).upper().startswith('ABSTRACT')
                    or block.get('kind') in ('abstract', 'metadata')
                    or block.get('basis') == 'abstract'
                    or not str(block.get('text') or '').strip()):
                raise ValueError(f'核心报告的{label}需要正文依据，不能仅使用摘要或题录')
        if key in ('methods', 'results'):
            body = [blocks[bid] for bid in row['source_block_ids']
                    if blocks[bid].get('section', 'unknown') not in ('abstract', 'metadata', 'frontmatter', 'references')
                    and not blocks[bid].get('frontmatter')
                    and heading_section(str(blocks[bid].get('text', '')).split('\n', 1)[0]) not in ('abstract', 'metadata', 'references')]
            if not body:
                raise ValueError(f'核心报告的{label}不能仅使用摘要、文首题录或参考文献')
            if not any(block.get('section', 'unknown') != 'unknown' for block in body):
                excerpt = _normal_text(row.get('supporting_excerpt'))
                if len(excerpt) < 12 or not any(excerpt in _normal_text(block.get('text')) for block in body):
                    raise ValueError(f'核心报告的{label}章节未识别，需要可在实际段落匹配的 supporting_excerpt 定位摘录')
    analysis['core_coverage'] = coverage
    return coverage


def completion_status(analysis, source_map, required_pages, checked_records, *, text_chunks_complete=True):
    validate_core_report(analysis, source_map)
    if not text_chunks_complete:
        raise ValueError('正文分析仍有未读段落，检查点已保留，尚未完成核心报告')
    checked = {page for page, record in checked_records if record.get('items')}
    missing = sorted(set(required_pages) - checked)
    if missing:
        raise ValueError('关键图表或公式尚未取得可用的原页核验记录，待补充：' + str(missing))
    return {'report_status': 'completed', 'text_report_status': 'completed',
            'visual_status': 'model_inspected' if checked else 'not_required',
            'core_content_located': True}
