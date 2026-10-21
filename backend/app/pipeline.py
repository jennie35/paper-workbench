"""Checkpointed, evidence-gated research pipeline. Never counts abstracts as deep reads."""
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import uuid

from sqlalchemy import select

from .artifacts import inspect_pdf, challenge_image, write_artifacts, write_record_index
from .config import DATA
from .db import session, Project, Job, Paper, ProjectPaper, Setting, now
from .discovery import search, same_paper, identity, title_key
from .provider import Provider
from .schemas import Analysis
from .skill import Skill
from .security import encryption, download
from .research import RESEARCH_RULES, check_research_logic, stamp_reading_scope, build_synthesis, model_scope


class Cancelled(Exception):
    pass


def configuration():
    with session() as s:
        cfg = s.get(Setting, 'provider')
        if not cfg:
            raise ValueError('请先保存模型配置')
        return json.loads(encryption().decrypt(cfg.value.encode()))


def checkpoint(job_id, state, stage=None, status=None, error=None):
    with session() as s:
        job = s.get(Job, job_id)
        if job.cancel:
            raise Cancelled()
        job.checkpoint = json.dumps(state, ensure_ascii=False)
        job.updated_at = now()
        if stage:
            job.stage = stage
        if status:
            job.status = status
        if error is not None:
            job.error = error


def ledger():
    with session() as s:
        return [(p.number, json.loads(p.metadata_json)) for p in s.scalars(select(Paper)).all()]


def candidate_folder(meta, scope):
    # A changed research scope cannot reuse a stale project-specific draft.
    tag = hashlib.sha256((identity(meta) + json.dumps(scope, ensure_ascii=False, sort_keys=True)).encode()).hexdigest()[:24]
    return DATA / 'papers' / tag


def register(project_id, job_id, meta, analysis):
    """Commit one ledger identity, retaining a recoverable view on DB failure.

    The dated view is derived from canonical sources. If its database transaction
    rolls back, move only the directory this call created to a bounded recovery
    location. Keeping the same directory depth preserves its relative source
    links, and moving rather than deleting retains any concurrent annotations.
    """
    meta = dict(meta, normalized_title=title_key(meta['title']), analyzed_date=analysis.get('analyzed_date'), status='completed', full_text_available=True, evidence_review=analysis.get('verification_status'), reading_skill=analysis.get('reading_skill'), reading_mode='extend', note_path=analysis.get('artifact_dir','')+'/reading-note.md')
    created_view = None
    root = Path(DATA).resolve()

    def remember_created(path):
        nonlocal created_view
        path = Path(path)
        if path.resolve() != path or not path.is_relative_to(root):
            raise ValueError('新建记录目录不在配置主目录内')
        relative = path.relative_to(root).as_posix()
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}/R\d{3,}', relative):
            raise ValueError('新建记录目录不符合日期与编号格式')
        stat = path.stat()
        manifest = path / 'record.json'
        created_view = (path, (stat.st_dev, stat.st_ino), hashlib.sha256(manifest.read_bytes()).hexdigest())

    try:
        with session() as s:
            counter = s.execute(select(Setting).where(Setting.key == 'ledger_counter').with_for_update()).scalar_one()
            existing = next((p for p in s.scalars(select(Paper)).all() if same_paper(meta, json.loads(p.metadata_json))), None)
            if existing:
                number = existing.number
            else:
                number = int(counter.value) + 1
                counter.value = str(number)
                dated_dir = write_record_index(DATA, number, meta, analysis, on_created=remember_created)
                if dated_dir:
                    analysis = dict(analysis, long_term_dir=dated_dir)
                    meta['note_path'] = dated_dir + '/reading-note.md'
                s.add(Paper(number=number, identity=identity(meta), metadata_json=json.dumps(meta, ensure_ascii=False), analysis_json=json.dumps(analysis, ensure_ascii=False)))
                s.flush()
            link = s.scalar(select(ProjectPaper).where(ProjectPaper.project_id == project_id, ProjectPaper.paper_number == number))
            if not link:
                s.add(ProjectPaper(id=str(uuid.uuid4()), project_id=project_id, paper_number=number, job_id=job_id, analysis_json=json.dumps(analysis, ensure_ascii=False)))
        return number, existing is None
    except Exception as error:
        if created_view:
            try:
                # A transport error can leave commit outcome ambiguous. Never
                # relocate a view if another transaction has committed its ID.
                with session() as check:
                    committed = check.get(Paper, number) is not None
                if not committed:
                    path, directory_identity, manifest_hash = created_view
                    stat = path.stat()
                    if (path.resolve() != path or not path.is_relative_to(root)
                            or (stat.st_dev, stat.st_ino) != directory_identity
                            or (path / 'record.json').resolve() != path / 'record.json'
                            or hashlib.sha256((path / 'record.json').read_bytes()).hexdigest() != manifest_hash):
                        raise ValueError('记录目录已被替换或清单已修改，保留现场等待恢复')
                    recovery = root / ('.registration-recovery-' + uuid.uuid4().hex)
                    if recovery.resolve() != recovery or recovery.parent != root:
                        raise ValueError('恢复目录必须位于配置主目录内')
                    recovery.mkdir()
                    (recovery / 'registration-failure.json').write_text(json.dumps({
                        'schema_version': 1, 'status': 'not_registered',
                        'original_path': path.relative_to(root).as_posix(),
                        'manifest_sha256': manifest_hash,
                        'notice': '数据库登记失败；此处保留派生笔记和所有批注，不是已登记论文。原始 PDF、图片和来源映射仍在原 canonical 目录。',
                    }, ensure_ascii=False, indent=2), 'utf-8')
                    # One atomic rename of this call's new derived view only;
                    # no recursive deletion or traversal of links/annotations.
                    path.rename(recovery / path.name)
            except Exception:
                error.add_note('登记恢复未完成：已保留原始来源与记录目录，请检查数据库及 .registration-recovery-* 目录后重试。')
        raise


