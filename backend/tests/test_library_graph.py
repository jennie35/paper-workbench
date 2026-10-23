"""Synthetic bibliography and graph fixtures; no model/provider calls."""
import json

import pytest
from sqlalchemy import select

from app.db import session, ImportedCandidate, Job, Paper, Setting
from app.discovery import identity, same_paper, openalex_paper
from app.graph import build_graph
from app.imports import parse_import


def bibliography(title='颜色测量方法', year=2025, author='张三'):
    return {'title': title, 'authors': [author], 'year': year, 'journal': '合成测试期刊', 'doi': '', 'pdf_urls': [], 'versions': [], 'source': '软件测试资料'}


def test_cjk_identity_composite_and_unconfirmed_aliases():
    a = bibliography()
    assert identity(a) != identity(bibliography(year=2026))
    assert identity(a) != identity(bibliography(author='李四'))
    assert not same_paper(a, bibliography(year=2026))
    assert not same_paper(a, bibliography(author='李四'))
    english = dict(a, title='Color measurement', title_aliases=[a['title']])
    assert not same_paper(a, english)
    # NFKC punctuation can be safely normalized when authors/year/journal agree.
    assert same_paper(a, dict(a, title='颜色：测量方法'))
    assert not same_paper({'title': 'Same', 'authors': []}, {'title': 'Same', 'authors': []})


def test_browser_source_ids_survive_chinese_json_migration():
    first = dict(bibliography(), source_id='https://openalex.org/W123', external_ids={'openalex': 'https://openalex.org/W123'})
    other = dict(bibliography(title='An English title'), openalex_id='https://openalex.org/W123')
    migrated = parse_import(json.dumps([first]).encode(), 'library.json')[0]['metadata']
    assert migrated['source_ids']['openalex'] == first['source_id']
    assert same_paper(migrated, other)
    assert identity(migrated) == identity(other)
    preprint = dict(first, doi='10.5555/preprint')
    published = dict(other, doi='10.5555/published')
    assert same_paper(preprint, published), 'An exact Work ID preserves known version identity'
    assert not same_paper(dict(bibliography(), doi='10.5555/a'), dict(bibliography(), doi='10.5555/b'))


def test_import_pdf_replacement_preserves_old_bundle_and_invalidates_checkpoints(logged, tmp_path):
    from fixtures import make_pdf
    from app.pipeline import candidate_folder
    pid = logged.post('/api/projects', json={'name': '替换正文测试'}).json()['id']
    preview = logged.post(f'/api/projects/{pid}/imports/preview', files={'file': ('x.json', json.dumps([bibliography()]).encode(), 'application/json')}).json()
    result = logged.post(f'/api/projects/{pid}/imports/confirm', json={'preview_id': preview['preview_id'], 'selected': [preview['records'][0]['id']]}).json()
    cid = result['candidates'][0]
    path = tmp_path / 'paper.pdf'
    make_pdf(path)
    endpoint = f'/api/projects/{pid}/candidates/{cid}/source'
    assert logged.post(endpoint, files={'file': ('paper.pdf', path.read_bytes(), 'application/pdf')}).status_code == 200
    with session() as s:
        row = s.get(ImportedCandidate, cid)
        meta = json.loads(row.metadata_json)
    scope = logged.get(f'/api/projects/{pid}').json().get('scope', {})
    from app.db import Project
    with session() as s:
        scope = json.loads(s.get(Project, pid).scope)
    folder = candidate_folder(meta, scope)
    checkpoint = folder / 'source-fingerprint.json'
    checkpoint.write_text('{"sha256":"old"}', 'utf-8')
    # Identical upload preserves valid existing checkpoints.
    assert logged.post(endpoint, files={'file': ('paper.pdf', path.read_bytes(), 'application/pdf')}).status_code == 200
    assert checkpoint.exists()
    # A new PDF retains previous evidence but cannot accidentally reuse it.
    new_bytes = path.read_bytes() + b'\n% new source version\n'
    assert logged.post(endpoint, files={'file': ('paper.pdf', new_bytes, 'application/pdf')}).status_code == 200
    assert not checkpoint.exists()
    archives = list(folder.glob('revision-*'))
    assert len(archives) == 1 and (archives[0] / 'source-fingerprint.json').exists()
    assert (archives[0] / 'paper.pdf').read_bytes() == path.read_bytes()


