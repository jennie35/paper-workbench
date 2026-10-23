"""Fixed synthetic metadata/PDFs only; no paid API or live scholarly traffic."""
import datetime as dt
import json
import socket

import httpx
import pytest

from app.discovery import search
from app.pipeline import rank_candidates, candidate_priority, _run_job
from app.search_planning import fallback_queries, plan_queries, metadata_pool
from app.db import Job, Paper, session
from test_pipeline import project_job, FakeProvider, FakeSkill
from fixtures import metadata, analysis


def test_fallback_does_not_conjoin_all_synonyms_or_require_resources():
    result = fallback_queries({'keywords': ['彩色三维打印', '颜色测量', '色差', '纹理', '质量评价']})
    assert len(result) == 2
    assert all(len(x['query'].split()) == 2 for x in result)
    assert result[0]['query'] == '彩色三维打印 颜色测量'
    assert fallback_queries({}, '课题名称')[0]['query'] == '课题名称'


def test_model_planner_is_bounded_and_only_receives_search_scope():
    class Model:
        def json(self, prompt):
            assert '/private/data' not in prompt and 'SECRET-DIRECTORY' not in prompt
            return {'queries': [{'query': q, 'intent': '实际问题'} for q in ['中文 测量', 'color measurement', 'https://untrusted.example/x', 'color measurement', '图像 测量', '第五条'] ]}
    result = plan_queries(Model(), {'keywords': ['测量'], 'storage_root': '/private/data', 'known_resources': 'SECRET-DIRECTORY'})
    assert result['version'] == 2 and result['origin'] == 'configured_text_model'
    assert [x['query'] for x in result['queries']] == ['中文 测量', 'color measurement']
    assert plan_queries(FakeProvider(), {'keywords': ['test']})['origin'] == 'fallback'


def test_actual_metadata_ranked_in_small_batches_with_no_resource_gate():
    class Model:
        batches = []
        def json(self, prompt):
            assert 'PRIVATE-EQUIPMENT' not in prompt
            rows = json.loads(prompt.split('题录：', 1)[1])
            self.batches.append(rows)
            return {'ranked': [{'index': i, 'relevant': True, 'relevance': 3 if i else 1, 'reason': 'Actual fixture source'} for i in range(len(rows))]}
    model = Model()
    rows = [metadata('合成方法' + str(i), '') for i in range(52)]
    ranked = rank_candidates(model, {'core_question': '测量', 'known_resources': 'PRIVATE-EQUIPMENT'}, rows)
    assert [len(x) for x in model.batches] == [25, 25, 2]
    assert len(ranked) == 52 and sum(x['relevant'] for x in ranked) == 49
    available = dict(ranked[0], pdf_urls=['https://example.com/p.pdf'], year=2022)
    newer = dict(ranked[0], pdf_urls=[], year=2026)
    assert candidate_priority(available) < candidate_priority(newer)


def test_bounded_pool_keeps_both_sources_and_chinese_title_only_records():
    english = [dict(metadata('English fixture ' + str(i)), source='OpenAlex', pdf_urls=['https://example.com/' + str(i) + '.pdf']) for i in range(40)]
    chinese = [dict(metadata('中文方法' + str(i), ''), source='Crossref') for i in range(40)]
    chosen = metadata_pool([*english, *chinese], 30)
    assert len(chosen) == 30
    assert sum(x['source'] == 'Crossref' for x in chosen) == 15
    assert len(english) == len(chinese) == 40, 'The pool must not mutate source results'


def test_anonymous_openalex_is_searched_and_abstract_survives_crossref_merge(monkeypatch):
    observed = []
    original_client = httpx.Client
    def transport(request):
        observed.append(request)
        assert not request.headers.get('Authorization')
        if request.url.host == 'api.crossref.org':
            return httpx.Response(200, json={'message': {'items': [{'title': ['Synthetic Chinese measurement'], 'DOI': '10.5555/synthetic', 'type': 'journal-article', 'container-title': ['Fixture Journal'], 'published': {'date-parts': [[2025]]}}]}})
        return httpx.Response(200, json={'results': [{'id': 'https://openalex.org/W123', 'title': 'Synthetic Chinese measurement', 'doi': 'https://doi.org/10.5555/synthetic',
            'abstract_inverted_index': {'Actual': [0], 'abstract': [1]}, 'best_oa_location': {'is_oa': True, 'is_published': True, 'pdf_url': 'https://example.com/real-link.pdf', 'landing_page_url': 'https://example.com/article'},
            'publication_year': 2025}]})
    monkeypatch.setattr('app.discovery.httpx.Client', lambda **kwargs: original_client(transport=httpx.MockTransport(transport), **kwargs))
    rows, errors = search('measurement', 2025, {})
    assert not errors and len(observed) == 2 and len(rows) == 1
    assert rows[0]['abstract'] == 'Actual abstract'
    assert rows[0]['pdf_urls'] == ['https://example.com/real-link.pdf']
    assert rows[0]['landing_urls'] == ['https://example.com/article']
    assert rows[0]['publication_status'] == 'published'


