"""Actual active job time. Queue waits and retry downtime are never runtime."""
import datetime as dt
import math


def _date(value):
    if isinstance(value, dt.datetime):
        result = value
    elif isinstance(value, str):
        try:
            result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            return None
    else:
        return None
    return result.replace(tzinfo=dt.timezone.utc) if result.tzinfo is None else result.astimezone(dt.timezone.utc)


def _milliseconds(value):
    if (not isinstance(value, (int, float)) or isinstance(value, bool)
            or value < 0 or value > 9007199254740991):
        return 0
    return int(value) if math.isfinite(value) else 0


def timestamp():
    return dt.datetime.now(dt.timezone.utc)


def finish_run_timing(state, current=None):
    timing = state.get('run_timing')
    if not isinstance(timing, dict) or timing.get('running') is not True:
        return False
    start, end = _date(timing.get('run_started_at')), _date(current) if current is not None else timestamp()
    if end is None:
        end = start or timestamp()
    duration = max(0, int((end - start).total_seconds() * 1000)) if start else 0
    timing.update(elapsed_ms=_milliseconds(timing.get('elapsed_ms')) + duration,
                  run_elapsed_ms=duration, running=False, stopped_at=end.isoformat())
    return True


def freeze_interrupted_timing(state, last_updated_at):
    timing = state.get('run_timing')
    if not isinstance(timing, dict) or timing.get('running') is not True:
        return False
    # Other admission/recovery updates can change Job.updated_at. This receipt
    # belongs to the executing worker's latest persisted checkpoint instead.
    end = (_date(timing.get('checkpoint_at')) or _date(last_updated_at)
           or _date(timing.get('run_started_at')))
    return finish_run_timing(state, end)


def start_run_timing(state, completed, last_updated_at, current=None):
    freeze_interrupted_timing(state, last_updated_at)
    previous = state.get('run_timing') if isinstance(state.get('run_timing'), dict) else {}
    current = _date(current) if current is not None else timestamp()
    current = current or timestamp()
    state['run_timing'] = {'elapsed_ms': _milliseconds(previous.get('elapsed_ms')),
                           'running': True, 'run_started_at': current.isoformat(),
                           'run_initial_completed': _milliseconds(completed),
                           'run_elapsed_ms': 0, 'checkpoint_at': current.isoformat()}


def mark_timing_checkpoint(state, current=None):
    timing = state.get('run_timing')
    if isinstance(timing, dict) and timing.get('running') is True:
        timing['checkpoint_at'] = ((_date(current) if current is not None else timestamp()) or timestamp()).isoformat()