def test_import_three_bibliography_formats():
    ris = 'TY  - JOUR\nTI  - 中文方法\nAU  - 张三\nPY  - 2025\nJO  - 测试期刊\nER  -\n'
    bib = '@article{zh2025,title={中文{方法}},author={张三 and 李四},year={2025},journal={测试期刊}}'
    xml = '<xml><records><record><titles><title><style>中文方法</style></title><secondary-title>测试期刊</secondary-title></titles><contributors><authors><author>张三</author></authors></contributors><dates><year>2025</year></dates></record></records></xml>'
    rows = [parse_import(t.encode('utf8'), 'x.' + suffix)[0]['metadata'] for t, suffix in ((ris, 'ris'), (bib, 'bib'), (xml, 'xml'))]
    assert all(r['title'] == '中文方法' and r['year'] == 2025 and not r['doi'] for r in rows)
    assert rows[1]['authors'] == ['张三', '李四']
    with pytest.raises(ValueError, match='DOCTYPE'):
        parse_import(b'<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///secret">]><xml/>', 'x.xml')


def test_simplified_traditional_is_review_hint_not_auto_merge():
    from app.language_tools import review_title_keys
    simplified, traditional = bibliography('颜色测量方法'), bibliography('顏色測量方法')
    assert review_title_keys(simplified) & review_title_keys(traditional)
    assert not same_paper(simplified, traditional)


def test_import_preview_confirm_and_no_quota(logged):
    pid = logged.post('/api/projects', json={'name': '中文测试课题'}).json()['id']
    text = 'TY  - JOUR\nTI  - 中文方法\nAU  - 张三\nPY  - 2025\nJO  - 测试期刊\nER  -\n'
    preview = logged.post(f'/api/projects/{pid}/imports/preview', files={'file': ('中文.ris', text.encode(), 'text/plain')})
    assert preview.status_code == 200, preview.text
    p = preview.json()
    assert p['records'][0]['metadata']['doi'] == '' and not p['records'][0]['duplicate']
    confirm = {'preview_id': p['preview_id'], 'selected': [p['records'][0]['id']]}
    first = logged.post(f'/api/projects/{pid}/imports/confirm', json=confirm)
    assert first.status_code == 200, first.text
    again = logged.post(f'/api/projects/{pid}/imports/confirm', json=confirm)
    assert again.status_code == 200
    with session() as s:
        assert len(s.scalars(select(ImportedCandidate)).all()) == 1
        assert s.get(Setting, 'ledger_counter').value == '0'
    cid = first.json()['candidates'][0]
    job = logged.post(f'/api/projects/{pid}/imports/analyze', json={'selected': [cid]})
    assert job.status_code == 200 and job.json()['status'] == 'waiting_sources'
    with session() as s:
        saved = s.get(Job, job.json()['job_id'])
        assert saved.requested == 0 and json.loads(saved.checkpoint)['import_analysis']


def test_json_migration_preserves_alias_and_downgrades_receipts(logged):
    pid = logged.post('/api/projects', json={'name': '迁移测试'}).json()['id']
    paper = dict(bibliography(), id='D007', analysis={'summary': '历史正文总结', 'verified': True,
        'api_key': 'not-a-real-key', 'artifact_dir': '/client/private', 'visuals': [{'inspection_status': 'verified'}]})
    p = logged.post(f'/api/projects/{pid}/imports/preview', files={'file': ('library.json', json.dumps({'papers': [paper]}).encode(), 'application/json')}).json()
    out = logged.post(f'/api/projects/{pid}/imports/confirm', json={'preview_id': p['preview_id'], 'selected': [p['records'][0]['id']]}).json()
    assert out['new_count'] == 0 and out['migrated'] == ['R001']
    saved = logged.get(f'/api/projects/{pid}/papers').json()[0]
    assert saved['legacy_ids'] == ['D007'] and saved['analysis']['summary'] == '历史正文总结'
    assert saved['analysis']['verified'] is False and saved['analysis']['visuals'] == []
    assert 'not-a-real-key' not in json.dumps(saved) and '/client/private' not in json.dumps(saved)
    repeat = logged.post(f'/api/projects/{pid}/imports/confirm', json={'preview_id': p['preview_id'], 'selected': [p['records'][0]['id']]}).json()
    assert repeat['linked'] == ['R001']


