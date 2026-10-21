import io
import json
import os
import zipfile

from app.db import session, Setting, Paper, ProjectPaper, Job
from app.pipeline import register, candidate_folder
from app.config import DATA
from app.artifacts import write_artifacts
from fixtures import metadata, analysis, make_pdf


def test_auth_required(client):
    assert client.get('/health').status_code == 200
    for path in ['/api/projects','/api/settings','/api/jobs/private','/api/papers/1','/api/papers/1/assets/page-1.png','/api/jobs/private/candidates/0','/api/jobs/private/candidates/0/pdf','/api/jobs/private/candidates/0/source','/api/jobs/private/candidates/0/assets/page-1.png']:
        assert client.get(path).status_code == 401


def test_login_limits(client):
    for _ in range(10):
        assert client.post('/api/login',json={'password':'wrong'}).status_code == 401
    assert client.post('/api/login',json={'password':'wrong'}).status_code == 429


def test_project_scope_validation(logged):
    p = logged.post('/api/projects',json={'name':'General ecology','goal':'Independent project'}).json()
    assert p['scope']['inferred'] is True
    scope = {'research_question':'Question','keywords':['ecology'],'include':'Field studies','exclude':'Unrelated','inferred':False}
    saved = logged.put(f'/api/projects/{p["id"]}/scope',json=scope).json()['scope']
    assert {key: saved[key] for key in scope} == scope
    assert saved['core_question'] == 'Question' and saved['default_count'] == 5
    assert logged.get('/api/projects').json()[0]['name'] == 'General ecology'
    assert logged.post('/api/projects',json={'name':''}).status_code == 422


def test_settings_encrypted_not_leaked(logged,monkeypatch):
    monkeypatch.setattr('app.main.public_url',lambda x:x)
    data={'base_url':'https://example.com/v1','api_key':'PRIVATE-MODEL-KEY','text_model':'text','vision_model':'vision','openalex_key':'PRIVATE-ALEX-KEY'}
    assert logged.put('/api/settings',json=data).status_code==200
    view=logged.get('/api/settings').text
    assert 'PRIVATE-' not in view
    with session() as s:
        assert 'PRIVATE-' not in s.get(Setting,'provider').value
    data['api_key']='';data['openalex_key']=''
    assert logged.put('/api/settings',json=data).status_code==200
    assert logged.get('/api/settings').json()['has_api_key'] is True


def test_invalid_reference_rejected(logged):
    p=logged.post('/api/projects',json={'name':'Topic'}).json()
    r=logged.post(f'/api/projects/{p["id"]}/references',files={'file':('paper.pdf',b'not a pdf','application/pdf')})
    assert r.status_code==400


def test_batch_count_limits(logged):
    for n in [0,21,-1]:
        assert logged.post('/api/projects/unknown/jobs',json={'count':n}).status_code==422


def test_cors(logged):
    good=logged.options('/api/projects',headers={'Origin':'https://example.github.io','Access-Control-Request-Method':'GET'})
    assert good.headers.get('access-control-allow-origin')=='https://example.github.io'
    bad=logged.options('/api/projects',headers={'Origin':'https://evil.invalid','Access-Control-Request-Method':'GET'})
    assert 'access-control-allow-origin' not in bad.headers


def test_private_export(logged):
    project=logged.post('/api/projects',json={'name':'Export topic'}).json()
    a=analysis();a.update(artifact_dir='papers/export-test',verified=True,verification_status='Fixture only')
    folder=DATA/a['artifact_dir'];(folder/'assets').mkdir(parents=True,exist_ok=True)
    sm={'blocks':[{'id':'P0001-B0001','text':'Fixture text','page':1}]}
    write_artifacts(folder,metadata(),a,sm)
    # SQLite fixtures omit FK enforcement; production inserts a real job.
    register(project['id'],'fixture-job',metadata(),a)
    result=logged.get(f'/api/projects/{project["id"]}/export?kind=html')
    assert result.status_code==200
    with zipfile.ZipFile(io.BytesIO(result.content)) as z:
        assert 'index.html' in z.namelist()
        assert 'R001/reading-note.md' in z.namelist()
        assert 'R001/assets/research-flow.svg' in z.namelist()
        assert not any('paper.pdf' in x or '.env' in x for x in z.namelist())
        note=z.read('R001/reading-note.md').decode()
        assert note.count('分析采用 norman-paper-reading 技能')==1
    result=logged.get(f'/api/projects/{project["id"]}/export?kind=json')
    assert 'artifact_dir' not in result.text


