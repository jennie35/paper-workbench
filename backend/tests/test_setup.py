"""Setup regressions use only synthetic configuration and mocked API capability checks."""
import pytest

from app.db import Job, session
from app.pipeline import configuration
from app.schemas import ProviderInput
from fixtures import make_pdf
from test_api import candidate_fixture


@pytest.fixture
def setup_provider(logged, monkeypatch):
    monkeypatch.setattr('app.main.public_url', lambda value: value)
    monkeypatch.setattr('app.provider.public_url', lambda value: value)
    monkeypatch.setattr('app.main.Skill.preflight', lambda self: {'available': True})
    monkeypatch.setattr('app.main.challenge_image', lambda folder: b'generated-test-image')
    monkeypatch.setattr('app.main.Provider.preflight', lambda self, image: None)
    data = {'base_url': 'https://provider.example/v1', 'api_key': 'SYNTHETIC-KEY', 'text_model': 'text', 'vision_model': 'vision', 'openalex_key': ''}
    assert logged.put('/api/settings', json=data).status_code == 200
    return data


def test_setup_status_requires_auth_and_exposes_only_readiness(client):
    assert client.get('/api/workspace/status').status_code == 401
    assert client.get('/api/projects/private/references').status_code == 401
    assert client.post('/api/preflight').status_code == 401


def test_unconfigured_readiness_is_explicit(logged):
    assert logged.get('/api/settings').json() == {'configured': False, 'preflight': {'ready': False, 'checked_at': None}}
    assert logged.post('/api/preflight').status_code == 400


def test_successful_preflight_is_private_and_survives_unchanged_save(logged, setup_provider):
    assert logged.get('/api/settings').json()['preflight'] == {'ready': False, 'checked_at': None}
    result = logged.post('/api/preflight')
    assert result.status_code == 200
    assert result.json()['ready'] is True
    view = logged.get('/api/settings')
    before = view.json()['preflight']
    assert before['ready'] is True and before['checked_at']
    assert 'SYNTHETIC-KEY' not in view.text
    assert 'fingerprint' not in view.text and 'attempt' not in view.text
    saved = dict(setup_provider, api_key='', openalex_key='')
    assert logged.put('/api/settings', json=saved).status_code == 200
    assert logged.get('/api/settings').json()['preflight'] == before


@pytest.mark.parametrize('change', [
    {'text_model': 'new-text'}, {'vision_model': 'new-vision'},
    {'api_key': 'SYNTHETIC-NEW-KEY'}, {'openalex_key': 'SYNTHETIC-ALEX'},
    {'base_url': 'https://provider.example/v2'},
])
def test_config_changes_invalidate_successful_preflight(logged, setup_provider, change):
    assert logged.post('/api/preflight').status_code == 200
    assert logged.put('/api/settings', json=dict(setup_provider, **change)).status_code == 200
    assert logged.get('/api/settings').json()['preflight'] == {'ready': False, 'checked_at': None}


def test_same_origin_model_change_can_retain_key(logged, setup_provider):
    update = dict(setup_provider, base_url='https://provider.example:443/v2', text_model='new-model', api_key='')
    assert logged.put('/api/settings', json=update).status_code == 200
    assert configuration()['api_key'] == 'SYNTHETIC-KEY'
    assert configuration()['text_model'] == 'new-model'


def test_cross_provider_requires_replacement_key_and_preserves_old_configuration(logged, setup_provider):
    assert logged.post('/api/preflight').status_code == 200
    previous = logged.get('/api/settings').json()
    update = dict(setup_provider, base_url='https://different-provider.example/v1', api_key='')
    rejected = logged.put('/api/settings', json=update)
    assert rejected.status_code == 400
    assert '新 API 密钥' in rejected.json()['detail']
    assert logged.get('/api/settings').json() == previous
    assert configuration()['base_url'] == setup_provider['base_url']
    update['api_key'] = 'SYNTHETIC-DIFFERENT-PROVIDER-KEY'
    assert logged.put('/api/settings', json=update).status_code == 200
    assert configuration()['api_key'] == update['api_key']
    assert logged.get('/api/settings').json()['preflight']['ready'] is False