def rank_candidates(provider, scope, candidates):
    if not candidates:
        return []
    scope = model_scope(scope)
    prompt = '根据课题范围评估题录相关性，不能把年份或期刊当成相关性。只保留直接相关的论文。relevance 从1到3，3为直接回答核心科学问题，2为关键方法，1为背景。返回 {"ranked":[{"index":0,"relevant":true,"relevance":3,"reason":"具体关联"}]}。\n范围：' + json.dumps(scope, ensure_ascii=False) + '\n题录：' + json.dumps([{'index': i, 'title': p['title'], 'abstract':p.get('abstract',''), 'journal': p['journal']} for i, p in enumerate(candidates)], ensure_ascii=False)
    scored = provider.json(prompt)
    selected = []
    seen = set()
    for row in scored.get('ranked', []):
        i = row.get('index')
        if type(i) is int and 0 <= i < len(candidates) and i not in seen:
            seen.add(i)
            score = row.get('relevance', 2)
            p = dict(candidates[i], relevance_reason=str(row.get('reason', '')), relevance=score if type(score) is int and 1 <= score <= 3 else 1, relevant=row.get('relevant') is True)
            selected.append(p)
    for i, candidate in enumerate(candidates):
        if i not in seen:
            selected.append(dict(candidate, relevant=False, relevance=0, relevance_reason='模型未提供明确的相关性判断，不纳入精读'))
    # Model ranks substantive relevance; publication/date only break ties within included set.
    return sorted(selected, key=lambda p: (not p['relevant'], -p['relevance'], p['publication_status'] != 'published', -(p.get('year') or 0)))


def validate_analysis(a, source_map, pages):
    Analysis.model_validate(a)
    if not a['actions'] and not a.get('action_status'):
        raise ValueError('没有可行行动时须解释证据缺口，不能强行生成实验方案')
    blocks = {x['id'] for x in source_map['blocks']}
    check_research_logic(a, blocks)
    eids = [e['id'] for e in a['evidence']]
    aids = [x['id'] for x in a['actions']]
    if len(eids) != len(set(eids)) or len(aids) != len(set(aids)):
        raise ValueError('重复的证据或行动编号')
    for e in a['evidence']:
        if not set(e['source_block_ids']).issubset(blocks):
            raise ValueError('模型引用了不存在的正文来源块')
    for action in a['actions']:
        if not set(action['evidence_ids']).issubset(set(eids)):
            raise ValueError('行动卡引用了不存在的证据')
    if any(type(p) is not int or not 1 <= p <= pages for p in a['required_visual_pages']):
        raise ValueError('模型指定了不存在的原图页码')


