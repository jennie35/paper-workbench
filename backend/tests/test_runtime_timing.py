"""Deterministic time receipts; no real queue, network, waiting or paid model."""
import datetime as dt
import json
from types import SimpleNamespace

import pytest

from app.db import Job, session
from app.pipeline import _run_job
from app.timing import start_run_timing, finish_run_timing, mark_timing_checkpoint, freeze_interrupted_timing
from test_pipeline import project_job, FakeProvider, FakeSkill

START = dt.datetime(2026, 10, 24, 0, tzinfo=dt.timezone.utc)


def active_state(prior=0, baseline=0):
    state = {'audit': 'keep'}
    if prior:
        state['run_timing'] = {'elapsed_ms': prior, 'running': False}
    start_run_timing(state, baseline, START.isoformat(), START)
    return state


def test_active_timer_does_not_accumulate_again_at_each_checkpoint():
    state = active_state(90000, 2)
    mark_timing_checkpoint(state, START + dt.timedelta(seconds=10))
    mark_timing_checkpoint(state, START + dt.timedelta(seconds=20))
    assert state['run_timing']['elapsed_ms'] == 90000
    assert state['run_timing']['run_elapsed_ms'] == 0
    assert state['run_timing']['run_initial_completed'] == 2
    assert finish_run_timing(state, START + dt.timedelta(seconds=30))
    assert state['run_timing']['elapsed_ms'] == 120000
    assert state['run_timing']['run_elapsed_ms'] == 30000
    assert not state['run_timing']['running']
    assert not finish_run_timing(state, START + dt.timedelta(hours=8))
    assert state['run_timing']['elapsed_ms'] == 120000


def test_resume_excludes_idle_time_and_resets_completed_baseline():
    state = active_state(1000)
    mark_timing_checkpoint(state, START + dt.timedelta(seconds=5))
    # Admission metadata has advanced after the crash; use actual checkpoint.
    later = START + dt.timedelta(hours=12)
    start_run_timing(state, 3, later.isoformat(), later)
    timing = state['run_timing']
    assert timing['elapsed_ms'] == 6000 and timing['run_elapsed_ms'] == 0
    assert timing['run_started_at'] == later.isoformat() and timing['run_initial_completed'] == 3
    finish_run_timing(state, later + dt.timedelta(seconds=2))
    assert timing['elapsed_ms'] == 8000 and timing['run_elapsed_ms'] == 2000


def test_orphan_without_checkpoint_receipt_uses_last_saved_job_update():
    state = active_state()
    del state['run_timing']['checkpoint_at']
    assert freeze_interrupted_timing(state, (START + dt.timedelta(seconds=7)).isoformat())
    assert state['run_timing']['elapsed_ms'] == 7000
    assert state['audit'] == 'keep'


@pytest.mark.parametrize('value', [None, 'unknown', -1, float('nan'), float('inf'), 10 ** 1000, {'bad': 1}, True])
def test_malformed_legacy_values_do_not_break_execution_or_inflate_time(value):
    state = {'run_timing': {'elapsed_ms': value, 'running': False}}
    start_run_timing(state, 0, START.isoformat(), START)
    assert state['run_timing']['elapsed_ms'] == 0
    finish_run_timing(state, START - dt.timedelta(minutes=2))
    assert state['run_timing']['run_elapsed_ms'] == state['run_timing']['elapsed_ms'] == 0


def test_malformed_legacy_timing_container_and_timestamp_are_safe():
    state = {'run_timing': 'damaged old record'}
    start_run_timing(state, 0, 'invalid update timestamp', START)
    state['run_timing']['run_started_at'] = 'invalid timestamp'
    assert finish_run_timing(state, START)
    assert state['run_timing']['elapsed_ms'] == 0 and not state['run_timing']['running']


@pytest.mark.parametrize('mode,expected', [('import', 'completed'), ('revision', 'completed'),
                                        ('failed', 'failed'), ('cancelled', 'cancelled'),
                                        ('waiting', 'waiting_sources')])
