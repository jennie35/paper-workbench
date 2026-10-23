"""Daily batches use mock queue/provider; never a real model or timed paid run."""
import datetime as dt
import json

import pytest

from app.db import Job, Project, ProjectSchedule, session
from app.main import _admission_lock
from app.schedules import next_occurrence, tick

UTC = dt.timezone.utc
CURRENT = dt.datetime(2026, 10, 23, 2, tzinfo=UTC)


def project(logged, confirmed=True):
    return logged.post('/api/projects', json={'name': 'Synthetic daily topic', 'scope': {
        'research_question': 'How does a synthetic treatment change a synthetic response?',
        'keywords': ['synthetic treatment'], 'inferred': not confirmed,
    }}).json()['id']


def configure(monkeypatch):
    monkeypatch.setattr('app.main.configuration', lambda: {'text_model': 'MOCK', 'api_key': 'TEST-ONLY'})
    # install_schedule_routes closes over the original configuration function.
    from app.db import Setting
    from app.security import encryption
    with session() as s:
        s.add(Setting(key='provider', value=encryption().encrypt(json.dumps({
            'base_url': 'https://model.example/v1', 'text_model': 'MOCK', 'api_key': 'TEST-ONLY'
        }).encode()).decode()))


def enable(logged, pid, count=5):
    response = logged.put(f'/api/projects/{pid}/schedule', json={
        'enabled': True, 'time': '09:00', 'timezone': 'Asia/Shanghai', 'target_count': count})
    assert response.status_code == 200, response.text
    return response.json()


def due(pid):
    with session() as s:
        s.get(ProjectSchedule, pid).next_run_at = (CURRENT - dt.timedelta(days=3)).isoformat()


def test_schedule_default_disabled_private_and_scope_count(logged, client):
    pid = project(logged)
    result = logged.get(f'/api/projects/{pid}/schedule').json()
    assert result['enabled'] is False and result['next_run_at'] is None
    assert result['time'] == '09:00' and result['target_count'] == 5
    assert 'api_key' not in result and 'config_json' not in result
    client.headers.pop('Authorization')
    assert client.get(f'/api/projects/{pid}/schedule').status_code == 401
    assert client.put(f'/api/projects/{pid}/schedule', json={}).status_code == 401


@pytest.mark.parametrize('invalid', [{'time': '25:10'}, {'time': '9:00'}, {'timezone': '../etc/passwd'}, {'target_count': 0}, {'target_count': 21}])
def test_schedule_rejects_invalid_configuration(logged, invalid):
    pid = project(logged)
    result = logged.put(f'/api/projects/{pid}/schedule', json=invalid)
    assert result.status_code == 422


def test_enabling_requires_saved_range_and_model(logged, monkeypatch):
    pid = project(logged, confirmed=False)
    assert logged.put(f'/api/projects/{pid}/schedule', json={'enabled': True}).status_code == 400
    configure(monkeypatch)
    response = logged.put(f'/api/projects/{pid}/schedule', json={'enabled': True})
    assert response.status_code == 400 and '范围' in response.text


def test_save_does_not_run_model_or_queue_and_disable_persists(logged, monkeypatch):
    configure(monkeypatch)
    pid = project(logged)
    monkeypatch.setattr('app.main.enqueue', lambda jid: pytest.fail('Saving must not enqueue'))
    result = enable(logged, pid)
    assert result['enabled'] and result['next_run_at'] and not result['last_job_id']
    repeated = enable(logged, pid)
    assert repeated['next_run_at'] == result['next_run_at']
    with session() as s:
        assert not s.query(Job).count()
    disabled = logged.put(f'/api/projects/{pid}/schedule', json={'enabled': False}).json()
    assert disabled['enabled'] is False and disabled['next_run_at'] is None


def test_tick_catches_up_once_and_uses_latest_confirmed_scope(logged, monkeypatch):
    configure(monkeypatch)
    pid = project(logged)
    enable(logged, pid, count=3)
    due(pid)
    queued = []
    assert len(tick(queued.append, _admission_lock, lambda: {}, CURRENT)) == 1
    assert len(queued) == 1
    assert tick(queued.append, _admission_lock, lambda: {}, CURRENT) == []
    with session() as s:
        row, job = s.get(ProjectSchedule, pid), s.get(Job, queued[0])
        assert row.next_run_at == '2026-10-24T01:00:00+00:00'
        assert row.last_run_at == CURRENT.isoformat()
        assert job.requested == 3 and job.status == 'queued'
        state = json.loads(job.checkpoint)
        assert state['trigger_source'] == 'schedule'
        assert state['scope_snapshot']['keywords'] == ['synthetic treatment']


def test_tick_waits_for_active_batch_without_creating_extra(logged, monkeypatch):
    configure(monkeypatch)
    pid = project(logged)
    enable(logged, pid)
    due(pid)
    with session() as s:
        s.add(Job(id='active', project_id=pid, requested=5, status='running'))
    assert tick(lambda _: pytest.fail('busy'), _admission_lock, lambda: {}, CURRENT) == []
    result = logged.get(f'/api/projects/{pid}/schedule').json()
    assert '等待空闲' in result['last_error'] and not result['last_job_id']


