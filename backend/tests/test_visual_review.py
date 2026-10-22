"""Actual image-input receipts, source integrity and report/export projections."""
from copy import deepcopy
import hashlib
import io
import json
import zipfile

import pytest

from app.artifacts import markdown_note, write_artifacts
from app.config import DATA
from app.pipeline import analyze, register
from app.visual_review import (checked_visual_records, inspection_receipt,
                               project_visual_evidence, report_visuals,
                               stamp_visual_evidence)
from fixtures import analysis, metadata
from test_api import candidate_fixture
from test_partial_checkpoint import CheckpointProvider, CheckpointSkill, prepared_folder


def observed_item(**values):
    return dict({'label': 'Figure 1', 'kind': 'figure',
                 'explanation': 'Synthetic panel compares matched baseline and treatment; this is a software fixture.',
                 'comparison': 'Baseline versus treatment (synthetic)', 'axes_units': 'x: group; y: test units',
                 'limitations': 'Synthetic fixture, no scientific findings.'}, **values)


def save_receipt(folder, items=None):
    (folder / 'assets').mkdir(parents=True, exist_ok=True)
    (folder / 'paper.pdf').write_bytes(b'%PDF-receipt-test-only')
    image = folder / 'assets/page-1.png'
    image.write_bytes(b'An image-input test fixture, not a real figure')
    digest = hashlib.sha256((folder / 'paper.pdf').read_bytes()).hexdigest()
    record = inspection_receipt({'readable': True, 'items': items or [observed_item()], 'unread': []}, image, 1, digest)
    (folder / 'visual-checkpoints.json').write_text(json.dumps({'1': record}), 'utf-8')
    return record


def test_receipt_ignores_model_provenance_and_requires_specific_numbered_content(tmp_path):
    record = save_receipt(tmp_path, [
        observed_item(page=99, source_page=99, asset_path='../../secret.png', inspection_id='MODEL-CERTIFICATE',
                      image_sha256='f' * 64, inspection_status='verified'),
        observed_item(label='PDF page 2'),
        observed_item(label='Figure 3', explanation='此项核验记录：尚未核验'),
        observed_item(label='Figure 4', readable=False),
        observed_item(label='Table 1', kind='figure'),
        observed_item(label='(2)', kind='equation', explanation='Synthetic equation: y is the measured output.', latex=r'y = a x'),
    ])
    assert [row['label'] for row in record['items']] == ['Figure 1', '(2)']
    assert 'page' not in record['items'][0]
    assert record['inspection']['inspection_id'] != 'MODEL-CERTIFICATE'
    a = analysis()
    a['visuals'] = [observed_item(page=99, label='Figure 99')]
    a['research_logic']['evidence_review'] = [{'kind': 'figure', 'locator': 'Figure 88', 'claim': 'Unseen', 'verification_status': 'verified'}]
    before = deepcopy(a)
    projected = project_visual_evidence(a, tmp_path, metadata()['url'])
    assert a == before
    assert [row['page'] for row in projected['visuals']] == [1, 1]
    assert [row['label'] for row in projected['visuals']] == ['Figure 1', '(2)']
    assert all(row['inspection_status'] == 'verified' and row['source_page'] == 1 for row in projected['visuals'])
    assert projected['research_logic']['evidence_review'][0]['source_url'] == metadata()['url']
    assert projected['visual_review_audit']['unattested_visuals'] == before['visuals']
    assert projected['visual_review_audit']['text_model_evidence_review'] == before['research_logic']['evidence_review']
    note = markdown_note(metadata(), projected)
    section = note.split('## 7.', 1)[1].split('## 8.', 1)[0]
    assert 'Figure 99' not in section and 'Figure 88' not in section
    assert 'PDF 第 1 页' in section and 'assets/page-1.png' in section
    assert 'x: group' in section and '未经人工复核' in section
    assert '$$\ny = a x\n$$' in section