def test_pipeline_finalizes_every_terminal_path(monkeypatch, mode, expected):
    _, jid = project_job(0 if mode in ('import', 'revision') else 5)
    clock = [START]
    monkeypatch.setattr('app.timing.timestamp', lambda: clock[0])
    def advance(seconds):
        clock[0] += dt.timedelta(seconds=seconds)
    class Skill(FakeSkill):
        def preflight(self):
            advance(1)
            if mode == 'failed':
                raise ValueError('Synthetic failure')
            return {}
    class Provider(FakeProvider):
        def preflight(self, image):
            advance(2)
            return {}
    monkeypatch.setattr('app.pipeline.challenge_image', lambda _: None)
    monkeypatch.setattr('app.pipeline.search', lambda *_: advance(3) or ([], []))
    with session() as s:
        job = s.get(Job, jid)
        state = {'audit': 'keep'}
        if mode == 'import':
            state['import_analysis'] = True
        if mode == 'revision':
            state.update(trigger_source='paper-revision', revision_number=1,
                         candidates=[{'status': 'completed', 'title': 'Synthetic completed revision', 'doi': '10.5555/revision'}])
        job.cancel = mode == 'cancelled'
        job.checkpoint = json.dumps(state)
        # This ancient creation timestamp must not become active runtime.
        job.created_at = (START - dt.timedelta(days=30)).isoformat()
    _run_job(jid, heartbeat=lambda: advance(1), provider=Provider(), skill=Skill())
    with session() as s:
        job = s.get(Job, jid)
        state = json.loads(job.checkpoint)
        timing = state['run_timing']
        assert job.status == expected and state['audit'] == 'keep'
        assert timing['running'] is False and timing['run_initial_completed'] == 0
        assert timing['elapsed_ms'] == timing['run_elapsed_ms'] == int((clock[0] - START).total_seconds() * 1000)
        assert timing['stopped_at'] == clock[0].isoformat()


@pytest.mark.parametrize('runtime', ['local', 'rq', 'already-failed'])
def test_reconcile_freezes_dead_job_at_last_heartbeat(monkeypatch, runtime):
    import app.main as main
    _, jid = project_job()
    state = active_state(1000)
    mark_timing_checkpoint(state, START + dt.timedelta(seconds=4))
    with session() as s:
        job = s.get(Job, jid)
        job.status = 'failed' if runtime == 'already-failed' else 'running'
        job.checkpoint = json.dumps(state)
        job.updated_at = (START + dt.timedelta(hours=8)).isoformat()
    monkeypatch.setattr(main, 'TASK_BACKEND', 'local' if runtime == 'local' else 'rq')
    monkeypatch.setattr('app.local_tasks.task_state', lambda _: 'failed')
    monkeypatch.setattr(main, 'Queue', lambda *_a, **_k: SimpleNamespace(fetch_job=lambda _: SimpleNamespace(get_status=lambda: 'failed')))
    with session() as s:
        job = s.get(Job, jid)
        main.reconcile_job(job)
        timing = json.loads(job.checkpoint)['run_timing']
        assert job.status == 'failed'
        assert timing['elapsed_ms'] == 5000 and timing['running'] is False
        assert timing['stopped_at'] == (START + dt.timedelta(seconds=4)).isoformat()


def test_local_restart_recovery_freezes_before_refreshing_updated_timestamp(monkeypatch):
    from app.local_tasks import recover
    _, jid = project_job()
    state = active_state()
    mark_timing_checkpoint(state, START + dt.timedelta(seconds=6))
    with session() as s:
        job = s.get(Job, jid)
        job.status, job.checkpoint = 'running', json.dumps(state)
        job.updated_at = (START + dt.timedelta(seconds=6)).isoformat()
    queued = []
    monkeypatch.setattr('app.local_tasks.enqueue', queued.append)
    monkeypatch.setattr('app.db.now', lambda: (START + dt.timedelta(hours=8)).isoformat())
    recover()
    assert queued == [jid]
    with session() as s:
        job = s.get(Job, jid)
        assert job.status == 'queued'
        assert json.loads(job.checkpoint)['run_timing']['elapsed_ms'] == 6000
        assert json.loads(job.checkpoint)['run_timing']['running'] is False
