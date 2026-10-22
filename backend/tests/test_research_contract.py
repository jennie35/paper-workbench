"""Research logic fixtures never contact a model or consume private material."""
import json

import pytest

from app.artifacts import evidence_bundle, markdown_note, write_artifacts, write_record_index
from app.config import DATA
from app.db import Job, session
from app.pipeline import validate_analysis
from app.discovery import crossref_bibliography, source_date
from app.research import build_synthesis, stamp_reading_scope
from app.schemas import ResearchLogic, Scope
from fixtures import analysis, metadata


def test_expanded_project_configuration_is_compatible_and_storage_is_authoritative(logged):
    config = {'core_question': 'Which control removes the confound?', 'research_stage': 'design',
              'research_object': 'Synthetic specimens', 'application_context': 'Software acceptance only',
              'known_resources': 'Unknown instruments', 'constraints': 'No real experiments',
              'keywords_zh': ['测量'], 'keywords_en': ['measurement'], 'default_count': 2,
              'run_mode': 'existing-task', 'output_language': 'zh-CN', 'storage_root': 'C:/DO-NOT-WRITE'}
    p = logged.post('/api/projects', json={'name': 'Research configuration', 'scope': config}).json()
    assert p['scope']['research_question'] == config['core_question']
    assert p['scope']['keywords'] == ['测量', 'measurement']
    assert p['scope']['storage_root'] == str(DATA.resolve())
    config['core_question'] = 'Revised explicit question'
    saved = logged.put(f'/api/projects/{p["id"]}/scope', json=config).json()['scope']
    assert saved['core_question'] == config['core_question']
    assert saved['known_resources'] == 'Unknown instruments'
    assert saved['storage_root'] == str(DATA.resolve())
    assert logged.get('/api/workspace/status').json()['active_job'] is None
    with pytest.raises(ValueError):
        Scope(default_count=21)


def test_infer_scope_preserves_known_conditions_and_does_not_send_storage_path(logged, monkeypatch):
    project = logged.post('/api/projects', json={'name': 'Topic', 'scope': {'core_question': 'User question', 'known_resources': 'Unknown', 'constraints': 'No budget', 'inferred': False}}).json()
    monkeypatch.setattr('app.main.configuration', lambda: {})
    class Model:
        def __init__(self, cfg):
            pass
        def json(self, prompt):
            assert str(DATA) not in prompt
            return {'core_question': 'Invented different question', 'known_resources': 'A costly scanner', 'constraints': 'Unlimited'}
    monkeypatch.setattr('app.main.Provider', Model)
    r = logged.post(f'/api/projects/{project["id"]}/infer-scope').json()
    assert r['core_question'] == 'User question'
    assert r['known_resources'] == 'Unknown' and r['constraints'] == 'No budget'


def test_logic_provenance_and_inspection_flags_are_gated():
    a = analysis()
    logic = ResearchLogic().model_dump()
    logic['reading_scope']['verified'] = ['Model claims all figures viewed']
    logic['evidence_review'] = [{'kind': 'figure', 'locator': 'Figure 1', 'claim': 'Fixture', 'comparison': 'Unknown', 'axes_units': 'Unknown', 'statistical_unit': 'Unknown', 'uncertainty': 'Unknown', 'consistency': 'Unverified', 'verification_status': 'visually_verified', 'source_block_ids': ['P0001-B0001']}]
    a['research_logic'] = logic
    validate_analysis(a, {'blocks': [{'id': 'P0001-B0001'}]}, 1)
    assert a['research_logic']['reading_scope']['verified'] == []
    assert a['research_logic']['evidence_review'][0]['verification_status'] == 'unverified'
    stamp_reading_scope(a, [1])
    assert '第 1 页' in a['research_logic']['reading_scope']['verified'][1]
    a['research_logic']['evidence_review'][0]['source_block_ids'] = ['MADE-UP']
    with pytest.raises(ValueError, match='不存在的正文'):
        validate_analysis(a, {'blocks': [{'id': 'P0001-B0001'}]}, 1)


def test_infer_scope_accepts_question_alias_without_stale_inferred_core(logged, monkeypatch):
    project = logged.post('/api/projects', json={'name': 'Synthetic topic'}).json()
    monkeypatch.setattr('app.main.configuration', lambda: {})
    class Model:
        def __init__(self, cfg):
            pass
        def json(self, prompt):
            return {'research_question': 'New question proposed for user review'}
    monkeypatch.setattr('app.main.Provider', Model)
    result = logged.post(f'/api/projects/{project["id"]}/infer-scope').json()
    assert result['research_question'] == result['core_question'] == 'New question proposed for user review'
    # Inference is a proposal; GET still returns the saved scope until confirmed.
    saved = logged.get('/api/projects').json()
    assert next(p for p in saved if p['id'] == project['id'])['scope']['core_question'] == 'Synthetic topic'


