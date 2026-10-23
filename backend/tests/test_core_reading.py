"""Core report completion is grounded in body sources, not schema assertions."""
import copy
import hashlib
import json
from pathlib import Path
import uuid

import pytest
from sqlalchemy import select

from app.artifacts import inspect_pdf, markdown_note
from app.config import DATA
from app.db import Job, Paper, Project, ProjectPaper, Setting, session
from app.pipeline import _run_job, analyze, candidate_folder, register, register_revision
from app.reading_core import completion_status, validate_core_report
from app.skill import Skill
from fixtures import analysis, metadata, make_pdf
from test_pipeline import FakeProvider, FakeSkill, project_job


def source():
    return {'blocks': [{'id': 'P0001-B0001', 'page': 1, 'text': 'Synthetic body research question, method and result.', 'section': 'methods'}]}


def test_core_gate_refuses_missing_or_abstract_only_support():
    item = analysis()
    item.pop('core_coverage')
    with pytest.raises(ValueError, match='核心报告尚未完成'):
        validate_core_report(item, source())
    item = analysis()
    for key in ('question', 'methods', 'results'):
        item['core_coverage'][key]['source_block_ids'] = ['ABSTRACT-1']
    with pytest.raises(ValueError, match='正文依据'):
        validate_core_report(item, {'blocks': [{'id': 'ABSTRACT-1', 'text': 'An abstract.'}]})


@pytest.mark.parametrize('study_type', ['experimental', 'method', 'theory', 'review'])
def test_core_gate_accepts_located_content_for_different_paper_types(study_type):
    item = analysis()
    item['core_coverage']['study_type'] = study_type
    validate_core_report(item, source())
    assert completion_status(item, source(), [], [])['visual_status'] == 'not_required'


def test_core_gate_rejects_nonexistent_result_and_empty_visual_receipt():
    item = analysis()
    item['core_coverage']['results']['source_block_ids'] = ['invented']
    with pytest.raises(ValueError, match='不存在的正文来源块'):
        validate_core_report(item, source())
    with pytest.raises(ValueError, match='关键图表或公式'):
        completion_status(analysis(), source(), [1], [(1, {'items': []})])


def test_builtin_reader_and_optional_skill_do_not_claim_norman(tmp_path, monkeypatch):
    monkeypatch.setenv('NORMAN_SKILL_PATH', str(tmp_path / 'absent-skill'))
    folder = tmp_path / 'body'
    folder.mkdir()
    make_pdf(folder / 'paper.pdf')
    skill = Skill()
    assert skill.preflight()['available'] is True
    assert skill.preflight()['norman_available'] is False
    assert '未' in skill.instructions() or '不可用' in skill.instructions()
    skill.operation('extract', folder)
    mapping = json.loads((folder / 'source/source_map.json').read_text('utf-8'))
    assert mapping['blocks'][0]['page'] == 1
    assert mapping['blocks'][0]['extraction_method'] == 'pdf_text'
    assert mapping['source']['sha256'] == hashlib.sha256((folder / 'paper.pdf').read_bytes()).hexdigest()
    skill.operation('render', folder, [1])
    assert (folder / 'assets/page-1.png').read_bytes().startswith(b'\x89PNG')
    item = analysis()
    assert '分析采用 norman-paper-reading 技能' not in markdown_note(metadata(), item)
    item.update(reading_skill='norman-paper-reading', skill_applied=True)
    assert '分析采用 norman-paper-reading 技能' in markdown_note(metadata(), item)


def test_rule_files_without_working_native_tools_never_claim_applied(tmp_path, monkeypatch):
    from app.skill import REFERENCES
    root = tmp_path / 'rules-only'
    (root / 'references').mkdir(parents=True)
    (root / 'SKILL.md').write_text('Synthetic external rules', 'utf-8')
    for name in REFERENCES:
        (root / 'references' / name).write_text('Synthetic reference', 'utf-8')
    monkeypatch.setenv('NORMAN_SKILL_PATH', str(root))
    def unavailable(self):
        raise ValueError('No working native engine')
    monkeypatch.setattr('app.norman_native.NativeNorman.preflight', unavailable)
    skill = Skill()
    assert skill.preflight()['norman_available'] is False
    assert '不得声称' in skill.instructions()
    assert skill.applied is False


def test_available_optional_skill_dispatches_to_native_extraction(tmp_path, monkeypatch):
    from app.skill import REFERENCES
    root = tmp_path / 'external'
    (root / 'references').mkdir(parents=True)
    (root / 'SKILL.md').write_text('Synthetic rules', 'utf-8')
    for name in REFERENCES:
        (root / 'references' / name).write_text('Synthetic reference', 'utf-8')
    monkeypatch.setenv('NORMAN_SKILL_PATH', str(root))
    monkeypatch.setattr('app.norman_native.NativeNorman.preflight', lambda self: {'available': True})
    called = []
    def operation(self, op, folder, pages=None):
        called.append(op)
        (folder / 'source').mkdir(exist_ok=True)
        (folder / 'source/source_map.json').write_text(json.dumps({'blocks': [{'id': 'native-1', 'page': 1, 'text': 'Methods\nActual source method.'}]}), 'utf-8')
    monkeypatch.setattr('app.norman_native.NativeNorman.operation', operation)
    skill = Skill()
    skill.operation('extract', tmp_path)
    assert called == ['extract']
    assert skill.instructions().startswith('Synthetic rules')
    assert skill.applied is True
    assert json.loads((tmp_path / 'source/source_map.json').read_text())['blocks'][0]['section'] == 'methods'


