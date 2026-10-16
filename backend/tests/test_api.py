import io
import json
import os
import zipfile

from app.db import session, Setting, Paper, ProjectPaper
from app.pipeline import register
from app.config import DATA
from app.artifacts import write_artifacts
from fixtures import metadata, analysis


def test_auth_required(client):
    assert client.get('/health').status_code == 200
    for path in ['/api/projects','/api/settings','/api/jobs/private','/api/papers/1','/api/papers/1/assets/page-1.png']:
        assert client.get(path).status_code == 401


def test_login_limits(client):
    for _ in range(10):
        assert client.post('/api/login',json={'password':'wrong'}).status_code == 401
    assert client.post('/api/login',json={'password':'wrong'}).status_code == 429


def test_project_scope_validation(logged):
    p = logged.post('/api/projects',json={'name':'General ecology','goal':'Independent project'}).json()
    assert p['scope']['inferred'] is True
    scope = {'research_question':'Question','keywords':['ecology'],'include':'Field studies','exclude':'Unrelated','inferred':False}
    assert logged.put(f'/api/projects/{p["id"]}/scope',json=scope).json()['scope'] == scope
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