@pytest.mark.parametrize('changed', ['pdf', 'image', 'source_hash', 'unattested', 'missing_id', 'missing_image'])
def test_changed_or_unattested_sources_never_reach_report(tmp_path, changed):
    record = save_receipt(tmp_path)
    a = analysis()
    stamp_visual_evidence(a, checked_visual_records(tmp_path), [], metadata()['url'])
    if changed == 'pdf':
        (tmp_path / 'paper.pdf').write_bytes(b'%PDF-different-source')
    elif changed == 'image':
        (tmp_path / 'assets/page-1.png').write_bytes(b'changed image')
    elif changed == 'missing_image':
        (tmp_path / 'assets/page-1.png').unlink()
    else:
        if changed == 'source_hash':
            record['inspection']['source_sha256'] = 'f' * 64
        elif changed == 'unattested':
            record.pop('inspection')
        else:
            record['inspection'].pop('inspection_id')
        (tmp_path / 'visual-checkpoints.json').write_text(json.dumps({'1': record}), 'utf-8')
    projected = project_visual_evidence(a, tmp_path)
    assert projected['visuals'] == []
    assert projected['research_logic']['evidence_review'] == []
    assert '## 7.' not in markdown_note(metadata(), projected)
    assert projected['visual_review_audit']['unattested_visuals']


def test_model_revision_cannot_add_unseen_figures_and_legacy_checkpoint_is_reinspected(monkeypatch):
    folder = prepared_folder(monkeypatch)
    (folder / 'assets').mkdir()
    (folder / 'assets/page-1.png').write_bytes(b'old unreceipted image')
    (folder / 'visual-checkpoints.json').write_text(json.dumps({'1': {'readable': True, 'items': [observed_item(label='Figure 77')]}}), 'utf-8')
    class Model(CheckpointProvider):
        actual_images = []
        def json(self, prompt, images=None, **kwargs):
            result = super().json(prompt, images, **kwargs)
            if images:
                self.actual_images.append(images[0].read_bytes())
            elif '修正此前文本分析' in prompt:
                result['visuals'] = [observed_item(page=1, label='Figure 99')]
                result['research_logic']['evidence_review'] = [{'kind': 'figure', 'locator': 'Figure 99', 'claim': 'Unseen model claim', 'verification_status': 'verified',
                    'comparison': '', 'axes_units': '', 'statistical_unit': '', 'uncertainty': '', 'consistency': ''}]
            return result
    model = Model()
    result = analyze(model, CheckpointSkill(), metadata(), {}, folder, lambda _: None)
    assert model.actual_images == [b'synthetic-image-request-fixture']
    assert [v['label'] for v in result['visuals']] == ['Figure 1']
    assert [v['label'] for v in result['research_logic']['evidence_review']] == ['Figure 1']
    assert result['visuals'][0]['inspection_id']
    assert 'Figure 99' not in markdown_note(metadata(), result).split('## 7.', 1)[1].split('## 8.', 1)[0]
    # An intact application receipt resumes without an additional image request.
    second = Model()
    second.actual_images = []
    analyze(second, CheckpointSkill(), metadata(), {}, folder, lambda _: None)
    assert second.actual_images == []


def test_candidate_api_uses_fingerprint_checked_observations_without_mutating_audit(logged):
    jid, folder = candidate_fixture(logged)
    record = save_receipt(folder)
    draft = analysis()
    draft['research_logic']['evidence_review'] = [{'kind': 'table', 'locator': 'Table 8', 'claim': 'Not observed', 'verification_status': 'verified'}]
    raw = json.dumps(draft)
    (folder / 'provisional.json').write_text(raw, 'utf-8')
    result = logged.get(f'/api/jobs/{jid}/candidates/0').json()
    assert result['artifacts']['checked_visual_pages'] == [1]
    assert result['analysis']['visuals'][0]['inspection_id'] == record['inspection']['inspection_id']
    assert result['analysis']['research_logic']['evidence_review'][0]['label'] == 'Figure 1'
    assert result['analysis']['verified'] is False and result['analysis']['provisional'] is True
    assert (folder / 'provisional.json').read_text('utf-8') == raw
    (folder / 'assets/page-1.png').write_bytes(b'changed image')
    later = logged.get(f'/api/jobs/{jid}').json()['checkpoint']['candidates'][0]['analysis']
    assert later['visuals'] == [] and later['research_logic']['evidence_review'] == []