def test_source_error_cannot_leak_configured_key_and_other_source_still_works(monkeypatch):
    original_client = httpx.Client
    def transport(request):
        if request.url.host == 'api.openalex.org':
            assert request.headers['Authorization'] == 'Bearer synthetic-secret'
            return httpx.Response(429, json={'error': 'synthetic-secret echoed by remote'})
        assert not request.headers.get('Authorization')
        return httpx.Response(200, json={'message': {'items': [{'title': ['Actual source fixture'], 'DOI': '10.5555/fixed'}]}})
    monkeypatch.setattr('app.discovery.httpx.Client', lambda **kwargs: original_client(transport=httpx.MockTransport(transport), **kwargs))
    rows, errors = search('fixed', 2025, {'openalex_key': 'synthetic-secret', 'api_key': 'never-forward-this'})
    assert len(rows) == 1 and errors
    assert 'synthetic-secret' not in json.dumps(errors)
    assert '429' not in json.dumps(errors), 'diagnostic uses fixed category, not raw provider text'


def test_landing_page_pdf_metadata_beats_unrelated_reference_links(monkeypatch, tmp_path):
    from app.acquisition import acquire_pdf
    from fixtures import make_pdf
    source = tmp_path / 'fixture.pdf'
    make_pdf(source)
    html = '<meta name="citation_pdf_url" content="/fulltext/own.pdf"><a href="https://other.example/reference.pdf">ref</a>'
    monkeypatch.setattr('app.acquisition.read_landing_page', lambda url: ('https://publisher.example/article/1', html))
    requested = []
    def download(url, path):
        requested.append(url)
        path.write_bytes(source.read_bytes())
    monkeypatch.setattr('app.acquisition.download', download)
    paper = metadata()
    paper['url'] = 'https://publisher.example/article/1'
    result = acquire_pdf(paper, tmp_path / 'paper.pdf', {})
    assert requested == ['https://publisher.example/fulltext/own.pdf']
    assert result['source'] == '期刊或机构公开网页中列出的全文'


def test_landing_page_rejects_private_host_and_streams_with_byte_limit(monkeypatch):
    from app.acquisition import read_landing_page
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *_a, **_k: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))])
    with pytest.raises(ValueError, match='内部地址'):
        read_landing_page('https://publisher.example/article')
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *_a, **_k: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))])
    original_client = httpx.Client
    def transport(request):
        return httpx.Response(200, content=b'a' * (1024 * 1024 + 1), headers={'content-type': 'text/html'})
    monkeypatch.setattr('app.acquisition.httpx.Client', lambda **kwargs: original_client(transport=httpx.MockTransport(transport), **kwargs))
    with pytest.raises(ValueError, match='读取预算'):
        read_landing_page('https://publisher.example/article')


def test_old_zero_report_checkpoint_replans_and_stops_at_requested_new_reports(monkeypatch):
    pid, jid = project_job(1)
    old = metadata('Old unusable query result', '10.5555/old')
    with session() as db:
        job = db.get(Job, jid)
        job.checkpoint = json.dumps({'candidates': [dict(old, status='no_fulltext')],
            'search_windows': [dt.date.today().year - 1, dt.date.today().year - 4, 1900]})
    fresh = [dict(metadata('Actual fixture ' + str(i), '10.5555/new' + str(i)), pdf_urls=['https://example.com/' + str(i) + '.pdf']) for i in range(3)]
    class Model(FakeProvider):
        def json(self, prompt, **kwargs):
            if '检索规划：' in prompt:
                return {'queries': [{'query': 'actual measurement', 'language': 'en', 'intent': 'topic problem'}]}
            records = json.loads(prompt.split('题录：', 1)[1])
            return {'ranked': [{'index': i, 'relevant': True, 'relevance': 3, 'reason': 'Direct actual fixture'} for i in range(len(records))]}
    searches, reads = [], []
    def real_search(*args):
        searches.append(args[0])
        return fresh, []
    monkeypatch.setattr('app.pipeline.search', real_search)
    monkeypatch.setattr('app.pipeline.challenge_image', lambda path: None)
    monkeypatch.setattr('app.pipeline.acquire_pdf', lambda meta, path, cfg: path.write_bytes(b'%PDF-synthetic-fixture') and {'url': meta['pdf_urls'][0]})
    monkeypatch.setattr('app.pipeline.analyze', lambda _p, _s, meta, *_a: reads.append(meta['title']) or dict(analysis(), verified=True))
    monkeypatch.setattr('app.pipeline.build_synthesis', lambda *_a: pytest.fail('A per-paper batch must not automatically synthesize'))
    _run_job(jid, provider=Model(), skill=FakeSkill())
    with session() as db:
        job = db.get(Job, jid)
        state = json.loads(job.checkpoint)
        assert job.status == 'completed' and state['actual'] == 1 and len(state['completed']) == 1
        assert state['search_plan']['version'] == 2
        assert state['search_diagnosis']['resources_are_optional']
        assert len(db.query(Paper).all()) == 1
    assert len(searches) == len(reads) == 1
