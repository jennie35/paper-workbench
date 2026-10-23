import json
from pathlib import Path
import uuid

import pytest
from sqlalchemy import select

from app.config import DATA
from app.db import session, Project, Job, Paper, ProjectPaper
from app.discovery import doi, same_paper
from app.pipeline import register, validate_analysis, _run_job
from fixtures import metadata, analysis, make_pdf


def project_job(count=5):
    pid,jid=str(uuid.uuid4()),str(uuid.uuid4())
    with session() as s:
        s.add(Project(id=pid,name='Generic topic',goal='',scope=json.dumps({'keywords':['test'],'research_question':'Question'})))
        s.add(Job(id=jid,project_id=pid,requested=count))
    return pid,jid


def test_doi_and_version_deduplication():
    assert doi('https://doi.org/10.1234/ABC')=='10.1234/abc'
    a,b=metadata(),metadata(doi='10.1234/PREPRINT')
    b['versions']=['10.1234/example']
    assert same_paper(a,b)
    a['doi']='';b['doi']='';a['versions']=[];b['versions']=[]
    b['title']='TEST PAPER!'
    assert same_paper(a,b)


def test_atomic_numbering_excludes_existing_studies_from_another_project():
    pid,jid=project_job()
    a=analysis()
    assert register(pid,jid,metadata(),a)==(1,True)
    assert register(pid,jid,metadata(),a)==(1,False)
    pid2,jid2=project_job()
    assert register(pid2,jid2,metadata(),a)==(1,False)
    assert register(pid,jid,metadata('Second','10.1234/second'),a)==(2,True)
    with session() as s:
        assert len(s.scalars(select(Paper)).all())==2
        assert len(s.scalars(select(ProjectPaper)).all())==2
        assert not s.scalars(select(ProjectPaper).where(ProjectPaper.project_id == pid2)).all()


def test_hallucinated_source_ids_rejected():
    a=analysis()
    with pytest.raises(ValueError,match='正文来源块'):
        validate_analysis(a,{'blocks':[]},1)
    a['actions'][0]['evidence_ids']=['NONEXISTENT']
    with pytest.raises(ValueError,match='不存在的证据'):
        validate_analysis(a,{'blocks':[{'id':'P0001-B0001'}]},1)


def test_visual_page_out_of_range_rejected():
    a=analysis();a['required_visual_pages']=[3]
    with pytest.raises(ValueError,match='原图页码'):
        validate_analysis(a,{'blocks':[{'id':'P0001-B0001'}]},2)


class FakeProvider:
    config={}
    def preflight(self,image):
        pass
    def json(self,prompt,**kwargs):
        return {'ranked':[{'index':0,'relevant':True,'reason':'Directly related'}]}


class FakeSkill:
    def preflight(self):
        return {'available':True}


def test_no_fulltext_does_not_fill_quota(monkeypatch):
    pid,jid=project_job()
    monkeypatch.setattr('app.pipeline.search',lambda *args:([metadata()],[]))
    monkeypatch.setattr('app.pipeline.challenge_image',lambda path:None)
    monkeypatch.setattr('app.acquisition.landing_pdf_urls', lambda meta: [])
    _run_job(jid,provider=FakeProvider(),skill=FakeSkill())
    with session() as s:
        j=s.get(Job,jid);state=json.loads(j.checkpoint)
        assert j.status=='waiting_sources' and j.stage=='等待资料'
        assert state['actual']==0 and state['shortfall']==5
        assert state['candidates'][0]['status']=='no_fulltext'
        assert len(s.scalars(select(Paper)).all())==0


def test_cancel_preserves_checkpoint(monkeypatch):
    _,jid=project_job()
    with session() as s:
        j=s.get(Job,jid);j.cancel=True;j.checkpoint=json.dumps({'completed':[],'audit':'keep'})
    _run_job(jid,provider=FakeProvider(),skill=FakeSkill())
    with session() as s:
        j=s.get(Job,jid)
        assert j.status=='cancelled'
        assert json.loads(j.checkpoint)['audit']=='keep'


def test_missing_skill_fails_honestly(monkeypatch):
    _,jid=project_job()
    class MissingSkill:
        def preflight(self):
            raise ValueError('外部 Norman 技能缺失')
    _run_job(jid,provider=FakeProvider(),skill=MissingSkill())
    with session() as s:
        j=s.get(Job,jid)
        assert j.status=='failed'
        assert '缺失' in j.error