def analyze(provider, skill, meta, scope, folder, progress, project_id=None):
    """Full text read in bounded chunks. Native extraction/render/validation is mandatory."""
    folder = Path(folder)
    scope = model_scope(scope)
    texts = inspect_pdf(folder / 'paper.pdf')
    progress('分析')
    source_path = folder / 'source/source_map.json'
    source_hash = hashlib.sha256((folder / 'paper.pdf').read_bytes()).hexdigest()
    fingerprint = folder / 'source-fingerprint.json'
    if fingerprint.exists() and json.loads(fingerprint.read_text('utf-8'))['sha256'] != source_hash:
        raise ValueError('正文指纹改变，旧检查点不能复用；请通过补充全文入口建立修订')
    if not source_path.exists():
        skill.operation('extract', folder)
    fingerprint.write_text(json.dumps({'sha256':source_hash}), 'utf-8')
    source_map = json.loads(source_path.read_text('utf-8-sig'))
    blocks = source_map.get('blocks', [])
    if not blocks:
        raise ValueError('全文来源映射为空')
    # Check identity against PDF first page and opening text, not metadata alone.
    check = provider.json('核对下载正文是否为指定论文，标题、作者和版本是否匹配。不能只根据给定题录回答。返回 {"matches":true,"reason":"理由","version":"正文版本"}。题录：'+json.dumps(meta, ensure_ascii=False)+'\n正文开头：'+ '\n'.join(texts[:2])[:20000])
    if check.get('matches') is not True:
        raise ValueError('全文身份与题录不匹配：' + str(check.get('reason', ''))[:300])
    chunk_file = folder / 'text-checkpoints.json'
    chunks = json.loads(chunk_file.read_text('utf-8')) if chunk_file.exists() else []
    groups, current, length = [], [], 0
    for b in blocks:
        line = json.dumps(b, ensure_ascii=False)
        if length + len(line) > 45000 and current:
            groups.append(current)
            current, length = [], 0
        current.append(b)
        length += len(line)
    if current:
        groups.append(current)
    for i, group in enumerate(groups):
        if i < len(chunks):
            continue
        progress('分析')
        result = provider.json('阅读本组所有正文块，重建问题、方法、实验条件、对照、统计、结论和局限；保留确切来源块ID，列出需要检查的主要图表和公式页。返回 {"notes":"详细证据记录，含来源块ID","visual_pages":[1],"unread":[]}。不要将缺失信息补写为事实。\n'+json.dumps(group, ensure_ascii=False))
        chunks.append(result)
        chunk_file.write_text(json.dumps(chunks, ensure_ascii=False), 'utf-8')
    draft_file = folder / 'draft.json'
    if draft_file.exists():
        a = json.loads(draft_file.read_text('utf-8'))
    else:
        system = __import__('app.provider', fromlist=['SYSTEM']).SYSTEM + '\n\n以下为管理员安装的分析技能规则：\n' + skill.instructions()
        prompt = '按 extend 模式分析，输出符合下列 JSON Schema 的对象。需要精读的章节、图表、公式及实验细节分别给出原因。不能编造数值或图表。原图尚未核验，visuals 先为空。必需图表和公式页列在 required_visual_pages。每个关键结论绑定来源块ID。研究行动要适配当前课题，样本量和阈值有依据或待先导实验。\nSchema:'+json.dumps(Analysis.model_json_schema(), ensure_ascii=False)+'\n课题：'+json.dumps(scope, ensure_ascii=False)+'\n题录：'+json.dumps(meta, ensure_ascii=False)+'\n全篇分段阅读记录：'+json.dumps(chunks, ensure_ascii=False)
        a = provider.json(RESEARCH_RULES + '\n' + prompt, system=system)
        if not a.get('research_logic'):
            raise ValueError('本次模型未返回课题研究逻辑；未登记完成，可重试补齐报告')
        validate_analysis(a, source_map, len(texts))
        draft_file.write_text(json.dumps(a, ensure_ascii=False), 'utf-8')
    validate_analysis(a, source_map, len(texts))
    progress('图表核验')
    visual_pages = sorted(set(a['required_visual_pages']) | {p for chunk in chunks for p in chunk.get('visual_pages', []) if type(p) is int and 1 <= p <= len(texts)})
    # Also inspect text-detected main figure/table pages; never treat captions as visual review.
    visual_pages = sorted(set(visual_pages) | {i+1 for i, t in enumerate(texts) if re.search(r'\b(?:Figure|Fig\.|Table)\s*\d', t, re.I)})
    visual_records = folder / 'visual-checkpoints.json'
    inspected = json.loads(visual_records.read_text('utf-8')) if visual_records.exists() else {}
    assets = folder / 'assets'
    assets.mkdir(exist_ok=True)
    provisional_file = folder / 'provisional.json'

    def preserve_partial(gaps):
        """Expose useful checkpoints without promoting a candidate into the ledger."""
        checked = {key: value for key, value in inspected.items() if value.get('readable') is True and not value.get('unread')}
        unread = [str(item) for chunk in chunks for item in chunk.get('unread', [])] + list(a.get('unread', []))
        partial = dict(a, visuals=[item for result in checked.values() for item in result.get('items', [])],
                       verified=False, provisional=True, verification_status='unverified',
                       verification_gaps=list(dict.fromkeys([*gaps, *unread])),
                       source_sha256=source_hash, source_version=str(check.get('version', '正文版本尚未确认')),
                       artifact_dir=folder.relative_to(DATA).as_posix(), analyzed_date=dt.date.today().isoformat(),
                       reading_skill='norman-paper-reading', reading_mode='extend',
                       project_context={'project_id': project_id, 'scope_snapshot': scope},
                       coverage={'text_blocks_processed': len(blocks),
                                 'text_blocks_read': sum(len(group) for group, chunk in zip(groups, chunks) if not chunk.get('unread')),
                                 'pdf_pages': len(texts), 'visual_pages_checked': sorted(int(page) for page in checked),
                                 'required_visual_pages': sorted(set(visual_pages) | set(a['required_visual_pages'])),
                                 'scope': '正文分析检查点；未读内容及未完成核验项目见缺口记录',
                                 'visual_review': 'partial_model_inspection' if checked else 'not_completed'})
        partial.pop('structural_validation', None)
        stamp_reading_scope(partial, sorted(int(page) for page in checked))
        temporary = provisional_file.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(partial, ensure_ascii=False), 'utf-8')
        temporary.replace(provisional_file)

    preserve_partial(['图表核验与结构校验尚未完成；当前内容为临时分析，不计完整精读'])
    try:
        for page in visual_pages:
            previous = inspected.get(str(page), {})
            if previous.get('readable') is True and not previous.get('unread'):
                continue
            progress('图表核验')
            image = assets / f'page-{page}.png'
            if not image.exists():
                before = set(assets.glob('*.png'))
                skill.operation('render', folder, [page])
                new = sorted(set(assets.glob('*.png')) - before)
                if len(new) != 1:
                    raise ValueError('原图渲染结果无法唯一对应页码')
                new[0].replace(image)
            result = provider.json(f'这是原论文完整PDF第{page}页。必须实际读取图像，核对本页图表/公式，包括子图、图注、坐标、单位、表头、数值和脚注。只讨论实际可见内容。返回 {{"readable":true,"items":[{{"page":{page},"label":"原文图表或公式编号","kind":"figure或table或equation","explanation":"为什么做、方法、如何读、可见观察、支持边界与下一问题；公式含符号单位假设","limitations":"不清晰或未能核对的部分"}}],"unread":[]}}。无法辨读设 readable=false，不猜测。', [image])
            if result.get('readable') is not True or result.get('unread'):
                raise ValueError(f'PDF 第 {page} 页图表或公式未能可靠核验')
            for item in result.get('items', []):
                item['page'] = page
            inspected[str(page)] = result
            visual_records.write_text(json.dumps(inspected, ensure_ascii=False), 'utf-8')
            preserve_partial(['已保存部分原图核验记录；全文结论复核与结构校验尚未完成'])
        a['visuals'] = [item for result in inspected.values() for item in result.get('items', [])]
        # Reconcile text-derived conclusions after inspecting originals; do not append visuals to an unchanged draft.
        if visual_pages:
            revised = provider.json('根据原图实际核验记录，修正此前文本分析中的结论、数字、边界和研究行动；保留 Schema 的全部字段，不能删掉来源定位或把建议写成实验。返回完整分析 JSON。\nSchema:'+json.dumps(Analysis.model_json_schema(), ensure_ascii=False)+'\n原分析：'+json.dumps(a, ensure_ascii=False)+'\n实际视觉核验：'+json.dumps(inspected, ensure_ascii=False))
            if not revised.get('research_logic'):
                raise ValueError('原图复核后的分析缺少课题研究逻辑；已保留检查点，不能登记为完成')
            revised['visuals'] = a['visuals']
            validate_analysis(revised, source_map, len(texts))
            a = revised
        if not a.get('research_logic'):
            raise ValueError('最终分析缺少课题研究逻辑；旧版草稿须补齐后才能登记完成')
        validate_analysis(a, source_map, len(texts))
        preserve_partial(['原图复核后的分析已保存；完整性与结构校验尚未完成'])
        missing_pages = set(a['required_visual_pages']) - set(visual_pages)
        if missing_pages:
            raise ValueError('复核后发现额外关键原图页，需要重试补充核验：'+str(sorted(missing_pages)))
        if any(x.get('unread') for x in chunks) or a.get('unread'):
            raise ValueError('正文分析仍有未读材料，已保存检查点，不计为完整精读')
        a.update(source_sha256=source_hash, coverage={'text_blocks_read': len(blocks), 'pdf_pages': len(texts), 'visual_pages_checked': visual_pages, 'scope': '主文全文；补充材料仅在已获取并记录时覆盖', 'visual_review': 'model_inspected_original_pages'}, verification_status='unverified', verified=False, artifact_dir=folder.relative_to(DATA).as_posix(), analyzed_date=dt.date.today().isoformat(), reading_skill='norman-paper-reading', reading_mode='extend')
        a['source_version'] = str(check.get('version', '正文版本尚未确认'))
        a['project_context'] = {'project_id': project_id, 'scope_snapshot': scope}
        stamp_reading_scope(a, visual_pages)
        a.pop('structural_validation', None)
        a.pop('provisional', None)
        a.pop('verification_gaps', None)
        progress('校验')
        write_artifacts(folder, meta, a, source_map)
        skill.operation('validate', folder)
        a.update(structural_validation='norman_native_passed', verified=True, verification_status='全文与选定原图已模型核验；未经独立人工复核')
        stamp_reading_scope(a, visual_pages, completed=True)
        write_artifacts(folder, meta, a, source_map)
        provisional_file.unlink(missing_ok=True)
        return a
    except Exception as exc:
        preserve_partial([safe_error(exc), '当前结果尚未通过全部精读要求，不计完成篇数'])
        raise


