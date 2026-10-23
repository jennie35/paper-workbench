"""Incomplete reading remains inspectable without becoming a completed paper."""
import json
import uuid

import pytest
from sqlalchemy import select

from app.config import DATA
from app.db import Job, Paper, Project, session
from app.pipeline import _run_job, analyze, candidate_folder
from fixtures import analysis, metadata


class CheckpointSkill:
    def __init__(self, fail_validation=False):
        self.fail_validation = fail_validation

    def preflight(self):
        return {'available': True}

    def instructions(self):
        return 'Synthetic fixture only; preserve all evidence gaps.'

    def operation(self, operation, folder, pages=None):
        if operation == 'extract':
            (folder / 'source').mkdir(exist_ok=True)
            source = {'blocks': [{'id': 'P0001-B0001', 'page': 1, 'text': 'Synthetic source.', 'section': 'methods'}]}
            (folder / 'source/source_map.json').write_text(json.dumps(source), 'utf-8')
        elif operation == 'render':
            (folder / 'assets/native-page.png').write_bytes(b'synthetic-image-request-fixture')
        elif operation == 'validate' and self.fail_validation:
            # The file exists during validation, but must not already claim success.
            saved = json.loads((folder / 'analysis.json').read_text('utf-8'))
            assert saved['verified'] is False
            raise ValueError('结构校验未通过：合成测试')


class CheckpointProvider:
    config = {}

    def __init__(self, unread=False, bad_visual_page=None):
        self.unread = unread
        self.bad_visual_page = bad_visual_page

    def preflight(self, image):
        pass

    def json(self, prompt, images=None, **kwargs):
        if '根据课题范围评估题录相关性' in prompt:
            return {'ranked': [{'index': 0, 'relevant': True, 'relevance': 3, 'reason': 'Synthetic match'}]}
        if '核对下载正文' in prompt:
            return {'matches': True, 'version': 'Synthetic fixture'}
        if '阅读本组所有正文块' in prompt:
            return {'notes': 'Synthetic source P0001-B0001', 'visual_pages': [1], 'unread': []}
        if images:
            page = int(images[0].stem.split('-')[-1])
            if page == self.bad_visual_page:
                return {'readable': False, 'items': [], 'unread': ['Figure labels are unreadable']}
            return {'readable': True, 'items': [{'page': page, 'label': f'Figure {page}', 'kind': 'figure', 'explanation': 'Observed synthetic page', 'limitations': 'Test fixture, not research'}], 'unread': []}
        result = analysis()
        result['required_visual_pages'] = sorted({1, *([self.bad_visual_page] if self.bad_visual_page else [])})
        # Untrusted model fields cannot override application verification gates.
        result.update(verified=True, structural_validation='model_claimed_success')
        if '修正此前文本分析' in prompt:
            result['summary'] = 'Reconciled summary preserves the useful original-image inspection.'
            if self.unread:
                result['unread'] = ['Supplementary data have not been acquired.']
        return result


def prepared_folder(monkeypatch, pages=1):
    folder = DATA / 'papers' / ('partial-' + uuid.uuid4().hex)
    folder.mkdir(parents=True)
    (folder / 'paper.pdf').write_bytes(b'%PDF-synthetic-checkpoint-fixture')
    monkeypatch.setattr('app.pipeline.inspect_pdf', lambda path: [f'Synthetic Figure {i + 1}' for i in range(pages)])
    return folder


def test_reconciled_but_unread_analysis_is_saved_without_registration(monkeypatch):
    pid, jid = str(uuid.uuid4()), str(uuid.uuid4())
    scope = {'keywords': ['synthetic-checkpoint'], 'research_question': 'Test checkpoint display'}
    meta = metadata('Partial checkpoint ' + jid, '10.1234/' + jid)
    with session() as s:
        s.add(Project(id=pid, name='Checkpoint fixture', goal='', scope=json.dumps(scope)))
        s.add(Job(id=jid, project_id=pid, requested=1))
    folder = candidate_folder(meta, scope)
    folder.mkdir(parents=True)
    (folder / 'paper.pdf').write_bytes(b'%PDF-synthetic-checkpoint-fixture')
    monkeypatch.setattr('app.pipeline.inspect_pdf', lambda path: ['Synthetic Figure 1'])
    monkeypatch.setattr('app.pipeline.search', lambda *args: ([meta], []))
    monkeypatch.setattr('app.pipeline.challenge_image', lambda path: None)

    _run_job(jid, provider=CheckpointProvider(unread=True), skill=CheckpointSkill())

    partial = json.loads((folder / 'provisional.json').read_text('utf-8'))
    assert partial['summary'].startswith('Reconciled summary')
    assert partial['verified'] is False and partial['provisional'] is True
    assert partial['verification_status'] == 'unverified'
    assert 'structural_validation' not in partial
    assert partial['coverage']['visual_pages_checked'] == [1]
    assert partial['visuals'][0]['label'] == 'Figure 1'
    assert any('Supplementary data' in gap for gap in partial['verification_gaps'])
    assert (folder / 'text-checkpoints.json').exists()
    with session() as s:
        state = json.loads(s.get(Job, jid).checkpoint)
        assert state['actual'] == 0 and state['shortfall'] == 1
        assert state['pending_verification'] == 1
        assert s.scalars(select(Paper)).all() == []


def test_visual_failure_preserves_only_actual_checked_pages(monkeypatch):
    folder = prepared_folder(monkeypatch, pages=2)
    with pytest.raises(ValueError, match='第 2 页'):
        analyze(CheckpointProvider(bad_visual_page=2), CheckpointSkill(), metadata(), {}, folder, lambda stage: None)
    partial = json.loads((folder / 'provisional.json').read_text('utf-8'))
    assert partial['summary'] == analysis()['summary']
    assert partial['verified'] is False and partial['verification_status'] == 'unverified'
    assert partial['coverage']['visual_pages_checked'] == [1]
    assert partial['coverage']['required_visual_pages'] == [1, 2]
    assert [item['page'] for item in partial['visuals']] == [1]
    assert any('第 2 页' in gap for gap in partial['verification_gaps'])


def test_validation_failure_does_not_persist_false_verified_claim(monkeypatch):
    folder = prepared_folder(monkeypatch)
    with pytest.raises(ValueError, match='结构校验未通过'):
        analyze(CheckpointProvider(), CheckpointSkill(fail_validation=True), metadata(), {}, folder, lambda stage: None)
    for name in ['provisional.json', 'analysis.json']:
        saved = json.loads((folder / name).read_text('utf-8'))
        assert saved['verified'] is False
        assert saved['verification_status'] == 'unverified'
        assert 'structural_validation' not in saved
    assert 'Reconciled summary' in json.loads((folder / 'provisional.json').read_text('utf-8'))['summary']


def test_success_replaces_provisional_with_final_verified_analysis(monkeypatch):
    folder = prepared_folder(monkeypatch)
    result = analyze(CheckpointProvider(), CheckpointSkill(), metadata(), {}, folder, lambda stage: None)
    assert result['verified'] is True and result['structural_validation'] == 'builtin_passed'
    assert json.loads((folder / 'analysis.json').read_text('utf-8'))['verified'] is True
    assert not (folder / 'provisional.json').exists()