@pytest.mark.parametrize('target', ['app.main.Skill.preflight', 'app.main.Provider.preflight'])
def test_failed_check_revokes_previous_success(logged, setup_provider, monkeypatch, target):
    assert logged.post('/api/preflight').status_code == 200
    def fail(*args):
        raise ValueError('Synthetic capability failure')
    monkeypatch.setattr(target, fail)
    result = logged.post('/api/preflight')
    assert result.status_code == 400
    status = logged.get('/api/settings').json()['preflight']
    assert status['ready'] is False and status['checked_at']


def test_old_preflight_cannot_mark_changed_configuration_ready(logged, setup_provider, monkeypatch):
    from app.main import save_settings
    def change_during_check(self, image):
        save_settings(ProviderInput(**dict(setup_provider, vision_model='changed-during-check')))
    monkeypatch.setattr('app.main.Provider.preflight', change_during_check)
    result = logged.post('/api/preflight')
    assert result.status_code == 409
    assert '检查期间配置已更改' in result.json()['detail']
    assert logged.get('/api/settings').json()['vision_model'] == 'changed-during-check'
    assert logged.get('/api/settings').json()['preflight'] == {'ready': False, 'checked_at': None}


def test_old_attempt_cannot_overwrite_newer_success(logged, setup_provider, monkeypatch):
    from app.main import preflight
    calls = []
    def start_new_check(self, image):
        calls.append(True)
        if len(calls) == 1:
            assert preflight()['ready'] is True
            raise ValueError('Synthetic older request failed after a newer success')
    monkeypatch.setattr('app.main.Provider.preflight', start_new_check)
    assert logged.post('/api/preflight').status_code == 400
    assert logged.get('/api/settings').json()['preflight']['ready'] is True


def test_workspace_status_finds_active_job_in_other_project(logged, monkeypatch):
    monkeypatch.setattr('app.main.reconcile_job', lambda job: None)
    project_a = logged.post('/api/projects', json={'name': 'Synthetic A'}).json()
    project_b = logged.post('/api/projects', json={'name': 'Synthetic B'}).json()
    assert logged.get('/api/workspace/status').json() == {'active_job': None}
    with session() as s:
        s.add(Job(id='finished-job', project_id=project_a['id'], requested=1, status='completed', stage='完成'))
        s.add(Job(id='active-other-project', project_id=project_b['id'], requested=5, status='running', stage='图表核验'))
    result = logged.get('/api/workspace/status')
    assert result.status_code == 200
    assert result.json() == {'active_job': {'id': 'active-other-project', 'project_id': project_b['id'], 'stage': '图表核验', 'status': 'running'}}
    assert set(result.json()['active_job']) == {'id', 'project_id', 'stage', 'status'}


def test_workspace_status_reconciles_stopped_jobs(logged, monkeypatch):
    project = logged.post('/api/projects', json={'name': 'Synthetic stopped job'}).json()
    with session() as s:
        s.add(Job(id='stopped-job', project_id=project['id'], requested=1, status='running'))
    def stopped(job):
        job.status = 'failed'
    monkeypatch.setattr('app.main.reconcile_job', stopped)
    assert logged.get('/api/workspace/status').json() == {'active_job': None}


def test_reference_metadata_is_private_and_duplicate_uploads_are_reused(logged, tmp_path):
    project = logged.post('/api/projects', json={'name': 'Synthetic references'}).json()
    other = logged.post('/api/projects', json={'name': 'Separate synthetic references'}).json()
    endpoint = f'/api/projects/{project["id"]}/references'
    assert logged.get(endpoint).json() == []
    assert logged.get('/api/projects/unknown/references').status_code == 404
    fixture = tmp_path / 'generated.pdf'
    make_pdf(fixture)
    uploaded = logged.post(endpoint, files={'file': ('scope-reference.pdf', fixture.read_bytes(), 'application/pdf')})
    assert uploaded.status_code == 200
    result = uploaded.json()
    response = logged.get(endpoint)
    assert response.status_code == 200
    assert response.json() == [{'id': result['id'], 'filename': 'scope-reference.pdf', 'pages': 1, 'sha256': result['sha256'], 'role': '研究范围参考，不占精读额度'}]
    assert 'Synthetic test paper' not in response.text
    assert 'reference.pdf' not in {key for row in response.json() for key in row}
    assert 'text' not in response.json()[0] and 'path' not in response.json()[0]
    duplicate = logged.post(endpoint, files={'file': ('retry.pdf', fixture.read_bytes(), 'application/pdf')})
    assert duplicate.status_code == 200
    assert duplicate.json()['id'] == result['id']
    assert duplicate.json()['reused'] is True
    assert len(logged.get(endpoint).json()) == 1
    assert logged.get(f'/api/projects/{other["id"]}/references').json() == []
    different_project = logged.post(f'/api/projects/{other["id"]}/references', files={'file': ('own.pdf', fixture.read_bytes(), 'application/pdf')})
    assert different_project.status_code == 200
    assert different_project.json()['id'] != result['id']