def test_model_preflight_failure_has_own_stage_without_search(monkeypatch):
    _, jid = project_job()
    class OfflineProvider(FakeProvider):
        def preflight(self, image):
            raise ValueError('模型 API 连接超时')
    monkeypatch.setattr('app.pipeline.challenge_image', lambda path: None)
    def unexpected_search(*args):
        pytest.fail('Search must not run after failed model preflight')
    monkeypatch.setattr('app.pipeline.search', unexpected_search)
    _run_job(jid, provider=OfflineProvider(), skill=FakeSkill())
    with session() as s:
        j = s.get(Job, jid)
        assert j.status == 'failed' and j.stage == '接口预检'
        assert json.loads(j.checkpoint)['candidates'] == []


def test_failed_visual_analysis_never_registers(monkeypatch):
    pid,jid=project_job()
    p=metadata();p['pdf_urls']=['https://example.com/paper.pdf']
    monkeypatch.setattr('app.pipeline.search',lambda *args:([p],[]))
    monkeypatch.setattr('app.pipeline.challenge_image',lambda path:None)
    monkeypatch.setattr('app.pipeline.acquire_pdf',lambda meta,path,cfg: (path.write_bytes(b'%PDF-fixture') and {'url': 'https://example.com/paper.pdf'}))
    monkeypatch.setattr('app.pipeline.inspect_pdf',lambda path:['Fixture'])
    def fail(*args):
        raise ValueError('图表未能可靠核验')
    monkeypatch.setattr('app.pipeline.analyze',fail)
    _run_job(jid,provider=FakeProvider(),skill=FakeSkill())
    with session() as s:
        state=json.loads(s.get(Job,jid).checkpoint)
        assert state['actual']==0 and state['pending_verification']==1
        assert len(s.scalars(select(Paper)).all())==0


def test_success_and_retry_do_not_duplicate(monkeypatch):
    pid,jid=project_job(1)
    p=metadata('Unique complete paper','10.1234/complete');p['pdf_urls']=['https://example.com/paper.pdf']
    monkeypatch.setattr('app.pipeline.search',lambda *args:([p],[]))
    monkeypatch.setattr('app.pipeline.challenge_image',lambda path:None)
    monkeypatch.setattr('app.pipeline.acquire_pdf',lambda meta,path,cfg: (path.write_bytes(b'%PDF-fixture') and {'url': 'https://example.com/paper.pdf'}))
    monkeypatch.setattr('app.pipeline.inspect_pdf',lambda path:['Fixture'])
    monkeypatch.setattr('app.pipeline.analyze',lambda *args:dict(analysis(),verified=True))
    _run_job(jid,provider=FakeProvider(),skill=FakeSkill())
    _run_job(jid,provider=FakeProvider(),skill=FakeSkill())
    with session() as s:
        assert json.loads(s.get(Job,jid).checkpoint)['actual']==1
        assert len(s.scalars(select(Paper)).all())==1


def test_cross_project_versions_are_skipped_and_expanded_search_fills_new_quota(monkeypatch):
    first_pid, first_jid = project_job(1)
    register(first_pid, first_jid, metadata('An existing study', '10.1234/existing'), analysis())
    pid, jid = project_job(2)
    old = metadata('A differently named published version', '10.1234/formal')
    old['versions'] = ['https://doi.org/10.1234/EXISTING']
    fresh = [metadata('New study A', '10.1234/new-a'), metadata('New study B', '10.1234/new-b')]
    for paper in fresh:
        paper['pdf_urls'] = ['https://example.com/paper.pdf']
    searches, ranked_titles, analyzed = [], [], []
    def search(*args):
        searches.append(args[1])
        return ([old] if len(searches) == 1 else [old, *fresh]), []
    class AllRelevant(FakeProvider):
        def json(self, prompt, **kwargs):
            if '题录：' in prompt:
                records = json.loads(prompt.split('题录：', 1)[1])
                ranked_titles.extend(record['title'] for record in records)
                return {'ranked': [{'index': i, 'relevant': True, 'relevance': 3, 'reason': 'Directly related'} for i in range(len(records))]}
            return {}
    def analyze(_provider, _skill, paper, *_args):
        analyzed.append(paper['doi'])
        return dict(analysis(), verified=True)
    monkeypatch.setattr('app.pipeline.search', search)
    monkeypatch.setattr('app.pipeline.challenge_image', lambda path: None)
    monkeypatch.setattr('app.pipeline.acquire_pdf', lambda meta, path, cfg: (path.write_bytes(b'%PDF-fixture') and {'url': 'https://example.com/paper.pdf'}))
    monkeypatch.setattr('app.pipeline.inspect_pdf', lambda path: ['Fixture'])
    monkeypatch.setattr('app.pipeline.analyze', analyze)
    _run_job(jid, provider=AllRelevant(), skill=FakeSkill())
    _run_job(jid, provider=AllRelevant(), skill=FakeSkill())
    with session() as s:
        state = json.loads(s.get(Job, jid).checkpoint)
        assert state['actual'] == 2 and state['shortfall'] == 0
        assert state['reused'] == []
        assert state['completed'] == ['R002', 'R003']
        assert {link.paper_number for link in s.scalars(select(ProjectPaper).where(ProjectPaper.project_id == pid))} == {2, 3}
        assert len(s.scalars(select(Paper)).all()) == 3
    assert len(searches) == 2
    assert old['title'] not in ranked_titles
    assert analyzed == ['10.1234/new-a', '10.1234/new-b']