def test_reports_preserve_analysis_and_pending_actions_without_empty_visual_section():
    a = analysis()
    a['research_logic'] = ResearchLogic().model_dump()
    a['project_context'] = {'project_id': 'synthetic-only', 'scope_snapshot': {'known_resources': 'Not confirmed at original reading'}}
    a['actions'][0].update(experimental_unit='Independent synthetic specimen', stopping_criteria='Stop if the baseline cannot be measured', data='Synthetic observations', question='Which uncertainty is reduced?')
    note = markdown_note(metadata(), a)
    assert len([line for line in note.splitlines() if line.startswith('## ')]) == 10
    assert '## 7.' not in note
    assert '分析者绘制，非论文原图' in note
    assert '独立实验单位' in note and 'Stop if the baseline' in note
    assert 'Not confirmed at original reading' in note
    assert note.count('分析采用 norman-paper-reading 技能') == 1
    record = evidence_bundle(metadata(), a, {'blocks': [{'id': 'P0001-B0001', 'page': 1}]})
    assert record['research_logic'] == a['research_logic']
    assert record['project_context'] == a['project_context']
    assert record['actions'][0]['status'] == 'pending'
    assert record['actions'][0]['experimental_unit'] == a['actions'][0]['experimental_unit']


def test_design_rationale_claimed_as_author_statement_requires_source():
    a = analysis()
    a['research_logic'] = ResearchLogic().model_dump()
    decision = {'decision': 'Synthetic control', 'problem': 'Confounding', 'rationale': 'Synthetic rationale',
                'rationale_origin': 'author_interpretation', 'cost': 'Unknown', 'alternative': 'Unknown', 'source_block_ids': []}
    a['research_logic']['design_decisions'] = [decision]
    with pytest.raises(ValueError, match='作者说明的设计理由'):
        validate_analysis(a, {'blocks': [{'id': 'P0001-B0001'}]}, 1)
    decision['source_block_ids'] = ['P0001-B0001']
    validate_analysis(a, {'blocks': [{'id': 'P0001-B0001'}]}, 1)


def records():
    return [dict(metadata('Fixture ' + str(i)), id=f'R{i:03d}', analysis=analysis()) for i in (1, 2)]


def test_cross_paper_synthesis_rejects_invented_sources_and_pairs():
    class Model:
        def json(self, prompt):
            assert 'PRIVATE-ROOT' not in prompt
            return {'supports': [{'record_ids': ['R001', 'R002'], 'claim': 'Synthetic agreement', 'reason': 'Fixture only'}, {'record_ids': ['R001'], 'claim': 'Single cannot support cross paper', 'reason': 'Fixture'}],
                    'conflicts': [{'record_ids': ['R001', 'R999'], 'claim': 'Invented', 'possible_causes': 'Unknown', 'needed_evidence': 'None'}],
                    'priority_actions': [{'record_id': 'R002', 'action_id': 'A01', 'reason': 'Smallest prerequisite check'}, {'record_id': 'R999', 'action_id': 'A01'}]}
    result = build_synthesis(Model(), {'core_question': 'Synthetic', 'storage_root': 'PRIVATE-ROOT'}, records())
    assert len(result['supports']) == 1 and result['conflicts'] == []
    assert [(x['record_id'], x['action_id']) for x in result['priority_actions']] == [('R002', 'A01')]
    assert result['status'] == 'partial'
    assert result['scope_snapshot']['storage_root'] == 'PRIVATE-ROOT'


def test_synthesis_without_saved_reports_does_not_call_model():
    class NoCall:
        def json(self, prompt):
            pytest.fail('No real papers must not trigger paid synthesis')
    result = build_synthesis(NoCall(), {}, [])
    assert result['status'] == 'insufficient_evidence' and result['record_ids'] == []


def test_bounded_synthesis_reports_only_the_records_actually_sent():
    rows = [dict(metadata('Synthetic ' + str(i)), id=f'R{i:03d}', analysis=analysis()) for i in range(1, 32)]
    class Model:
        def json(self, prompt):
            assert '"id": "R001"' not in prompt
            assert '"id": "R031"' in prompt
            return {'priority_actions': [{'record_id': 'R031', 'action_id': 'A01', 'reason': 'Synthetic prerequisite'}]}
    result = build_synthesis(Model(), {}, rows)
    assert result['available_record_count'] == 31
    assert result['record_ids'] == [f'R{i:03d}' for i in range(2, 32)]
    assert any('最近 30 篇' in line for line in result['limitations'])


