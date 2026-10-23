"""Opt-in daily research batches; persistent admission, no browser timer fiction."""
import datetime as dt
import json
import re
import threading
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from .db import Job, Project, ProjectSchedule, Setting, session

UTC = dt.timezone.utc


class ScheduleInput(BaseModel):
    enabled: bool = False
    time: str = Field(default='09:00', min_length=5, max_length=5)
    timezone: str = Field(default='Asia/Shanghai', min_length=1, max_length=100)
    target_count: int = Field(default=5, ge=1, le=20)

    @field_validator('time')
    @classmethod
    def valid_time(cls, value):
        if not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', value):
            raise ValueError('每天执行时间必须为 HH:mm')
        return value

    @field_validator('timezone')
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ValueError, ZoneInfoNotFoundError):
            raise ValueError('请选择有效的 IANA 时区，例如 Asia/Shanghai') from None
        return value


def next_occurrence(config, after):
    """One future local wall time; skip DST gaps and never run twice on a fold."""
    zone = ZoneInfo(config['timezone'])
    local = after.astimezone(zone)
    hour, minute = map(int, config['time'].split(':'))
    for offset in range(4):
        day = local.date() + dt.timedelta(days=offset)
        candidate = dt.datetime.combine(day, dt.time(hour, minute), tzinfo=zone)
        utc = candidate.astimezone(UTC)
        if utc > after and utc.astimezone(zone).replace(tzinfo=None) == candidate.replace(tzinfo=None):
            return utc.isoformat()
    raise ValueError('无法确定下一次定时执行时间')


def schedule_view(row, count=5):
    config = json.loads(row.config_json) if row else ScheduleInput(target_count=count).model_dump()
    return {**config, 'enabled': bool(row and row.enabled),
            'next_run_at': row.next_run_at or None if row else None,
            'last_run_at': row.last_run_at or None if row else None,
            'last_job_id': row.last_job_id or None if row else None,
            'last_error': row.last_error if row else '',
            'notice': '仅在私人后台持续运行时触发；启用后按当前模型配置产生正常用量。未完成批次优先从检查点继续。'}


def tick(enqueue, admission_lock, configuration, current=None, reconcile=None):
    current = current or dt.datetime.now(UTC)
    queued = []
    # The same ledger row serializes manual jobs, imports, deletion and schedules.
    with admission_lock:
        with session() as s:
            s.execute(select(Setting).where(Setting.key == 'ledger_counter').with_for_update()).scalar_one()
            due = s.scalars(select(ProjectSchedule).where(ProjectSchedule.enabled.is_(True),
                ProjectSchedule.next_run_at <= current.isoformat(), ProjectSchedule.next_run_at != '')
                .order_by(ProjectSchedule.next_run_at, ProjectSchedule.project_id).with_for_update()).all()
            if not due:
                return []
            active = s.scalars(select(Job).where(Job.status.in_(['queued', 'running']))).all()
            for job in active:
                if reconcile:
                    reconcile(job)
            if any(job.status in ('queued', 'running') for job in active):
                for row in due:
                    row.last_error = '已有批次运行，本次定时执行等待空闲。'
                return []
            for row in due:
                project = s.get(Project, row.project_id)
                if not project:
                    continue
                try:
                    configuration()
                except Exception:
                    row.last_error = '模型配置不可用，请在连接与模型设置中检查。'
                    row.next_run_at = next_occurrence(json.loads(row.config_json), current)
                    continue
                config, scope = json.loads(row.config_json), json.loads(project.scope)
                if scope.get('inferred', True) or not (scope.get('research_question') or scope.get('keywords')):
                    row.last_error = '研究范围尚未确认，请先保存课题范围。'
                    row.next_run_at = next_occurrence(config, current)
                    continue
                previous = s.get(Job, row.last_job_id) if row.last_job_id else None
                previous_state = json.loads(previous.checkpoint) if previous else {}
                if (previous and previous.requested == config['target_count']
                        and previous.status in ('waiting_sources', 'failed')
                        and previous_state.get('scope_snapshot') == scope):
                    job = previous
                    state = previous_state
                    for candidate in state.get('candidates', []):
                        if candidate.get('status') in ('no_fulltext', 'unverified'):
                            candidate['status'] = 'pending'
                    state['scheduled_retry_at'] = current.isoformat()
                    job.checkpoint = json.dumps(state, ensure_ascii=False)
                    job.status, job.cancel, job.error = 'queued', False, ''
                    job.updated_at = current.isoformat()
                else:
                    job = Job(id=str(uuid.uuid4()), project_id=project.id, requested=config['target_count'],
                        checkpoint=json.dumps({'scope_snapshot': scope, 'trigger_source': 'schedule',
                            'scheduled_for': row.next_run_at}, ensure_ascii=False))
                    s.add(job)
                row.last_run_at, row.last_job_id, row.last_error = current.isoformat(), job.id, ''
                row.next_run_at = next_occurrence(config, current)
                queued.append((row.project_id, job.id))
                break  # One instance runs only one batch at a time.
        for project_id, jid in queued:
            try:
                enqueue(jid)
            except Exception:
                with session() as s:
                    job, schedule = s.get(Job, jid), s.get(ProjectSchedule, project_id)
                    if job:
                        job.status, job.error = 'failed', '定时任务入队失败，请检查后台队列并重试。'
                    if schedule:
                        schedule.last_error = '定时任务入队失败；已保留可重试检查点。'
    return [jid for _, jid in queued]


def start_scheduler(enqueue, admission_lock, configuration, reconcile=None):
    stop = threading.Event()

    def work():
        # A restart catches up at most one missed execution, not one per missed day.
        while not stop.is_set():
            try:
                tick(enqueue, admission_lock, configuration, reconcile=reconcile)
            except Exception:
                # Errors are not logged with provider data; persisted rows are retryable.
                pass
            stop.wait(30)

    thread = threading.Thread(target=work, daemon=True, name='research-scheduler')
    thread.start()
    return stop, thread


def install_schedule_routes(app, auth, get_project, configuration, admission_lock):
    @app.get('/api/projects/{pid}/schedule', dependencies=[Depends(auth)])
    def get_schedule(pid: str):
        with session() as s:
            project = get_project(s, pid)
            return schedule_view(s.get(ProjectSchedule, pid), json.loads(project.scope).get('default_count', 5))

    @app.put('/api/projects/{pid}/schedule', dependencies=[Depends(auth)])
    def save_schedule(pid: str, payload: ScheduleInput):
        with admission_lock, session() as s:
            s.execute(select(Setting).where(Setting.key == 'ledger_counter').with_for_update()).scalar_one()
            project = get_project(s, pid)
            scope = json.loads(project.scope)
            if payload.enabled:
                configuration()
                if scope.get('inferred', True) or not (scope.get('research_question') or scope.get('keywords')):
                    raise HTTPException(400, '请先确认并保存研究范围，再启用定时任务。')
            row = s.get(ProjectSchedule, pid)
            if not row:
                row = ProjectSchedule(project_id=pid)
                s.add(row)
                s.flush()
            config = payload.model_dump()
            unchanged = row.enabled and payload.enabled and row.config_json == json.dumps(config, ensure_ascii=False)
            row.enabled, row.config_json, row.last_error = payload.enabled, json.dumps(config, ensure_ascii=False), ''
            if not unchanged:
                row.next_run_at = next_occurrence(config, dt.datetime.now(UTC)) if payload.enabled else ''
            return schedule_view(row)