def test_graph_typed_relations_and_unknown_citations():
    a = dict(bibliography('A'), id='R001', openalex_id='https://openalex.org/W1', referenced_works=['https://openalex.org/W2', 'https://openalex.org/W9'])
    b = dict(bibliography('B'), id='R002', openalex_id='https://openalex.org/W2', referenced_works=['https://openalex.org/W9'])
    c = dict(bibliography('C'), id='R003', openalex_id='https://openalex.org/W3', referenced_works=['https://openalex.org/W1', 'https://openalex.org/W2'])
    direct = build_graph([a, b, c])
    assert all(e['directed'] and e['type'] == 'direct_citation' for e in direct['edges'])
    assert any(e['source'] == 'R001' and e['target'] == 'R002' for e in direct['edges'])
    assert direct['nodes'][0]['citation_count'] is None
    shared = build_graph([a, b, c], relation='shared_references')
    assert shared['edges'][0]['basis']['shared_reference_ids'] == ['W9']
    co = build_graph([a, b, c], relation='co_citation')
    assert co['edges'][0]['basis']['citing_paper_ids'] == ['R003']
    assert not co['edges'][0]['directed']
    from app.graph import render_snapshot_html
    document = render_snapshot_html(direct)
    assert '<svg' in document and 'R001/index.html' in document
    assert 'referenced_id' in document and '位置不表示相似距离' in document
    assert '<script' not in render_snapshot_html(build_graph([dict(a, title='<script>alert(1)</script>')]))


def test_semantic_graph_unavailable_does_not_fabricate_edges(monkeypatch):
    def unavailable(*_):
        raise ValueError('model unavailable')
    monkeypatch.setattr('app.embeddings.vectors', unavailable)
    graph = build_graph([dict(bibliography('甲'), id='R001'), dict(bibliography('乙'), id='R002')], view='semantic')
    assert not graph['availability']['available'] and graph['edges'] == []


def test_new_endpoints_auth_and_project_isolation(client, logged):
    pid = logged.post('/api/projects', json={'name': '隔离测试'}).json()['id']
    # Fixture objects share client; explicitly remove auth to exercise endpoint dependencies.
    client.headers.pop('Authorization', None)
    for endpoint in (f'/api/projects/{pid}/graph', f'/api/projects/{pid}/imports/candidates', '/api/papers/1/pdf'):
        assert client.get(endpoint).status_code == 401
    for endpoint in (f'/api/projects/{pid}/imports/confirm', f'/api/projects/{pid}/imports/analyze', f'/api/projects/{pid}/graph/expand'):
        assert client.post(endpoint, json={}).status_code == 401


def test_openalex_retains_cjk_metadata_without_doi():
    p = openalex_paper({'id': 'https://openalex.org/W123', 'display_name': '中文研究', 'publication_year': 2025,
        'ids': {'openalex': 'https://openalex.org/W123'}, 'language': 'zh', 'referenced_works': ['https://openalex.org/W2'],
        'content_urls': {'pdf': 'https://content.openalex.org/works/W123.pdf'}, 'cited_by_count': 8})
    assert p['title'] == '中文研究' and not p['doi'] and p['referenced_works'] and p['citation_count'] == 8
    assert identity(p) == 'source:openalex:https://openalex.org/w123'


