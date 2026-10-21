"""Exports retain saved evidence and never call external analysis services."""
import io
import json
import zipfile

from app.config import DATA
from app.db import Job, Reference, session
from app.exporting import clean_export, offline_index
from app.pipeline import candidate_folder
from fixtures import analysis, metadata


def export_fixture(logged):
    p = logged.post('/api/projects', json={'name': 'Synthetic export <script>inert()</script>',
                    'scope': {'core_question': 'Retain evidence gaps', 'known_resources': 'Unknown', 'default_count': 3}}).json()
    candidate = dict(metadata('Unfinished synthetic candidate'), status='unverified', reason='Original figure unavailable')
    state = {'scope_snapshot': p['scope'], 'candidates': [candidate], 'completed': [],
             'actual': 0, 'pending_verification': 1, 'shortfall': 3,
             'search_log': [{'query': 'Synthetic search', 'retrieved_at': '2026-10-21T10:00:00Z'}],
             'synthesis': {'status': 'partial', 'record_ids': [], 'limitations': ['No completed evidence']}}
    with session() as s:
        s.add(Job(id='saved-export-job', project_id=p['id'], requested=3, status='completed', checkpoint=json.dumps(state)))
        s.add(Reference(id='export-reference', project_id=p['id'], filename='synthetic.pdf', sha256='a' * 64, text=json.dumps(['Synthetic scope text'])))
    folder = candidate_folder(candidate, p['scope'])
    folder.mkdir(parents=True, exist_ok=True)
    draft = dict(analysis(), verified=True, artifact_dir='private/path')
    (folder / 'provisional.json').write_text(json.dumps(draft), 'utf-8')
    return p


def test_private_json_export_retains_project_batches_candidates_and_gaps(logged, monkeypatch):
    p = export_fixture(logged)
    def forbidden(*args, **kwargs):
        raise AssertionError('Reading an export must never load model configuration')
    monkeypatch.setattr('app.main.configuration', forbidden)
    response = logged.get(f'/api/projects/{p["id"]}/export?kind=json')
    assert response.status_code == 200
    bundle = response.json()
    assert bundle['schema_version'] == 2 and bundle['papers'] == []
    assert bundle['project']['scope']['known_resources'] == 'Unknown'
    assert bundle['references'][0]['text_pages'] == ['Synthetic scope text']
    job = bundle['jobs'][0]
    assert job['checkpoint']['synthesis']['limitations'] == ['No completed evidence']
    assert job['checkpoint']['shortfall'] == 3
    assert job['checkpoint']['search_log'][0]['query'] == 'Synthetic search'
    draft = job['candidate_records'][0]
    assert draft['candidate']['reason'] == 'Original figure unavailable'
    assert draft['analysis']['verified'] is False and draft['analysis']['provisional'] is True
    assert 'artifact_dir' not in response.text
    assert logged.get(f'/api/projects/{p["id"]}/export?kind=json&legacy=true').json() == []


def test_markdown_and_offline_exports_retain_empty_batch_evidence(logged):
    p = export_fixture(logged)
    for kind in ('markdown', 'html'):
        result = logged.get(f'/api/projects/{p["id"]}/export?kind={kind}')
        assert result.status_code == 200
        with zipfile.ZipFile(io.BytesIO(result.content)) as z:
            bundle = json.loads(z.read('research.json'))
            assert bundle['project']['scope']['default_count'] == 3
            assert json.loads(z.read('papers.json')) == []
            md = z.read('project.md').decode()
            assert 'Original figure unavailable' in md and 'No completed evidence' in md
            assert 'Synthetic scope text' in md and 'Synthetic search' in md
            assert not any(name.endswith('.pdf') for name in z.namelist())
            if kind == 'html':
                page = z.read('index.html').decode()
                assert 'data-tab="recent"' in page and 'data-tab="actions"' in page
                assert 'data-filter' in page and 'candidate_records' not in page
                assert 'Original figure unavailable' in page and 'No completed evidence' in page
                assert '<script>inert()</script>' not in page
                assert '&lt;script&gt;inert()&lt;/script&gt;' in page
                assert 'fetch(' not in page and 'type="module"' not in page


def test_export_endpoint_still_requires_login(client):
    assert client.get('/api/projects/anything/export?kind=json').status_code == 401


def test_export_sanitization_and_local_filter_fields():
    value = clean_export({'project': {'name': 'Example'}, 'settings': {'api_key': 'secret', 'token': 'secret'},
                          'papers': [{'analysis': {'artifact_dir': 'internal', 'summary': 'Retain'}}]})
    assert 'secret' not in json.dumps(value) and 'internal' not in json.dumps(value)
    paper = dict(metadata(), id='R001', themes=['Synthetic theme'], analysis=analysis(), batch_id='saved-job')
    page = offline_index({'project': {'name': 'Example'}, 'papers': [paper], 'jobs': []})
    assert 'R001/index.html' in page and 'data-themes="Synthetic theme"' in page
    assert 'data-priorities="P0"' in page and 'data-evidence="1"' in page
    assert 'id="date"' in page and 'id="priority"' in page