def test_ocr_preserves_original_and_records_method(tmp_path, monkeypatch):
    from pypdf import PdfWriter
    path = tmp_path / 'scan.pdf'
    writer = PdfWriter()
    writer.add_blank_page(400, 500)
    writer.write(path)
    before = path.read_bytes()
    monkeypatch.setattr('app.artifacts.ocr_page', lambda path, page: '中文扫描识别示例。' * 20)
    records = []
    assert '中文' in inspect_pdf(path, page_records=records)[0]
    assert records[0]['method'].startswith('tesseract:')
    assert records[0]['page'] == 1
    assert path.read_bytes() == before


def test_import_analysis_does_not_search_or_fill_new_quota(monkeypatch):
    from app.db import ImportedCandidate
    pid, jid = project_job(0)
    imported_id = str(uuid.uuid4())
    meta = metadata('Imported fixture', '10.1234/import-fixture')
    candidate = dict(meta, status='pending', imported_candidate_id=imported_id)
    with session() as s:
        s.add(ImportedCandidate(id=imported_id, project_id=pid, metadata_json=json.dumps(meta)))
        s.get(Job, jid).checkpoint = json.dumps({'trigger_source': 'import-analysis', 'import_analysis': True,
                                               'candidates': [candidate]})
    def unexpected_search(*args):
        pytest.fail('Import analysis must not discover or buy unrelated studies')
    monkeypatch.setattr('app.pipeline.search', unexpected_search)
    monkeypatch.setattr('app.pipeline.challenge_image', lambda path: None)
    monkeypatch.setattr('app.pipeline.acquire_pdf', lambda meta, path, cfg: path.write_bytes(b'%PDF-synthetic') and {'url': 'https://example.com/fixture.pdf'})
    monkeypatch.setattr('app.pipeline.analyze', lambda *args: dict(analysis(), verified=True))
    _run_job(jid, provider=FakeProvider(), skill=FakeSkill())
    _run_job(jid, provider=FakeProvider(), skill=FakeSkill())
    with session() as s:
        job = s.get(Job, jid)
        state = json.loads(job.checkpoint)
        assert job.status == 'completed'
        assert state['actual'] == 0 and state['imported_report_count'] == 1
        assert state['completed'] == [] and state['imported_completed'] == ['R001']
        assert s.get(ImportedCandidate, imported_id).status == 'analyzed'
        assert len(s.scalars(select(Paper)).all()) == 1


def test_revision_preserves_number_counter_origin_and_previous_source(tmp_path):
    pid, jid = project_job(1)
    old = dict(analysis(), artifact_dir='papers/old-fixture', source_sha256='a' * 64)
    number, _ = register(pid, jid, metadata(), old)
    folder = DATA / 'papers' / ('revision-' + uuid.uuid4().hex)
    (folder / 'source').mkdir(parents=True)
    (folder / 'source/source_map.json').write_text(json.dumps(source()), 'utf-8')
    newer = dict(analysis(), artifact_dir=folder.relative_to(DATA).as_posix(), source_sha256='b' * 64)
    register_revision(pid, number, metadata(), newer)
    with session() as s:
        paper = s.get(Paper, number)
        link = s.scalar(select(ProjectPaper).where(ProjectPaper.paper_number == number))
        assert s.get(Setting, 'ledger_counter').value == '1'
        assert link.job_id == jid
        assert len(s.scalars(select(Paper)).all()) == 1
        revised = json.loads(paper.analysis_json)
        assert revised['revision_of'] == 'R001'
        entry = revised['revision_history'][0]
        assert entry['previous_source_sha256'] == 'a' * 64
        assert (DATA / entry['snapshot']).is_file()
        assert json.loads((DATA / entry['snapshot']).read_text('utf-8'))['analysis'] == old