def test_metered_download_budget_and_secret_scope(monkeypatch, tmp_path):
    from app.acquisition import acquire_pdf
    seen = []
    def download(url, path):
        seen.append(url)
        path.write_bytes(b'%PDF-synthetic-test')
    monkeypatch.setattr('app.acquisition.download', download)
    monkeypatch.setattr('app.acquisition.validate_download', lambda path: None)
    meta = dict(bibliography(), content_urls={'pdf': 'https://content.openalex.org/works/W123.pdf'})
    cfg = {'openalex_key': 'fake-secret-for-fixture', 'openalex_content_daily_limit': 1}
    result = acquire_pdf(meta, tmp_path / 'paper.pdf', cfg)
    assert result and 'fake-secret' not in json.dumps(result)
    assert len(seen) == 1 and acquire_pdf(meta, tmp_path / 'other.pdf', cfg) is None
    bad = dict(meta, content_urls={'pdf': 'https://other.example/works/W123.pdf'})
    assert acquire_pdf(bad, tmp_path / 'blocked.pdf', cfg) is None


def test_acquisition_skips_invalid_pdf_and_removes_failed_source(monkeypatch, tmp_path):
    from app.acquisition import acquire_pdf
    from fixtures import make_pdf
    good = tmp_path / 'fixture.pdf'
    make_pdf(good)
    def download(url, path):
        path.write_bytes(b'%PDF-damaged' if url.endswith('bad.pdf') else good.read_bytes())
    monkeypatch.setattr('app.acquisition.download', download)
    out = tmp_path / 'download.pdf'
    meta = dict(bibliography(), pdf_urls=['https://example.com/bad.pdf', 'https://example.com/good.pdf'])
    result = acquire_pdf(meta, out, {})
    assert result and result['url'].endswith('good.pdf') and out.is_file()
    assert acquire_pdf(dict(meta, pdf_urls=['https://example.com/bad.pdf']), out, {}) is None and not out.exists()


def test_paper_revision_upload_keeps_number_and_waits_for_confirmation(logged, monkeypatch, tmp_path):
    from fixtures import make_pdf
    from app.pipeline import candidate_folder
    from app.config import DATA
    pid = logged.post('/api/projects', json={'name': '补全文测试'}).json()['id']
    row = dict(bibliography(), id='D009', analysis={'summary': '旧摘要', 'verified': False})
    preview = logged.post(f'/api/projects/{pid}/imports/preview', files={'file': ('x.json', json.dumps([row]).encode(), 'application/json')}).json()
    logged.post(f'/api/projects/{pid}/imports/confirm', json={'preview_id': preview['preview_id'], 'selected': [preview['records'][0]['id']]})
    path = tmp_path / 'paper.pdf'
    make_pdf(path)
    called = []
    monkeypatch.setattr('app.main.enqueue', lambda jid: called.append(jid))
    response = logged.post('/api/papers/D009/source', files={'file': ('paper.pdf', path.read_bytes(), 'application/pdf')})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['paper_id'] == 'R001' and result['status'] == 'waiting_sources' and not called
    with session() as s:
        job = s.get(Job, result['job_id'])
        state = json.loads(job.checkpoint)
        assert job.requested == 0 and state['revision_number'] == 1
        assert (candidate_folder(state['candidates'][0], state['scope_snapshot']) / 'paper.pdf').is_file()
        assert s.get(Setting, 'ledger_counter').value == '1'
        assert json.loads(s.get(Paper, 1).analysis_json)['summary'] == '旧摘要'


def test_graph_export_contains_provenance_without_model_call(logged, monkeypatch):
    pid = logged.post('/api/projects', json={'name': '图谱导出测试'}).json()['id']
    row = dict(bibliography(), id='D001', referenced_works=['https://openalex.org/W123'],
               analysis={'summary': '历史报告', 'verified': False})
    p = logged.post(f'/api/projects/{pid}/imports/preview', files={'file': ('x.json', json.dumps([row]).encode(), 'application/json')}).json()
    logged.post(f'/api/projects/{pid}/imports/confirm', json={'preview_id': p['preview_id'], 'selected': [p['records'][0]['id']]})
    def forbidden(*_):
        raise AssertionError('export must not initialize embeddings')
    monkeypatch.setattr('app.embeddings.vectors', forbidden)
    output = logged.get(f'/api/projects/{pid}/export?kind=json')
    assert output.status_code == 200, output.text
    assert output.json()['graphs']['direct_citation']['nodes'][0]['id'] == 'R001'
    assert output.json()['papers'][0]['referenced_works'] == ['https://openalex.org/W123']