def test_synthesis_get_is_read_only_and_generation_is_explicit(logged, monkeypatch):
    p = logged.post('/api/projects', json={'name': 'Synthesis access'}).json()
    with session() as s:
        s.add(Job(id='synthesis-fixture', project_id=p['id'], requested=5, status='completed', checkpoint='{}'))
    def forbidden():
        pytest.fail('GET must not access model configuration')
    monkeypatch.setattr('app.main.configuration', forbidden)
    assert logged.get('/api/jobs/synthesis-fixture/synthesis').json() is None
    monkeypatch.setattr('app.main.configuration', lambda: {})
    r = logged.post('/api/jobs/synthesis-fixture/synthesis')
    assert r.status_code == 200 and r.json()['status'] == 'insufficient_evidence'
    assert logged.get('/api/jobs/synthesis-fixture/synthesis').json() == r.json()
    with session() as s:
        s.get(Job, 'synthesis-fixture').status = 'running'
    assert logged.post('/api/jobs/synthesis-fixture/synthesis').status_code == 409


def test_dated_views_keep_single_canonical_sources_and_reject_conflicting_records(tmp_path):
    canonical = tmp_path / 'papers' / 'fingerprint'
    (canonical / 'assets').mkdir(parents=True)
    (canonical / 'source').mkdir()
    (canonical / 'paper.pdf').write_bytes(b'%PDF-synthetic')
    (canonical / 'assets/page-1.png').write_bytes(b'synthetic-image')
    sm = {'blocks': [{'id': 'P0001-B0001', 'page': 1}]}
    a = dict(analysis(), artifact_dir='papers/fingerprint', analyzed_date='2026-10-21', source_sha256='abc', verified=True)
    write_artifacts(canonical, metadata(), a, sm)
    path = write_record_index(tmp_path, 1, metadata(), a)
    view = tmp_path / path
    assert path == '2026-10-21/R001'
    assert (view / 'reading-note.md').is_file() and (view / 'evidence.json').is_file()
    assert '../../papers/fingerprint/assets/' in (view / 'reading-note.md').read_text('utf-8')
    assert len(list(tmp_path.rglob('paper.pdf'))) == len(list(tmp_path.rglob('page-1.png'))) == 1
    assert write_record_index(tmp_path, 1, metadata(), a) == path
    with pytest.raises(ValueError, match='不同来源'):
        write_record_index(tmp_path, 1, metadata(doi='10.1234/different'), a)
    assert (canonical / 'paper.pdf').read_bytes() == b'%PDF-synthetic'


def test_metadata_retains_supplied_date_precision_and_distinguishes_issue_year():
    row = crossref_bibliography({'published-online': {'date-parts': [[2025, 12]]},
                                 'published-print': {'date-parts': [[2026, 2, 10]]},
                                 'volume': '31', 'issue': '2', 'page': '110–119'})
    assert row['first_publication_date'] == '2025-12'
    assert row['publication_date_precision'] == 'month'
    assert row['online_date'] == '2025-12' and row['print_date'] == '2026-02-10'
    assert row['year'] == row['issue_year'] == 2026
    assert (row['volume'], row['issue'], row['pages']) == ('31', '2', '110–119')
    ambiguous = crossref_bibliography({'published-online': {'date-parts': [[2026, 2]]},
                                      'published-print': {'date-parts': [[2026]]}})
    assert ambiguous['first_publication_date'] == ''
    assert ambiguous['publication_date'] == '2026-02'
    assert source_date([2026, 2, 30]) == source_date([None]) == ''
    meta = dict(metadata(), **row)
    evidence = evidence_bundle(meta, analysis(), {'blocks': [{'id': 'P0001-B0001', 'page': 1}]})
    assert evidence['paper']['first_publication_date'] == '2025-12'
    assert evidence['paper']['publication_dates'] == row['publication_dates']
    assert evidence['paper']['volume'] == '31' and evidence['paper']['pages'] == '110–119'


def test_batch_omitted_count_uses_project_setting_but_explicit_count_wins(logged, monkeypatch):
    monkeypatch.setattr('app.main.configuration', lambda: {})
    monkeypatch.setattr('app.main.Skill.preflight', lambda self: {'available': True})
    monkeypatch.setattr('app.main.enqueue', lambda jid: None)
    p = logged.post('/api/projects', json={'name': 'Default count fixture', 'scope': {'default_count': 3, 'run_mode': 'existing-task'}}).json()
    first = logged.post(f'/api/projects/{p["id"]}/jobs', json={})
    assert first.status_code == 200
    with session() as s:
        job = s.get(Job, first.json()['id'])
        assert job.requested == 3
        assert json.loads(job.checkpoint)['trigger_source'] == 'manual'
        job.status = 'completed'
    second = logged.post(f'/api/projects/{p["id"]}/jobs', json={'count': 5})
    assert second.status_code == 200
    with session() as s:
        assert s.get(Job, second.json()['id']).requested == 5
    assert logged.post(f'/api/projects/{p["id"]}/jobs', json={'count': 0}).status_code == 422