def test_retry_inspects_newly_discovered_visual_page_without_repeating_valid_receipt(monkeypatch):
    folder = prepared_folder(monkeypatch, pages=2)
    monkeypatch.setattr('app.pipeline.inspect_pdf', lambda _: ['Synthetic Figure 1', 'A second source page.'])
    class Model(CheckpointProvider):
        def __init__(self):
            super().__init__()
            self.images = []
        def json(self, prompt, images=None, **kwargs):
            result = super().json(prompt, images, **kwargs)
            if images:
                self.images.append(int(images[0].stem.split('-')[-1]))
            elif '修正此前文本分析' in prompt:
                result['required_visual_pages'] = [1, 2]
            return result
    model = Model()
    with pytest.raises(ValueError, match='额外关键原图页'):
        analyze(model, CheckpointSkill(), metadata(), {}, folder, lambda _: None)
    result = analyze(model, CheckpointSkill(), metadata(), {}, folder, lambda _: None)
    assert model.images == [1, 2]
    assert result['coverage']['visual_pages_checked'] == [1, 2]
    assert [row['label'] for row in result['visuals']] == ['Figure 1', 'Figure 2']


def test_registered_api_markdown_html_and_json_share_actual_visual_records(logged, monkeypatch):
    # This test covers report projection, not dated-index creation, which has a
    # separate transaction suite. Avoid sharing its R001 path across DB resets.
    monkeypatch.setattr('app.pipeline.write_record_index', lambda *args, **kwargs: None)
    project = logged.post('/api/projects', json={'name': 'Visual receipt fixture'}).json()
    folder = DATA / 'papers/receipt-export'
    record = save_receipt(folder)
    (folder / 'source').mkdir()
    sm = {'blocks': [{'id': 'P0001-B0001', 'page': 1, 'text': 'Synthetic source block'}]}
    (folder / 'source/source_map.json').write_text(json.dumps(sm), 'utf-8')
    a = analysis()
    a.update(artifact_dir='papers/receipt-export', verified=True)
    # Unattested legacy flags do not contaminate output alongside the real receipt.
    a['visuals'] = [observed_item(page=1, label='Figure 99')]
    write_artifacts(folder, metadata(), a, sm)
    register(project['id'], 'visual-export-job', metadata(), a)
    paper = logged.get('/api/papers/1').json()
    expected = paper['analysis']['visuals']
    assert len(expected) == 1 and expected[0]['label'] == 'Figure 1'
    assert expected[0]['inspection_id'] == record['inspection']['inspection_id']
    for kind in ('markdown', 'html'):
        response = logged.get(f'/api/projects/{project["id"]}/export?kind={kind}')
        assert response.status_code == 200
        with zipfile.ZipFile(io.BytesIO(response.content)) as z:
            note = z.read('R001/reading-note.md').decode()
            section = note.split('## 7.', 1)[1].split('## 8.', 1)[0]
            assert 'Figure 1' in section and 'Figure 99' not in section
            assert z.read('R001/assets/page-1.png') == (folder / 'assets/page-1.png').read_bytes()
            assert json.loads(z.read('R001/evidence.json'))['visuals'] == expected
            assert json.loads(z.read('papers.json'))[0]['analysis']['visuals'] == expected
            assert json.loads(z.read('research.json'))['papers'][0]['analysis']['visuals'] == expected
    assert logged.get(f'/api/projects/{project["id"]}/export?kind=json').json()['papers'][0]['analysis']['visuals'] == expected
    (folder / 'paper.pdf').write_bytes(b'%PDF-modified-source')
    assert logged.get('/api/papers/1').json()['analysis']['visuals'] == []
    changed = logged.get(f'/api/projects/{project["id"]}/export?kind=markdown')
    with zipfile.ZipFile(io.BytesIO(changed.content)) as z:
        assert '## 7.' not in z.read('R001/reading-note.md').decode()
        assert json.loads(z.read('R001/evidence.json'))['visuals'] == []
        assert 'R001/assets/page-1.png' not in z.namelist()
    # Persisted source/model audit files remain intact after report projection.
    assert json.loads((folder / 'analysis.json').read_text('utf-8'))['visuals'][0]['label'] == 'Figure 99'


def test_report_flags_alone_are_not_sufficient():
    a = analysis()
    a['visuals'] = [observed_item(page=1, verification_status='verified')]
    assert report_visuals(a) == []
    assert '## 7.' not in markdown_note(metadata(), a)