def run_job(job_id):
    from .config import TASK_BACKEND
    if TASK_BACKEND == 'local':
        from .local_tasks import analysis_lock
        with analysis_lock:
            return _run_job(job_id)
    from redis import Redis
    from redis.exceptions import LockError
    from .config import REDIS_URL
    redis = Redis.from_url(REDIS_URL)
    # One global lock, extended at every checkpoint. DB transaction protects final registration.
    lock = redis.lock('paper-workbench:analysis', timeout=900, blocking_timeout=5)
    if not lock.acquire():
        raise RuntimeError('已有分析批次正在执行，请稍后重试')
    try:
        _run_job(job_id, lambda: lock.extend(900, replace_ttl=True))
    finally:
        try:
            lock.release()
        except LockError:
            pass


def project_records(project_id):
    with session() as s:
        links = s.scalars(select(ProjectPaper).where(ProjectPaper.project_id == project_id).order_by(ProjectPaper.paper_number)).all()
        return [dict(json.loads(s.get(Paper, link.paper_number).metadata_json), id=f'R{link.paper_number:03d}', analysis=json.loads(link.analysis_json)) for link in links]


def _run_job(job_id, heartbeat=lambda: None, provider=None, skill=None):
    with session() as s:
        job = s.get(Job, job_id)
        if not job or job.status == 'completed':
            return
        state = json.loads(job.checkpoint)
        project = s.get(Project, job.project_id)
        project_id, requested = project.id, job.requested
        scope = state.setdefault('scope_snapshot', json.loads(project.scope))
    state.setdefault('candidates', [])
    state.setdefault('completed', [])
    state.setdefault('reused', [])
    state.setdefault('diagnostics', [])

    def progress(stage):
        heartbeat()
        checkpoint(job_id, state, stage, 'running')

    try:
        progress('接口预检')
        cfg = configuration() if provider is None else getattr(provider, 'config', {})
        provider, skill = provider or Provider(cfg), skill or Skill()
        skill.preflight()
        provider.preflight(challenge_image(DATA / 'probe'))
        query = ' '.join(scope.get('keywords', [])) or scope.get('research_question') or project.name
        year = dt.date.today().year
        for start in [year-1, year-4, 1900]:
            if len(state['completed']) >= requested:
                break
            if start not in state.get('search_windows', []):
                progress('检索')
                found, errors = search(query, start, cfg)
                state['diagnostics'].extend(errors)
                new = [p for p in found if not any(same_paper(p, x) for x in state['candidates'])]
                ranked = rank_candidates(provider, scope, new)
                state['candidates'].extend(dict(p, status='pending' if p['relevant'] else 'excluded') for p in ranked)
                state.setdefault('search_windows', []).append(start)
                state.setdefault('search_log', []).append({'query': query, 'from_year': start, 'retrieved_at': now(), 'found': len(found), 'new_candidates': len(new)})
                checkpoint(job_id, state)
            for candidate in state['candidates']:
                if len(state['completed']) >= requested:
                    break
                if candidate['status'] in ('completed', 'excluded', 'duplicate', 'reused', 'no_fulltext', 'unverified'):
                    continue
                progress('去重')
                old = next(((n, p) for n, p in ledger() if same_paper(candidate, p)), None)
                if old:
                    with session() as s:
                        link = s.scalar(select(ProjectPaper).where(ProjectPaper.project_id == project_id, ProjectPaper.paper_number == old[0]))
                        recovered = bool(link and link.job_id == job_id)
                        if not link:
                            p = s.get(Paper, old[0])
                            # Existing evidence is reusable; project-specific advice requires its own analysis.
                            s.add(ProjectPaper(id=str(uuid.uuid4()), project_id=project_id, paper_number=old[0], job_id=job_id, analysis_json=json.dumps(dict(json.loads(p.analysis_json), transfer_notice='复用既有分析；当前课题适用性尚待重新评估'), ensure_ascii=False)))
                            state['reused'].append(f'R{old[0]:03d}')
                    if recovered:
                        paper_id = f'R{old[0]:03d}'
                        candidate.update(status='completed', paper_id=paper_id, reason='恢复本批已登记论文')
                        if paper_id not in state['completed']:
                            state['completed'].append(paper_id)
                    else:
                        candidate.update(status='duplicate', reason='已分析，不计新增')
                    checkpoint(job_id, state)
                    continue
                folder = candidate_folder(candidate, scope)
                folder.mkdir(parents=True, exist_ok=True)
                try:
                    progress('获取全文')
                    if not (folder / 'paper.pdf').exists():
                        urls = candidate.get('pdf_urls', [])
                        success = False
                        for url in urls[:8]:
                            try:
                                progress('获取全文')
                                download(url, folder / 'paper.pdf')
                                inspect_pdf(folder / 'paper.pdf')
                                candidate['full_text_url'] = url
                                success = True
                                break
                            except Exception:
                                (folder / 'paper.pdf').unlink(missing_ok=True)
                        if not success:
                            candidate.update(status='no_fulltext', reason='未能取得可可靠读取的全文；可手动上传正文后重试')
                            checkpoint(job_id, state)
                            continue
                    a = analyze(provider, skill, candidate, scope, folder, progress, project_id)
                    progress('校验')
                    number, new_record = register(project_id, job_id, candidate, a)
                    candidate.update(status='completed' if new_record else 'duplicate', paper_id=f'R{number:03d}')
                    if new_record:
                        state['completed'].append(candidate['paper_id'])
                    checkpoint(job_id, state)
                except Cancelled:
                    raise
                except Exception as e:
                    # Retain draft and partial visual artifacts; never count as a completed paper.
                    candidate.update(status='unverified', reason=safe_error(e))
                    checkpoint(job_id, state)
        state['actual'] = len(state['completed'])
        state['shortfall'] = max(0, requested - state['actual'])
        state['pending_verification'] = sum(x['status'] == 'unverified' for x in state['candidates'])
        progress('跨论文综合')
        try:
            state['synthesis'] = build_synthesis(provider, scope, project_records(project_id))
        except Exception as exc:
            # Model synthesis failure cannot erase completed, validated papers.
            state['synthesis'] = {'schema_version': 1, 'status': 'failed', 'created_at': now(), 'record_ids': [], 'priority_actions': [], 'limitations': [safe_error(exc), '已完成论文保留；可单独重试跨论文综合。']}
        checkpoint(job_id, state, '完成', 'completed')
    except Cancelled:
        with session() as s:
            j = s.get(Job, job_id)
            j.status, j.checkpoint, j.updated_at = 'cancelled', json.dumps(state, ensure_ascii=False), now()
    except Exception as e:
        with session() as s:
            j = s.get(Job, job_id)
            j.status, j.error, j.checkpoint, j.updated_at = 'failed', safe_error(e), json.dumps(state, ensure_ascii=False), now()


def safe_error(error):
    # Whitelist application diagnostics only; transport exceptions can contain query secrets.
    if isinstance(error, ValueError):
        value = str(error)
        if not re.search(r'https?://|Bearer |api_key|sk-', value, re.I):
            return value[:600]
    return type(error).__name__ + '：任务未完成；请检查服务连接与配置后重试'