def test_all_body_chunks_include_late_results_beyond_old_browser_budget(monkeypatch):
    folder = DATA / 'papers' / ('long-body-' + uuid.uuid4().hex)
    (folder / 'source').mkdir(parents=True)
    raw = b'%PDF-synthetic-chunk-coverage-fixture'
    (folder / 'paper.pdf').write_bytes(raw)
    blocks = [{'id': f'P{page:04d}-B0001', 'page': page, 'section': 'methods',
               'text': ('late-result' if page == 4 else 'body-evidence') * 1700}
              for page in range(1, 5)]
    mapping = {'source': {'sha256': hashlib.sha256(raw).hexdigest(), 'page_count': 4}, 'blocks': blocks}
    (folder / 'source/source_map.json').write_text(json.dumps(mapping), 'utf-8')
    class ChunkModel:
        supplied = []
        def json(self, prompt, images=None, **kwargs):
            if '核对下载正文' in prompt:
                return {'matches': True, 'version': 'synthetic'}
            if '阅读本组所有正文块' in prompt:
                group = json.loads(prompt.split('\n', 1)[1])
                self.supplied.extend(row['id'] for row in group)
                return {'notes': 'Only synthetic evidence ' + ', '.join(row['id'] for row in group),
                        'unread': [], 'visual_pages': []}
            result = analysis()
            result['core_coverage']['results']['source_block_ids'] = ['P0004-B0001']
            result['evidence'][0]['source_block_ids'] = ['P0004-B0001']
            return result
    class BuiltinFixture(Skill):
        def instructions(self):
            return 'Synthetic fixture only'
    model = ChunkModel()
    result = analyze(model, BuiltinFixture(), metadata(), {}, folder, lambda stage: None)
    assert model.supplied == [row['id'] for row in blocks]
    assert result['coverage']['text_blocks_read'] == 4
    assert result['core_coverage']['results']['source_block_ids'] == ['P0004-B0001']
    assert result['report_status'] == 'completed' and result['visual_status'] == 'not_required'
    assert result['reading_skill'] == 'paper-workbench' and result['skill_applied'] is False


def test_core_visual_budget_keeps_processing_instead_of_truncating(monkeypatch):
    from test_partial_checkpoint import CheckpointProvider, CheckpointSkill, prepared_folder
    monkeypatch.setenv('MAX_VISUAL_PAGES_PER_PAPER', '24')
    folder = prepared_folder(monkeypatch, pages=30)
    class ManyRequiredPages(CheckpointProvider):
        def json(self, prompt, images=None, **kwargs):
            result = super().json(prompt, images, **kwargs)
            if result.get('summary'):
                result['required_visual_pages'] = list(range(1, 26))
            return result
    with pytest.raises(ValueError, match='超过本次视觉预算 24'):
        analyze(ManyRequiredPages(), CheckpointSkill(), metadata(), {}, folder, lambda stage: None)
    result = json.loads((folder / 'provisional.json').read_text('utf-8'))
    assert result['verified'] is False and result['report_status'] == 'processing'
    assert result['coverage']['required_visual_pages'] == list(range(1, 26))
    assert result['visuals'] == []


def test_section_headings_are_inferred_from_chinese_and_english_source_lines():
    from app.reading_core import sectioned_blocks
    pages = [
        '论文标题\n作者信息\n摘要：这里是摘要里的方法和结果。\n方法\n结构化摘要方法。\n结果\n结构化摘要结果。\n关键词：测试\n1 引言\n真实引言内容。\n2 材料与方法\n独立样本和测量协议。',
        '3 Results\nThe measured outcome follows the matched protocol.\n4 Discussion\nThe uncertainty limits transfer.\nReferences\nA bibliography entry.'
    ]
    blocks = sectioned_blocks(pages, [{'method': 'pdf_text'}, {'method': 'pdf_text'}])
    abstract = [b for b in blocks if '结构化摘要方法' in b['text']][0]
    assert abstract['section'] == 'abstract'
    methods = [b for b in blocks if '独立样本' in b['text']][0]
    assert methods['section'] == 'methods' and methods['page'] == 1
    assert methods['section_heading'] == '2 材料与方法'
    result = [b for b in blocks if 'measured outcome' in b['text']][0]
    assert result['section'] == 'results' and result['line_start'] == 1 and result['page'] == 2
    assert blocks[-1]['section'] == 'references'


def test_pdf_first_page_abstract_cannot_supply_methods_or_results():
    item = analysis()
    mapping = source()
    mapping['blocks'][0].update(section='abstract', text='摘要：研究了一个问题并报告结果。')
    with pytest.raises(ValueError, match='不能仅使用摘要'):
        validate_core_report(item, mapping)


def test_unknown_section_requires_actual_body_excerpt_and_rejects_frontmatter():
    mapping = source()
    mapping['blocks'][0].update(section='unknown', text='A matched independent test was performed; the held out outcome was measured.')
    item = analysis()
    with pytest.raises(ValueError, match='supporting_excerpt'):
        validate_core_report(item, mapping)
    for role in ('methods', 'results'):
        item['core_coverage'][role]['supporting_excerpt'] = 'A matched independent test was performed'
    validate_core_report(item, mapping)
    item['core_coverage']['results']['supporting_excerpt'] = 'A fabricated result never present in the source'
    with pytest.raises(ValueError, match='supporting_excerpt'):
        validate_core_report(item, mapping)
    mapping['blocks'][0]['frontmatter'] = True
    with pytest.raises(ValueError, match='文首题录'):
        validate_core_report(item, mapping)


def test_theoretical_and_review_section_adaptation():
    from app.reading_core import heading_section
    assert heading_section('2 理论推导') == 'argument'
    assert heading_section('3 Evidence synthesis') == 'synthesis'
    for section, study_type in [('argument', 'theory'), ('synthesis', 'review')]:
        item = analysis()
        item['core_coverage']['study_type'] = study_type
        mapping = source()
        mapping['blocks'][0]['section'] = section
        validate_core_report(item, mapping)