@pytest.mark.parametrize('omit_reconciled_logic', [False, True])
def test_analysis_pipeline_inspects_and_reconciles_originals(omit_reconciled_logic):
    from app.pipeline import analyze
    from app.artifacts import challenge_image
    folder=DATA/'papers'/('end-to-end-fixture-' + str(omit_reconciled_logic));folder.mkdir(parents=True,exist_ok=True)
    make_pdf(folder/'paper.pdf')
    class LocalSkill:
        def instructions(self):
            return 'Fixture skill. Preserve evidence boundaries.'
        def operation(self,op,folder,pages=None):
            if op=='extract':
                (folder/'source').mkdir(exist_ok=True)
                (folder/'source/source_map.json').write_text(json.dumps({'source':{},'blocks':[{'id':'P0001-B0001','page':1,'text':'Synthetic test paper.', 'section':'methods'}]}),'utf-8')
            elif op=='render':
                image=challenge_image(folder/'assets')
                # Native renderer emits exactly one page PNG; remove probe source for clarity.
                image.rename(folder/'assets/native-page.png')
            elif op=='validate':
                assert (folder/'reading-note.md').exists()
                assert (folder/'evidence.json').exists()
    class Model:
        reconciled=False
        def json(self,prompt,images=None,**kwargs):
            if '核对下载正文' in prompt:
                return {'matches':True,'reason':'Fixture matches','version':'fixture'}
            if '阅读本组所有正文块' in prompt:
                return {'notes':'Fixture statements P0001-B0001','visual_pages':[1],'unread':[]}
            if images:
                assert images[0].exists()
                return {'readable':True,'items':[{'page':1,'label':'Fixture Figure 1','kind':'figure','explanation':'Synthetic visual fixture','limitations':'Not scientific evidence'}],'unread':[]}
            a=analysis();a['required_visual_pages']=[1]
            if '修正此前文本分析' in prompt:
                self.reconciled=True;a['summary']='Reconciled after actual image request'
                if omit_reconciled_logic:
                    a.pop('research_logic', None)
            return a
    model=Model();stages=[]
    if omit_reconciled_logic:
        with pytest.raises(ValueError, match='原图复核后的分析缺少课题研究逻辑'):
            analyze(model,LocalSkill(),metadata(),{'question':'Fixture'},folder,stages.append)
        partial=json.loads((folder/'provisional.json').read_text('utf-8'))
        assert partial['verified'] is False
        assert not (folder/'analysis.json').exists()
        return
    result=analyze(model,LocalSkill(),metadata(),{'question':'Fixture'},folder,stages.append)
    assert model.reconciled
    assert result['verified'] is True
    assert result['coverage']['visual_pages_checked']==[1]
    assert result['structural_validation']=='builtin_passed'
    assert (folder/'assets/page-1.png').exists()
    assert '图表核验' in stages and '校验' in stages


def test_empty_actions_need_explicit_reason():
    a=analysis();a['actions']=[]
    with pytest.raises(ValueError,match='没有可行行动'):
        validate_analysis(a,{'blocks':[{'id':'P0001-B0001'}]},1)
    a['action_status']='Evidence too limited; acquire source first.'
    validate_analysis(a,{'blocks':[{'id':'P0001-B0001'}]},1)


def test_scope_change_invalidates_cached_draft():
    from app.pipeline import candidate_folder
    assert candidate_folder(metadata(),{'question':'A'})!=candidate_folder(metadata(),{'question':'B'})