def candidate_fixture(logged, status='unverified'):
    """Synthetic candidate artifacts only; no model or network requests."""
    project = logged.post('/api/projects', json={'name': 'Candidate fixture'}).json()
    candidate = dict(metadata(doi='10.1234/' + project['id']), status=status, reason='Original figure review incomplete')
    jid = 'job-' + project['id']
    with session() as s:
        s.add(Job(id=jid, project_id=project['id'], status='completed', requested=5, checkpoint=json.dumps({'scope_snapshot': project['scope'], 'candidates': [candidate], 'completed': [], 'shortfall': 5})))
    folder = candidate_folder(candidate, project['scope'])
    (folder / 'assets').mkdir(parents=True, exist_ok=True)
    return jid, folder


def test_candidate_partial_content_without_false_completion(logged):
    jid, folder = candidate_fixture(logged)
    draft = analysis()
    # Even a file produced before final structural validation cannot imply completion.
    draft.update(verified=True, artifact_dir='private/absolute/location')
    (folder / 'analysis.json').write_text(json.dumps(draft), 'utf-8')
    (folder / 'text-checkpoints.json').write_text(json.dumps([{'notes': 'Generated fixture notes', 'unread': [], 'visual_pages': [1, 2]}]), 'utf-8')
    observed = {'page': 99, 'label': 'Figure 1', 'kind': 'figure', 'explanation': 'Synthetic observation', 'limitations': 'Fixture only'}
    (folder / 'visual-checkpoints.json').write_text(json.dumps({'1': {'readable': True, 'items': [observed]}, '2': {'readable': False}, '3': {'readable': True, 'unread': ['Unclear equation']}}), 'utf-8')
    (folder / 'assets/page-1.png').write_bytes(b'synthetic-image')
    (folder / 'assets/page-2.png').write_bytes(b'synthetic-image')
    data = logged.get(f'/api/jobs/{jid}/candidates/0').json()
    assert data['analysis']['summary'] == draft['summary']
    assert data['analysis']['verified'] is False
    assert data['analysis']['provisional'] is True
    assert data['analysis']['verification_gaps'] == ['Original figure review incomplete']
    assert 'artifact_dir' not in data['analysis']
    assert data['reading_notes'][0]['notes'] == 'Generated fixture notes'
    assert data['artifacts']['image_pages'] == [1, 2]
    assert data['artifacts']['checked_visual_pages'] == [1]
    assert data['analysis']['visuals'] == [dict(observed, page=1)]
    assert logged.get(f'/api/jobs/{jid}/candidates/0/assets/page-1.png').content == b'synthetic-image'
    flow = logged.get(f'/api/jobs/{jid}/candidates/0/assets/research-flow.svg')
    assert flow.status_code == 200
    assert '分析者绘制' in flow.text
    assert 'sandbox' in flow.headers['Content-Security-Policy']
    assert logged.get('/api/papers/1').status_code == 404


