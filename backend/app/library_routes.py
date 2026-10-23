"""Authenticated library import, source revision and graph endpoints."""
import datetime as dt
import hashlib
import json
import re
import uuid

import httpx
from fastapi import Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select

from .config import DATA
from .db import ImportedCandidate, ImportPreview, Job, Paper, ProjectPaper, Setting, now, session
from .discovery import doi, identity, openalex_paper, same_paper
from .exporting import clean_export
from .graph import build_graph, aliases, reference_key
from .imports import parse_import
from .language_tools import review_title_keys


def corpus_fingerprint(records):
    return hashlib.sha256(json.dumps([{k: r.get(k) for k in ('id', 'title', 'title_en', 'abstract', 'referenced_works', 'citation_count', 'year')} for r in records], sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def saved_graph_bundle(pid, records):
    """Export saved bibliographic evidence; never download an embedding model."""
    result = {relation: build_graph(records, 'citation', relation, min(200, max(1, len(records))))
              for relation in ('direct_citation', 'shared_references', 'co_citation')}
    with session() as s:
        cached = s.get(Setting, 'graph_semantic:' + pid)
        if cached:
            payload = json.loads(cached.value)
            if payload.get('corpus_sha256') == corpus_fingerprint(records):
                result['semantic_similarity'] = payload
    return result


def install_library_routes(app, auth, get_project, papers_for, save_upload, enqueue, admission_lock, configuration):
    def candidates(pid):
        with session() as s:
            get_project(s, pid)
            return [dict(json.loads(x.metadata_json), id='candidate:' + x.id, candidate=True, status=x.status)
                    for x in s.scalars(select(ImportedCandidate).where(ImportedCandidate.project_id == pid, ImportedCandidate.status == 'pending')).all()]

    @app.get('/api/projects/{pid}/imports/candidates', dependencies=[Depends(auth)])
    def list_import_candidates(pid: str):
        return candidates(pid)

    @app.post('/api/projects/{pid}/imports/preview', dependencies=[Depends(auth)])
    async def import_preview(pid: str, file: UploadFile = File(...)):
        with session() as s:
            get_project(s, pid)
        try:
            data = await file.read(10 * 1024 * 1024 + 1)
            if len(data) > 10 * 1024 * 1024:
                raise HTTPException(413, '题录文件超过 10 MB')
            rows = parse_import(data, file.filename or '')
        finally:
            await file.close()
        preview_id = str(uuid.uuid4())
        with session() as s:
            get_project(s, pid)
            ledger = [(p.number, json.loads(p.metadata_json)) for p in s.scalars(select(Paper)).all()]
            pending = [(x.id, json.loads(x.metadata_json)) for x in s.scalars(select(ImportedCandidate).where(ImportedCandidate.project_id == pid)).all()]
            for row in rows:
                existing = next((n for n, p in ledger if same_paper(p, row['metadata'])), None)
                pending_id = next((n for n, p in pending if same_paper(p, row['metadata'])), None)
                row.update(duplicate=existing is not None or pending_id is not None or bool(row['duplicate_in_file']),
                           paper_id=f'R{existing:03d}' if existing is not None else None,
                           candidate_id=pending_id, migration=bool(row.get('analysis')))
                row['possible_duplicates'] = [f'R{n:03d}' for n, meta in ledger
                    if not same_paper(meta, row['metadata']) and review_title_keys(meta) & review_title_keys(row['metadata'])]
                if row['possible_duplicates']:
                    row['warnings'].append('题名、简繁或别名可能对应已有论文，请人工确认；不会自动合并：' + '、'.join(row['possible_duplicates']))
            s.add(ImportPreview(id=preview_id, project_id=pid, records_json=json.dumps(rows, ensure_ascii=False)))
        return {'preview_id': preview_id, 'records': [{k: v for k, v in r.items() if k != 'analysis'} for r in rows],
                'warnings': ['导入题录及迁入历史报告不计入本批新增；历史核验状态不会自动升级。']}

    @app.post('/api/projects/{pid}/imports/confirm', dependencies=[Depends(auth)])
    def confirm_import(pid: str, payload: dict):
        selected = payload.get('selected')
        if not isinstance(selected, list) or not all(isinstance(x, str) for x in selected) or len(selected) > 1000:
            raise ValueError('请选择预览中的题录编号')
        with admission_lock, session() as s:
            counter = s.execute(select(Setting).where(Setting.key == 'ledger_counter').with_for_update()).scalar_one()
            get_project(s, pid)
            preview = s.get(ImportPreview, str(payload.get('preview_id', '')))
            if not preview or preview.project_id != pid:
                raise HTTPException(404, '导入预览不存在')
            if dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(preview.created_at) > dt.timedelta(days=1):
                raise HTTPException(409, '预览已超过24小时，请重新预览题录')
            rows = [r for r in json.loads(preview.records_json) if r['id'] in set(selected)]
            if len({r['id'] for r in rows}) != len(set(selected)):
                raise ValueError('所选题录不属于此预览')
            ledger = s.scalars(select(Paper)).all()
            pending = s.scalars(select(ImportedCandidate).where(ImportedCandidate.project_id == pid)).all()
            added, linked, migrated = [], [], []
            migration_job = None
            for row in rows:
                meta = dict(row['metadata'])
                if row.get('legacy_id'):
                    meta['legacy_ids'] = list(dict.fromkeys([*meta.get('legacy_ids', []), row['legacy_id']]))
                meta['imported_at'] = now()
                existing = next((p for p in ledger if same_paper(json.loads(p.metadata_json), meta)), None)
                if existing:
                    saved_metadata = json.loads(existing.metadata_json)
                    if row.get('legacy_id'):
                        saved_metadata['legacy_ids'] = list(dict.fromkeys([*saved_metadata.get('legacy_ids', []), row['legacy_id']]))
                        existing.metadata_json = json.dumps(saved_metadata, ensure_ascii=False)
                    link = s.scalar(select(ProjectPaper).where(ProjectPaper.project_id == pid, ProjectPaper.paper_number == existing.number))
                    if not link:
                        if not migration_job:
                            migration_job = Job(id=str(uuid.uuid4()), project_id=pid, requested=0, status='completed', stage='历史迁入', checkpoint=json.dumps({'trigger_source': 'import', 'actual': 0, 'imported': True}))
                            s.add(migration_job)
                            s.flush()
                        s.add(ProjectPaper(id=str(uuid.uuid4()), project_id=pid, paper_number=existing.number, job_id=migration_job.id, analysis_json=existing.analysis_json))
                    linked.append(f'R{existing.number:03d}')
                    continue
                old_candidate = next((x for x in pending if same_paper(json.loads(x.metadata_json), meta)), None)
                if old_candidate:
                    added.append(old_candidate.id)
                    continue
                if row.get('analysis'):
                    # A migration has no original PDF/receipt files. Preserve its
                    # provenance, but never trust client-supplied verification.
                    analysis = clean_export(row['analysis'])
                    analysis.pop('long_term_dir', None)
                    analysis.update(verified=False, provisional=True, report_status='imported',
                                    verification_status='历史导入报告，待关联正文后重新核对', visuals=[], original_images=[],
                                    migration={'legacy_id': row.get('legacy_id'), 'imported_at': now(), 'original_verification_status': row['analysis'].get('verification_status')})
                    scope = (analysis.get('research_logic') or {}).get('reading_scope')
                    if isinstance(scope, dict):
                        scope['verified'] = []
                    if not migration_job:
                        migration_job = Job(id=str(uuid.uuid4()), project_id=pid, requested=0, status='completed', stage='历史迁入', checkpoint=json.dumps({'trigger_source': 'import', 'actual': 0, 'imported': True}))
                        s.add(migration_job)
                        s.flush()
                    number = int(counter.value) + 1
                    counter.value = str(number)
                    meta['revisions'] = row.get('revisions', [])
                    p = Paper(number=number, identity=identity(meta), metadata_json=json.dumps(meta, ensure_ascii=False), analysis_json=json.dumps(analysis, ensure_ascii=False))
                    s.add(p)
                    s.flush()
                    ledger.append(p)
                    s.add(ProjectPaper(id=str(uuid.uuid4()), project_id=pid, paper_number=number, job_id=migration_job.id, analysis_json=p.analysis_json))
                    migrated.append(f'R{number:03d}')
                else:
                    candidate = ImportedCandidate(id=row['id'], project_id=pid, metadata_json=json.dumps(meta, ensure_ascii=False))
                    s.add(candidate)
                    pending.append(candidate)
                    added.append(candidate.id)
            return {'imported': len(added), 'candidates': added, 'linked': linked, 'migrated': migrated, 'new_count': 0,
                    'notice': '已导入候选或迁入历史报告；不会计入分析批次新增。可关联正文后分析或修订。'}

    def records_for_graph(pid):
        return papers_for(pid) + candidates(pid)

    @app.post('/api/projects/{pid}/imports/analyze', dependencies=[Depends(auth)])
    def analyze_imports(pid: str, payload: dict):
        requested_ids = payload.get('selected')
        if not isinstance(requested_ids, list) or not 1 <= len(requested_ids) <= 20 or not all(isinstance(x, str) for x in requested_ids):
            raise ValueError('每次请选择1–20篇导入候选')
        selected = {x.removeprefix('candidate:') for x in requested_ids}
        with admission_lock, session() as s:
            s.execute(select(Setting).where(Setting.key == 'ledger_counter').with_for_update()).scalar_one()
            project = get_project(s, pid)
            rows = s.scalars(select(ImportedCandidate).where(ImportedCandidate.project_id == pid, ImportedCandidate.status == 'pending', ImportedCandidate.id.in_(selected))).all()
            if len(rows) != len(selected):
                raise HTTPException(404, '所选导入候选已变化，请刷新后重试')
            scope = json.loads(project.scope)
            items = [dict(json.loads(r.metadata_json), status='pending', relevant=True, relevance=3, imported_candidate_id=r.id) for r in rows]
            jid = str(uuid.uuid4())
            s.add(Job(id=jid, project_id=pid, requested=0, status='waiting_sources', stage='导入论文待分析', checkpoint=json.dumps({
                'scope_snapshot': scope, 'trigger_source': 'import-analysis', 'import_analysis': True,
                'candidates': items, 'completed': [], 'actual': 0, 'shortfall': 0}, ensure_ascii=False)))
        return {'id': jid, 'job_id': jid, 'status': 'waiting_sources', 'selected_count': len(items), 'new_count': 0,
                'notice': '已准备导入论文任务，显式启动后才调用模型；不另行检索，也不计目标新增。'}

    @app.get('/api/projects/{pid}/graph', dependencies=[Depends(auth)])
    def project_graph(pid: str, view: str = 'citation', relation: str = 'direct_citation', limit: int = 50):
        if view not in ('citation', 'semantic') or not 1 <= limit <= 200:
            raise ValueError('图谱视图应为 citation 或 semantic，节点数量为1–200')
        records = records_for_graph(pid)
        result = build_graph(records, view, relation, limit)
        if view == 'semantic' and result['availability']['available']:
            result['corpus_sha256'] = corpus_fingerprint(records)
            with session() as s:
                cached = s.get(Setting, 'graph_semantic:' + pid)
                if cached:
                    cached.value = json.dumps(result, ensure_ascii=False)
                else:
                    s.add(Setting(key='graph_semantic:' + pid, value=json.dumps(result, ensure_ascii=False)))
        return result

    @app.post('/api/projects/{pid}/graph/expand', dependencies=[Depends(auth)])
    def expand_graph(pid: str, payload: dict):
        seed = next((r for r in records_for_graph(pid) if r['id'] == payload.get('seed_id')), None)
        if not seed:
            raise HTTPException(404, '请先选择当前课题中的论文')
        try:
            cfg = configuration()
        except ValueError:
            cfg = {}
        if not cfg.get('openalex_key'):
            raise ValueError('扩展外部图谱需要部署者配置 OpenAlex 密钥；现有库图谱仍可使用')
        work = next((x for x in aliases(seed) if re.fullmatch(r'W\d+', x)), None)
        identifier = work or ('https://doi.org/' + doi(seed.get('doi')) if seed.get('doi') else '')
        if not identifier:
            raise ValueError('该论文尚无 OpenAlex ID 或 DOI，可先导入含引用关系的题录')
        retrieved = []
        try:
            # All requests use a fixed official origin; keys never reach a URL
            # supplied by imported documents or provider error logs.
            with httpx.Client(timeout=25, trust_env=False, headers={'Authorization': 'Bearer ' + cfg['openalex_key']}) as c:
                response = c.get('https://api.openalex.org/works/' + identifier)
                response.raise_for_status()
                origin = openalex_paper(response.json())
                work = reference_key(origin.get('openalex_id'))
                targets = [reference_key(x) for x in origin['referenced_works'][:12] + origin['related_works'][:8]]
                targets = list(dict.fromkeys(x for x in targets if re.fullmatch(r'W\d+', x)))
                if targets:
                    r = c.get('https://api.openalex.org/works', params={'filter': 'openalex:' + '|'.join(targets), 'per-page': 25})
                    r.raise_for_status()
                    retrieved += [openalex_paper(p) for p in r.json().get('results', [])]
                if re.fullmatch(r'W\d+', work):
                    r = c.get('https://api.openalex.org/works', params={'filter': 'cites:' + work, 'per-page': 20, 'sort': 'publication_date:desc'})
                    r.raise_for_status()
                    retrieved += [openalex_paper(p) for p in r.json().get('results', [])]
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            raise HTTPException(502, 'OpenAlex 关系题录暂不可用，未登记任何新论文；请稍后重试') from None
        added = []
        with admission_lock, session() as s:
            get_project(s, pid)
            papers = s.scalars(select(Paper)).all()
            pending = s.scalars(select(ImportedCandidate).where(ImportedCandidate.project_id == pid)).all()
            # Refresh relation metadata of the seed without replacing its title,
            # authors, source history or reading evidence.
            fields = ('source_ids', 'openalex_id', 'referenced_works', 'related_works', 'citation_count', 'content_urls', 'has_content', 'retrieved_at')
            original = s.get(Paper, int(seed['id'][1:])) if re.fullmatch(r'R\d+', seed['id']) else s.get(ImportedCandidate, seed['id'].removeprefix('candidate:'))
            if original:
                metadata = json.loads(original.metadata_json)
                metadata.update({k: origin[k] for k in fields if k in origin})
                original.metadata_json = json.dumps(metadata, ensure_ascii=False)
            existing_meta = [json.loads(p.metadata_json) for p in papers + pending]
            for meta in retrieved:
                if not meta['title'] or same_paper(meta, seed) or any(same_paper(meta, old) for old in existing_meta):
                    continue
                cid = str(uuid.uuid4())
                s.add(ImportedCandidate(id=cid, project_id=pid, metadata_json=json.dumps(meta, ensure_ascii=False)))
                existing_meta.append(meta)
                added.append('candidate:' + cid)
        return {'added': len(added), 'candidates': added, 'notice': '扩展结果仅进入候选，不代表已阅读全文，也不计入新增论文。'}

    @app.post('/api/projects/{pid}/candidates/{cid}/source', dependencies=[Depends(auth)])
    async def import_candidate_source(pid: str, cid: str, file: UploadFile = File(...)):
        from .pipeline import candidate_folder
        with session() as s:
            project = get_project(s, pid)
            row = s.get(ImportedCandidate, cid.removeprefix('candidate:'))
            if not row or row.project_id != pid:
                raise HTTPException(404, '导入候选不存在')
            meta, scope = json.loads(row.metadata_json), json.loads(project.scope)
        folder = candidate_folder(meta, scope)
        folder.mkdir(parents=True, exist_ok=True)
        staged = folder / ('upload-' + str(uuid.uuid4()) + '.pdf')
        try:
            await save_upload(file, staged)
            with admission_lock, session() as s:
                s.execute(select(Setting).where(Setting.key == 'ledger_counter').with_for_update()).scalar_one()
                project = get_project(s, pid)
                row = s.get(ImportedCandidate, cid.removeprefix('candidate:'))
                if not row or row.project_id != pid:
                    raise HTTPException(404, '导入候选已删除')
                if s.scalar(select(Job).where(Job.status.in_(['queued', 'running']))):
                    raise HTTPException(409, '分析运行期间不能替换正文')
                current = json.loads(row.metadata_json)
                if candidate_folder(current, json.loads(project.scope)).resolve() != folder.resolve():
                    raise HTTPException(409, '研究范围已变化，请刷新后重新上传')
                old = folder / 'paper.pdf'
                same_bytes = old.is_file() and hashlib.sha256(old.read_bytes()).digest() == hashlib.sha256(staged.read_bytes()).digest()
                if same_bytes:
                    staged.unlink()
                else:
                    # A new source cannot reuse extraction/reading/visual receipts.
                    # Preserve the previous bundle rather than deleting evidence.
                    archive = folder / ('revision-' + uuid.uuid4().hex)
                    names = ('paper.pdf', 'source', 'assets', 'source-fingerprint.json', 'text-checkpoints.json',
                             'draft.json', 'analysis.json', 'visual-review-checkpoint.json', 'visual-checkpoints.json',
                             'reading-note.md', 'evidence.json')
                    moved = []
                    try:
                        for name in names:
                            item = folder / name
                            if item.exists():
                                item.resolve().relative_to(folder.resolve())
                                archive.mkdir(exist_ok=True)
                                item.rename(archive / name)
                                moved.append(name)
                        staged.replace(old)
                    except Exception:
                        for name in reversed(moved):
                            if not (folder / name).exists():
                                (archive / name).rename(folder / name)
                        raise
                current.update(fulltext_uploaded=True, fulltext_uploaded_at=now())
                row.metadata_json = json.dumps(current, ensure_ascii=False)
            return {'uploaded': True, 'candidate_id': row.id, 'notice': '论文正文已保存；启动分析后会核对身份与来源，不等于已完成阅读。'}
        finally:
            staged.unlink(missing_ok=True)

    @app.post('/api/papers/{number}/source', dependencies=[Depends(auth)])
    async def revise_paper_source(number: str, project_id: str = '', file: UploadFile = File(...)):
        from .pipeline import candidate_folder
        with session() as s:
            if re.fullmatch(r'R?\d+', number):
                paper = s.get(Paper, int(number.removeprefix('R')))
            else:
                matched = [p for p in s.scalars(select(Paper)).all() if number in json.loads(p.metadata_json).get('legacy_ids', [])]
                if len(matched) > 1:
                    raise HTTPException(409, '旧编号关联多个记录，请选择新的R编号')
                paper = matched[0] if matched else None
            if not paper:
                raise HTTPException(404, '论文不存在')
            number = paper.number
            link = s.scalar(select(ProjectPaper).where(ProjectPaper.paper_number == number, *([ProjectPaper.project_id == project_id] if project_id else [])))
            if not link:
                raise HTTPException(404, '论文尚未关联课题')
            pid = link.project_id
            scope = json.loads(get_project(s, pid).scope)
            meta = json.loads(paper.metadata_json)
        revision_token = uuid.uuid4().hex
        folder = candidate_folder(dict(meta, revision_token=revision_token), scope)
        folder.mkdir(parents=True, exist_ok=True)
        staged = folder / ('upload-' + uuid.uuid4().hex + '.pdf')
        try:
            await save_upload(file, staged)
            with admission_lock, session() as s:
                s.execute(select(Setting).where(Setting.key == 'ledger_counter').with_for_update()).scalar_one()
                if s.scalar(select(Job).where(Job.status.in_(['queued', 'running']))):
                    raise HTTPException(409, '已有分析任务，请结束后再修订论文')
                project = get_project(s, pid)
                if not s.get(Paper, number):
                    raise HTTPException(404, '论文不存在')
                if json.loads(project.scope) != scope:
                    raise HTTPException(409, '研究范围已变化，请重新上传')
                staged.replace(folder / 'paper.pdf')
                candidate = dict(meta, status='pending', relevant=True, relevance=3, revision_number=number,
                                 revision_token=revision_token, fulltext_uploaded=True, fulltext_uploaded_at=now())
                jid = str(uuid.uuid4())
                s.add(Job(id=jid, project_id=pid, requested=0, status='waiting_sources', stage='正文已补充，等待启动修订', checkpoint=json.dumps({'scope_snapshot': scope,
                    'trigger_source': 'paper-revision', 'revision_number': number, 'candidates': [candidate], 'completed': []}, ensure_ascii=False)))
            return {'id': jid, 'job_id': jid, 'paper_id': f'R{number:03d}', 'status': 'waiting_sources', 'new_count': 0, 'notice': '全文已保存，显式启动修订后才调用模型；沿用原编号，不计本批新增。'}
        finally:
            staged.unlink(missing_ok=True)

    @app.get('/api/papers/{number}/pdf', dependencies=[Depends(auth)])
    def saved_paper_pdf(number: int):
        record = next((r for r in papers_for() if r['id'] == f'R{number:03d}'), None)
        relative = (record or {}).get('analysis', {}).get('artifact_dir')
        if not relative:
            raise HTTPException(404, '该历史记录尚未关联论文正文')
        root = DATA.resolve()
        path = (root / relative / 'paper.pdf').resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise HTTPException(404, '论文正文尚未取得')
        return FileResponse(path, media_type='application/pdf', filename='paper.pdf', content_disposition_type='inline', headers={'Content-Security-Policy': "default-src 'none'; sandbox"})

    @app.get('/api/papers/{number}/source', dependencies=[Depends(auth)])
    def saved_paper_source(number: int, page: int | None = None):
        if page is not None and not 1 <= page <= 300:
            raise ValueError('页码必须为1–300')
        record = next((r for r in papers_for() if r['id'] == f'R{number:03d}'), None)
        relative = (record or {}).get('analysis', {}).get('artifact_dir')
        if not relative:
            raise HTTPException(404, '正文来源映射尚未取得')
        root = DATA.resolve()
        path = (root / relative / 'source/source_map.json').resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise HTTPException(404, '正文来源映射尚未取得')
        source = json.loads(path.read_text('utf-8-sig'))
        blocks = [b for b in source.get('blocks', []) if isinstance(b, dict)]
        return {'page': page, 'pages': sorted({b['page'] for b in blocks if type(b.get('page')) is int}),
                'total_blocks': len(blocks), 'blocks': [{k: b[k] for k in ('id', 'page', 'text', 'locator', 'heading', 'type', 'extraction_method') if k in b}
                    for b in blocks if page is None or b.get('page') == page],
                'notice': '正文定位与来源提取；并不代表结论已得到科学验证。'}