def test_recovery_after_commit_before_checkpoint(monkeypatch):
    pid,jid=project_job(1)
    p=metadata('Commit recovery fixture','10.1234/recovery')
    register(pid,jid,p,dict(analysis(), project_context={'project_id': pid}))
    with session() as s:
        j=s.get(Job,jid)
        j.checkpoint=json.dumps({'candidates':[dict(p,status='pending',relevant=True)],'search_windows':[__import__('datetime').date.today().year-1]})
    monkeypatch.setattr('app.pipeline.challenge_image',lambda path:None)
    _run_job(jid,provider=FakeProvider(),skill=FakeSkill())
    with session() as s:
        state=json.loads(s.get(Job,jid).checkpoint)
        assert state['actual']==1 and state['shortfall']==0
        assert len(s.scalars(select(Paper)).all())==1


@pytest.mark.parametrize('provenance', ['checkpoint', 'transfer_notice', 'link_context', 'canonical_context'])
@pytest.mark.parametrize('polluted_completed', [False, True])
def test_legacy_cross_project_links_cannot_be_recovered_as_new_papers(monkeypatch, provenance, polluted_completed):
    original_pid, original_jid = project_job(1)
    old = metadata('Previously analyzed study', '10.1234/legacy-associated')
    original_analysis = analysis()
    if provenance == 'canonical_context':
        original_analysis['project_context'] = {'project_id': original_pid}
    register(original_pid, original_jid, old, original_analysis)
    pid, jid = project_job(1)
    transferred = dict(analysis())
    if provenance == 'transfer_notice':
        transferred['transfer_notice'] = '复用既有分析；当前课题适用性尚待重新评估'
    if provenance == 'link_context':
        transferred['project_context'] = {'project_id': original_pid}
    with session() as s:
        # Reproduce the exact older storage shape: a foreign report is linked
        # with the current job ID, so checking job_id alone is insufficient.
        s.add(ProjectPaper(id=str(uuid.uuid4()), project_id=pid, paper_number=1, job_id=jid, analysis_json=json.dumps(transferred)))
        j = s.get(Job, jid)
        j.status = 'failed'
        j.checkpoint = json.dumps({
            'candidates': [dict(old, status='completed' if polluted_completed else 'pending', relevant=True, **({'paper_id': 'R001'} if polluted_completed else {}))],
            'completed': ['R001'] if polluted_completed else [],
            'reused': ['R001'] if provenance == 'checkpoint' else [],
        })
    fresh = metadata('Actually new study', '10.1234/actually-new')
    fresh['pdf_urls'] = ['https://example.com/paper.pdf']
    analyzed = []
    def analyze(_provider, _skill, paper, *_args):
        analyzed.append(paper['doi'])
        return dict(analysis(), verified=True, project_context={'project_id': pid})
    monkeypatch.setattr('app.pipeline.search', lambda *args: ([old, fresh], []))
    monkeypatch.setattr('app.pipeline.challenge_image', lambda path: None)
    monkeypatch.setattr('app.pipeline.acquire_pdf', lambda meta, path, cfg: (path.write_bytes(b'%PDF-fixture') and {'url': 'https://example.com/paper.pdf'}))
    monkeypatch.setattr('app.pipeline.inspect_pdf', lambda path: ['Fixture'])
    monkeypatch.setattr('app.pipeline.analyze', analyze)
    _run_job(jid, provider=FakeProvider(), skill=FakeSkill())
    _run_job(jid, provider=FakeProvider(), skill=FakeSkill())
    with session() as s:
        state = json.loads(s.get(Job, jid).checkpoint)
        assert state['actual'] == 1 and state['completed'] == ['R002']
        assert state['reused'] == ['R001']
        assert state['candidates'][0]['status'] == 'duplicate'
        assert state['candidates'][0].get('paper_id') is None
        assert len(s.scalars(select(Paper)).all()) == 2
        assert len(s.scalars(select(ProjectPaper).where(ProjectPaper.project_id == pid)).all()) == 2
    assert analyzed == [fresh['doi']]


def test_changed_pdf_cannot_reuse_old_source_mapping():
    from app.pipeline import analyze
    folder=DATA/'papers'/'changed-source-fixture';folder.mkdir(parents=True,exist_ok=True)
    make_pdf(folder/'paper.pdf')
    (folder/'source-fingerprint.json').write_text(json.dumps({'sha256':'old-source-fingerprint'}),'utf-8')
    with pytest.raises(ValueError,match='正文指纹改变'):
        analyze(None,None,metadata(),{},folder,lambda stage:None)