def test_candidate_prefers_provisional_and_tolerates_incomplete_files(logged):
    jid, folder = candidate_fixture(logged)
    (folder / 'draft.json').write_text(json.dumps(analysis()), 'utf-8')
    partial = dict(analysis(), summary='New partial figure findings', verified=False)
    (folder / 'provisional.json').write_text(json.dumps(partial), 'utf-8')
    (folder / 'text-checkpoints.json').write_text('{not finished', 'utf-8')
    result = logged.get(f'/api/jobs/{jid}/candidates/0')
    assert result.status_code == 200
    assert result.json()['analysis']['summary'] == 'New partial figure findings'
    assert result.json()['reading_notes'] == []
    (folder / 'provisional.json').write_text('{not finished', 'utf-8')
    assert logged.get(f'/api/jobs/{jid}/candidates/0').json()['analysis']['summary'] == analysis()['summary']


def test_job_report_projection_exposes_real_draft_without_completing_or_persisting_it(logged):
    jid, folder = candidate_fixture(logged)
    stale = dict(analysis(), summary='Older draft report')
    partial = dict(analysis(), summary='Actual partial report', verified=True, artifact_dir='PRIVATE-ARTIFACT-PATH')
    (folder / 'draft.json').write_text(json.dumps(stale), 'utf-8')
    (folder / 'provisional.json').write_text(json.dumps(partial), 'utf-8')
    with session() as s:
        job = s.get(Job, jid)
        pid, original_checkpoint = job.project_id, job.checkpoint
    # Later scope edits cannot redirect a historical batch's report projection.
    logged.put(f'/api/projects/{pid}/scope', json={'research_question': 'Edited scope', 'keywords': ['new scope'], 'include': '', 'exclude': '', 'inferred': False})
    single = logged.get(f'/api/jobs/{jid}')
    listing = logged.get(f'/api/projects/{pid}/jobs')
    assert single.status_code == listing.status_code == 200
    for response, data in [(single, single.json()), (listing, listing.json()[0])]:
        candidate = data['checkpoint']['candidates'][0]
        assert candidate['analysis']['summary'] == 'Actual partial report'
        assert candidate['analysis']['verified'] is False
        assert candidate['analysis']['provisional'] is True
        assert candidate['status'] == 'unverified'
        assert data['checkpoint']['completed'] == []
        assert data['checkpoint']['shortfall'] == 5
        assert 'PRIVATE-ARTIFACT-PATH' not in response.text
        assert 'artifact_dir' not in candidate['analysis']
    with session() as s:
        assert s.get(Job, jid).checkpoint == original_checkpoint
    assert json.loads((folder / 'provisional.json').read_text('utf-8')) == partial
    assert logged.get(f'/api/projects/{pid}/papers').json() == []
    # A partially written file falls back to an earlier valid draft.
    (folder / 'provisional.json').write_text('{incomplete', 'utf-8')
    assert logged.get(f'/api/jobs/{jid}').json()['checkpoint']['candidates'][0]['analysis']['summary'] == 'Older draft report'


def test_job_report_projection_confines_cache_and_omits_missing_drafts(logged, monkeypatch, tmp_path):
    jid, _ = candidate_fixture(logged, status='no_fulltext')
    with session() as s:
        pid = s.get(Job, jid).project_id
    assert 'analysis' not in logged.get(f'/api/jobs/{jid}').json()['checkpoint']['candidates'][0]
    (tmp_path / 'provisional.json').write_text(json.dumps(dict(analysis(), summary='OUTSIDE-CACHE-CONTENT')), 'utf-8')
    monkeypatch.setattr('app.pipeline.candidate_folder', lambda *args: tmp_path)
    for path in [f'/api/jobs/{jid}', f'/api/projects/{pid}/jobs']:
        response = logged.get(path)
        assert response.status_code == 200
        assert 'OUTSIDE-CACHE-CONTENT' not in response.text
        data = response.json()[0] if isinstance(response.json(), list) else response.json()
        assert 'analysis' not in data['checkpoint']['candidates'][0]