def test_waiting_scheduled_batch_resumes_original_checkpoint(logged, monkeypatch):
    configure(monkeypatch)
    pid = project(logged)
    enable(logged, pid)
    due(pid)
    with session() as s:
        row = s.get(ProjectSchedule, pid)
        row.last_job_id = 'previous'
        s.add(Job(id='previous', project_id=pid, requested=5, status='waiting_sources', checkpoint=json.dumps({
            'new_count': 2, 'scope_snapshot': json.loads(s.get(Project, pid).scope),
            'candidates': [{'status': 'completed', 'paper_id': 'R001'}, {'status': 'no_fulltext'}],
        })))
    assert tick(lambda _: None, _admission_lock, lambda: {}, CURRENT) == ['previous']
    with session() as s:
        assert s.query(Job).count() == 1
        state = json.loads(s.get(Job, 'previous').checkpoint)
        assert state['new_count'] == 2 and state['candidates'][0]['status'] == 'completed'
        assert state['candidates'][1]['status'] == 'pending'
        assert state['scope_snapshot']['research_question'].startswith('How does a synthetic')


def test_changed_scope_starts_new_batch_and_preserves_old_checkpoint(logged, monkeypatch):
    configure(monkeypatch)
    pid = project(logged)
    enable(logged, pid)
    due(pid)
    old_scope = {'research_question': 'old research question', 'inferred': False}
    with session() as s:
        s.get(ProjectSchedule, pid).last_job_id = 'previous'
        s.add(Job(id='previous', project_id=pid, requested=5, status='waiting_sources',
                  checkpoint=json.dumps({'scope_snapshot': old_scope, 'new_count': 2})))
    [jid] = tick(lambda _: None, _admission_lock, lambda: {}, CURRENT)
    assert jid != 'previous'
    with session() as s:
        assert s.query(Job).count() == 2
        assert json.loads(s.get(Job, 'previous').checkpoint)['scope_snapshot'] == old_scope
        assert json.loads(s.get(Job, jid).checkpoint)['scope_snapshot']['research_question'] != 'old research question'


def test_scheduler_reconciles_dead_queue_before_admitting_run(logged, monkeypatch):
    configure(monkeypatch)
    pid = project(logged)
    enable(logged, pid)
    due(pid)
    with session() as s:
        scope = json.loads(s.get(Project, pid).scope)
        s.get(ProjectSchedule, pid).last_job_id = 'dead'
        s.add(Job(id='dead', project_id=pid, requested=5, status='running',
                  checkpoint=json.dumps({'scope_snapshot': scope, 'candidates': []})))
    checked = []
    def reconcile(job):
        checked.append(job.id)
        job.status = 'failed'
    assert tick(lambda _: None, _admission_lock, lambda: {}, CURRENT, reconcile) == ['dead']
    assert checked == ['dead']
    with session() as s:
        assert s.query(Job).count() == 1 and s.get(Job, 'dead').status == 'queued'


def test_queue_failure_keeps_recoverable_job_and_no_repeated_claim(logged, monkeypatch):
    configure(monkeypatch)
    pid = project(logged)
    enable(logged, pid)
    due(pid)
    def fail(_):
        raise OSError('secret provider payload must never be exposed')
    [jid] = tick(fail, _admission_lock, lambda: {}, CURRENT)
    result = logged.get(f'/api/projects/{pid}/schedule').json()
    assert '入队失败' in result['last_error'] and 'secret' not in str(result)
    assert tick(fail, _admission_lock, lambda: {}, CURRENT) == []
    with session() as s:
        assert s.get(Job, jid).status == 'failed'


def test_missing_configuration_skips_until_next_time_with_actionable_error(logged, monkeypatch):
    configure(monkeypatch)
    pid = project(logged)
    enable(logged, pid)
    due(pid)
    def fail():
        raise ValueError('private configured secret')
    assert tick(lambda _: pytest.fail('unconfigured'), _admission_lock, fail, CURRENT) == []
    result = logged.get(f'/api/projects/{pid}/schedule').json()
    assert '模型配置不可用' in result['last_error'] and 'private' not in str(result)
    assert result['next_run_at'] == '2026-10-24T01:00:00+00:00'


def test_delete_project_removes_its_schedule(logged, monkeypatch):
    configure(monkeypatch)
    pid = project(logged)
    enable(logged, pid)
    assert logged.delete(f'/api/projects/{pid}').status_code == 200
    with session() as s:
        assert s.get(ProjectSchedule, pid) is None


def test_next_occurrence_utc_and_dst_gap():
    config = {'time': '09:00', 'timezone': 'Asia/Shanghai'}
    assert next_occurrence(config, dt.datetime(2026, 10, 23, 0, tzinfo=UTC)) == '2026-10-23T01:00:00+00:00'
    config = {'time': '02:30', 'timezone': 'America/New_York'}
    assert next_occurrence(config, dt.datetime(2026, 3, 8, 6, tzinfo=UTC)) == '2026-03-09T06:30:00+00:00'
