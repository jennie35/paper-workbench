import json
import threading
import uuid

from app.db import session, Project, Job


def test_local_job_submission_does_not_require_redis(logged, monkeypatch):
    import app.main as main
    calls = []
    monkeypatch.setattr(main, 'TASK_BACKEND', 'local')
    monkeypatch.setattr(main, 'configuration', lambda: {})
    monkeypatch.setattr('app.main.Skill.preflight', lambda self: {'available': True})
    monkeypatch.setattr('app.local_tasks.enqueue', calls.append)
    pid = logged.post('/api/projects', json={'name': 'Local topic'}).json()['id']
    r = logged.post(f'/api/projects/{pid}/jobs', json={'count': 1})
    assert r.status_code == 200
    assert calls == [r.json()['id']]


def test_local_restart_recovers_checkpoint(monkeypatch):
    from app.local_tasks import recover
    pid, jid = str(uuid.uuid4()), str(uuid.uuid4())
    with session() as s:
        s.add(Project(id=pid, name='Restart fixture', goal='', scope='{}'))
        s.add(Job(id=jid, project_id=pid, requested=5, status='running', stage='图表核验', checkpoint=json.dumps({'completed': ['R001'], 'audit': 'retain'})))
    calls = []
    monkeypatch.setattr('app.local_tasks.enqueue', calls.append)
    recover()
    with session() as s:
        j = s.get(Job, jid)
        assert j.status == 'queued' and j.stage == '图表核验'
        assert json.loads(j.checkpoint)['completed'] == ['R001']
    assert calls == [jid]


def test_local_queue_runs_only_one_analysis(monkeypatch):
    import app.local_tasks as tasks
    entered, release, done = threading.Event(), threading.Event(), threading.Event()
    calls = []
    def run(jid):
        calls.append(jid)
        if jid == 'first':
            entered.set()
            assert release.wait(3)
        else:
            done.set()
    monkeypatch.setattr('app.pipeline.run_job', run)
    try:
        tasks.enqueue('first')
        assert entered.wait(3)
        tasks.enqueue('second')
        assert calls == ['first']
        release.set()
        assert done.wait(3)
        assert calls == ['first', 'second']
    finally:
        release.set()
        tasks.shutdown()


def test_local_runner_bypasses_redis(monkeypatch):
    from app.pipeline import run_job
    monkeypatch.setattr('app.config.TASK_BACKEND', 'local')
    monkeypatch.setattr('app.pipeline._run_job', lambda jid: 'local:' + jid)
    assert run_job('fixture') == 'local:fixture'