def test_job_report_projection_uses_legacy_scope_and_skips_registered_candidates(logged):
    jid, folder = candidate_fixture(logged)
    (folder / 'draft.json').write_text(json.dumps(analysis()), 'utf-8')
    with session() as s:
        job = s.get(Job, jid)
        state = json.loads(job.checkpoint)
        state.pop('scope_snapshot')
        job.checkpoint = json.dumps(state)
    assert logged.get(f'/api/jobs/{jid}').json()['checkpoint']['candidates'][0]['analysis']['summary'] == analysis()['summary']
    with session() as s:
        job = s.get(Job, jid)
        state = json.loads(job.checkpoint)
        state['candidates'][0]['status'] = 'completed'
        state['candidates'][0]['paper_id'] = 'R001'
        job.checkpoint = json.dumps(state)
    assert 'analysis' not in logged.get(f'/api/jobs/{jid}').json()['checkpoint']['candidates'][0]


def test_candidate_source_and_pdf_are_explicit_and_confined(logged, monkeypatch, tmp_path):
    jid, folder = candidate_fixture(logged)
    assert logged.get(f'/api/jobs/{jid}/candidates/0/pdf').status_code == 404
    make_pdf(folder / 'paper.pdf')
    source = folder / 'source'
    source.mkdir()
    (source / 'source_map.json').write_text(json.dumps({'pdf_path': 'PRIVATE-LOCAL-PATH', 'blocks': [{'id': 'B1', 'page': 1, 'text': 'Fixture first page', 'path': 'PRIVATE-LOCAL-PATH'}, {'id': 'B2', 'page': 2, 'text': 'Fixture second page'}]}), 'utf-8')
    response = logged.get(f'/api/jobs/{jid}/candidates/0/source?page=2')
    assert response.json()['blocks'] == [{'id': 'B2', 'page': 2, 'text': 'Fixture second page'}]
    assert response.json()['pages'] == [1, 2]
    assert 'PRIVATE-LOCAL-PATH' not in logged.get(f'/api/jobs/{jid}/candidates/0/source').text
    assert logged.get(f'/api/jobs/{jid}/candidates/0/source?page=0').status_code == 400
    pdf = logged.get(f'/api/jobs/{jid}/candidates/0/pdf')
    assert pdf.content.startswith(b'%PDF-')
    assert pdf.headers['content-type'] == 'application/pdf'
    for suffix in ['assets/paper.pdf', 'assets/source-fingerprint.json', 'assets/page-0.png', 'assets/missing.png']:
        assert logged.get(f'/api/jobs/{jid}/candidates/0/{suffix}').status_code == 404
    assert logged.get(f'/api/jobs/{jid}/candidates/-1').status_code == 404
    assert logged.get(f'/api/jobs/{jid}/candidates/1').status_code == 404
    monkeypatch.setattr('app.pipeline.candidate_folder', lambda *args: tmp_path)
    assert logged.get(f'/api/jobs/{jid}/candidates/0').status_code == 404


def test_candidate_without_fulltext_stays_empty(logged):
    jid, _ = candidate_fixture(logged, status='no_fulltext')
    data = logged.get(f'/api/jobs/{jid}/candidates/0').json()
    assert data['analysis'] is None
    assert data['reading_notes'] == []
    assert data['artifacts'] == {'pdf_available': False, 'source_available': False, 'analysis_available': False, 'image_pages': [], 'checked_visual_pages': []}


def test_replacement_pdf_archives_provisional_analysis(logged):
    jid, folder = candidate_fixture(logged)
    make_pdf(folder / 'paper.pdf')
    old_partial = dict(analysis(), summary='Old source partial')
    (folder / 'provisional.json').write_text(json.dumps(old_partial), 'utf-8')
    replacement = (folder / 'paper.pdf').read_bytes() + b'\n% Revised generated fixture\n'
    result = logged.post(f'/api/jobs/{jid}/candidates/0/pdf', files={'file': ('replacement.pdf', replacement, 'application/pdf')})
    assert result.status_code == 200
    assert not (folder / 'provisional.json').exists()
    assert len(list(folder.glob('revision-*/provisional.json'))) == 1
    assert logged.get(f'/api/jobs/{jid}/candidates/0').json()['analysis'] is None