def test_candidate_upload_persists_feedback_without_marking_complete(logged, tmp_path):
    from datetime import datetime
    jid, folder = candidate_fixture(logged, status='no_fulltext')
    fixture = tmp_path / 'generated-fulltext.pdf'
    make_pdf(fixture)
    endpoint = f'/api/jobs/{jid}/candidates/0/pdf'
    result = logged.post(endpoint, files={'file': ('C:\\private\\research\\supplied.pdf', fixture.read_bytes(), 'application/pdf')})
    assert result.status_code == 200
    feedback = result.json()
    assert feedback['fulltext_uploaded'] is True
    assert feedback['uploaded_filename'] == 'supplied.pdf'
    assert datetime.fromisoformat(feedback['fulltext_uploaded_at'])
    job = logged.get(f'/api/jobs/{jid}').json()
    candidate = job['checkpoint']['candidates'][0]
    for key in ('fulltext_uploaded', 'uploaded_filename', 'fulltext_uploaded_at'):
        assert candidate[key] == feedback[key]
    assert candidate['status'] == 'no_fulltext'
    assert job['checkpoint']['completed'] == []
    assert job['checkpoint']['shortfall'] == 5
    assert logged.get(f'/api/jobs/{jid}/candidates/0').json()['candidate']['fulltext_uploaded'] is True
    assert (folder / 'paper.pdf').read_bytes() == fixture.read_bytes()
    assert not list(folder.glob('upload-*.pdf'))


def test_candidate_upload_rechecks_job_admission_after_parsing(logged, monkeypatch):
    from app.main import save_upload
    jid, folder = candidate_fixture(logged)
    make_pdf(folder / 'paper.pdf')
    original = (folder / 'paper.pdf').read_bytes()
    (folder / 'provisional.json').write_text('{"summary":"Preserved synthetic draft"}', 'utf-8')
    async def resume_during_upload(file, path):
        result = await save_upload(file, path)
        with session() as s:
            s.get(Job, jid).status = 'running'
        return result
    monkeypatch.setattr('app.main.save_upload', resume_during_upload)
    result = logged.post(f'/api/jobs/{jid}/candidates/0/pdf', files={'file': ('changed.pdf', original + b'\n% Fixture replacement', 'application/pdf')})
    assert result.status_code == 409
    assert '尚未替换正文' in result.json()['detail']
    assert (folder / 'paper.pdf').read_bytes() == original
    assert (folder / 'provisional.json').is_file()
    assert not list(folder.glob('revision-*'))
    assert not list(folder.glob('upload-*.pdf'))
    with session() as s:
        import json
        candidate = json.loads(s.get(Job, jid).checkpoint)['candidates'][0]
    assert 'fulltext_uploaded' not in candidate


def test_invalid_candidate_upload_does_not_set_feedback(logged):
    jid, folder = candidate_fixture(logged)
    result = logged.post(f'/api/jobs/{jid}/candidates/0/pdf', files={'file': ('invalid.pdf', b'not a PDF', 'application/pdf')})
    assert result.status_code == 400
    assert not (folder / 'paper.pdf').exists()
    assert not list(folder.glob('upload-*.pdf'))
    assert 'fulltext_uploaded' not in logged.get(f'/api/jobs/{jid}/candidates/0').json()['candidate']
