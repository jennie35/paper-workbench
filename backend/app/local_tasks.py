"""Single-process personal trial queue. Production continues to use Redis/RQ."""
from concurrent.futures import ThreadPoolExecutor
import threading

_executor = None
_futures = {}
_guard = threading.RLock()
analysis_lock = threading.Lock()


def enqueue(job_id):
    global _executor
    from .pipeline import run_job
    with _guard:
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='paper-analysis')
        if job_id in _futures and not _futures[job_id].done():
            raise ValueError('该任务已在本机队列中')
        _futures[job_id] = _executor.submit(run_job, job_id)


def task_state(job_id):
    with _guard:
        future = _futures.get(job_id)
        if future is None:
            return 'missing'
        if not future.done():
            return 'running' if future.running() else 'queued'
        return 'failed' if future.exception() else 'finished'


def recover():
    import json
    from sqlalchemy import select
    from .db import session, Job, now
    from .timing import freeze_interrupted_timing
    with session() as s:
        jobs = s.scalars(select(Job).where(Job.status.in_(['queued', 'running'])).order_by(Job.created_at)).all()
        ids = [j.id for j in jobs]
        for j in jobs:
            state = json.loads(j.checkpoint)
            if freeze_interrupted_timing(state, j.updated_at):
                j.checkpoint = json.dumps(state, ensure_ascii=False)
            j.status, j.updated_at = 'queued', now()
    for job_id in ids:
        enqueue(job_id)


def shutdown():
    global _executor
    with _guard:
        if _executor:
            _executor.shutdown(wait=False)
            _executor = None
