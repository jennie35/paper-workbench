"""Project removal uses isolated synthetic records and files, never a live library."""
import json
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import select

from app import main
from app.config import DATA
from app.db import Job, Paper, Project, ProjectPaper, Reference, Setting, session


def create_project(logged, name='Delete fixture'):
    return logged.post('/api/projects', json={'name': name}).json()['id']


def add_reference(pid, text='Synthetic reference'):
    rid = str(uuid.uuid4())
    folder = DATA / 'references' / rid
    folder.mkdir(parents=True)
    (folder / 'reference.pdf').write_bytes(b'%PDF-synthetic-test-only')
    with session() as s:
        s.add(Reference(id=rid, project_id=pid, filename='fixture.pdf', sha256='0' * 64, text=json.dumps([text])))
    return rid, folder


def test_delete_requires_login_and_missing_project_is_404(client, logged):
    pid = create_project(logged)
    token = logged.headers.pop('Authorization')
    assert client.delete(f'/api/projects/{pid}').status_code == 401
    client.headers['Authorization'] = token
    assert logged.delete('/api/projects/missing').status_code == 404
    assert any(row['id'] == pid for row in logged.get('/api/projects').json())


@pytest.mark.parametrize('status,cancel', [('queued', False), ('running', False), ('running', True)])
def test_delete_waits_until_target_project_worker_has_stopped(logged, status, cancel):
    pid = create_project(logged)
    rid, folder = add_reference(pid)
    with session() as s:
        s.add(Job(id='active-delete-fixture', project_id=pid, status=status, cancel=cancel, requested=1))
    result = logged.delete(f'/api/projects/{pid}')
    assert result.status_code == 409
    assert '停止' in result.json()['detail']
    with session() as s:
        assert s.get(Project, pid) is not None
        assert s.get(Job, 'active-delete-fixture') is not None
        assert s.get(Reference, rid) is not None
    assert (folder / 'reference.pdf').exists()
    with session() as s:
        s.get(Job, 'active-delete-fixture').status = 'cancelled'
    assert logged.delete(f'/api/projects/{pid}').json()['deleted'] is True
    assert not folder.exists()


def test_delete_isolated_project_records_preserves_shared_ledger_and_numbering(logged):
    pid = create_project(logged, 'Remove this project')
    keep = create_project(logged, 'Keep this project')
    rid, folder = add_reference(pid)
    other_rid, other_folder = add_reference(keep)
    cache = DATA / 'papers' / ('shared-' + str(uuid.uuid4()))
    cache.mkdir(parents=True)
    (cache / 'evidence.json').write_text('{"fixture":true}', 'utf-8')
    with session() as s:
        s.add_all([
            Job(id='remove-finished-job', project_id=pid, status='completed', requested=1),
            Job(id='keep-running-job', project_id=keep, status='running', requested=1),
            Paper(number=7, identity='doi:10.5555/shared-delete', metadata_json='{"title":"Synthetic shared paper"}', analysis_json=json.dumps({'artifact_dir': str(cache.relative_to(DATA))})),
            Paper(number=8, identity='doi:10.5555/exclusive-delete', metadata_json='{"title":"Synthetic exclusive paper"}', analysis_json='{}'),
        ])
        s.flush()
        s.add_all([
            ProjectPaper(id=str(uuid.uuid4()), project_id=pid, paper_number=7, job_id='remove-finished-job', analysis_json='{}'),
            ProjectPaper(id=str(uuid.uuid4()), project_id=pid, paper_number=8, job_id='remove-finished-job', analysis_json='{}'),
            ProjectPaper(id=str(uuid.uuid4()), project_id=keep, paper_number=7, job_id='keep-running-job', analysis_json='{}'),
        ])
        s.get(Setting, 'ledger_counter').value = '8'
    result = logged.delete(f'/api/projects/{pid}')
    assert result.status_code == 200
    assert result.json()['preserved_ledger'] is True
    assert result.json()['cleanup_pending'] == []
    with session() as s:
        assert s.get(Project, pid) is None
        assert s.get(Project, keep) is not None
        assert s.get(Job, 'remove-finished-job') is None
        assert s.get(Job, 'keep-running-job') is not None
        assert s.get(Reference, rid) is None
        assert s.get(Reference, other_rid) is not None
        assert list(s.scalars(select(ProjectPaper).where(ProjectPaper.project_id == pid))) == []
        assert len(list(s.scalars(select(ProjectPaper).where(ProjectPaper.project_id == keep)))) == 1
        assert s.get(Paper, 7) is not None
        assert s.get(Paper, 8) is not None
        assert s.get(Setting, 'ledger_counter').value == '8'
    assert not folder.exists()
    assert other_folder.exists()
    assert (cache / 'evidence.json').exists()
    assert logged.get('/api/jobs/remove-finished-job').status_code == 404
    assert logged.get(f'/api/projects/{pid}/references').status_code == 404
    assert logged.delete(f'/api/projects/{pid}').status_code == 404


def test_delete_cors_accepts_only_configured_origin(logged):
    headers = {'Origin': 'https://example.github.io', 'Access-Control-Request-Method': 'DELETE'}
    result = logged.options('/api/projects/test', headers=headers)
    assert result.status_code == 200
    assert 'DELETE' in result.headers['access-control-allow-methods']
    assert result.headers['access-control-allow-origin'] == 'https://example.github.io'
    headers['Origin'] = 'https://evil.invalid'
    assert 'access-control-allow-origin' not in logged.options('/api/projects/test', headers=headers).headers


def test_reference_upload_after_project_deleted_cleans_staging(logged, monkeypatch):
    pid = create_project(logged)
    staged = []

    async def parse_while_deleted(file, path):
        path.write_bytes(b'%PDF-synthetic-test-only')
        staged.append(path.parent)
        assert main.delete_project(pid)['deleted'] is True
        return ['Synthetic extracted text']

    monkeypatch.setattr(main, 'save_upload', parse_while_deleted)
    result = logged.post(f'/api/projects/{pid}/references', files={'file': ('fixture.pdf', b'fixture', 'application/pdf')})
    assert result.status_code == 404
    assert '课题已删除' in result.json()['detail']
    assert not staged[0].exists()
    with session() as s:
        assert list(s.scalars(select(Reference))) == []


def test_delete_reports_cleanup_failure_without_claiming_file_removal(logged, monkeypatch):
    pid = create_project(logged)
    rid, folder = add_reference(pid)

    def unavailable_storage(reference_id):
        raise PermissionError('Synthetic storage denial')

    monkeypatch.setattr(main, 'remove_reference_folder', unavailable_storage)
    result = logged.delete(f'/api/projects/{pid}')
    assert result.status_code == 200
    assert result.json()['cleanup_pending'] == [rid]
    assert '清理失败' in result.json()['notice']
    assert folder.exists()
    assert 'Synthetic storage denial' not in result.text
    with session() as s:
        assert s.get(Project, pid) is None


def test_delete_transaction_failure_retains_project_records_and_reference_files(logged, monkeypatch):
    pid = create_project(logged)
    rid, folder = add_reference(pid)
    with session() as s:
        s.add(Job(id='rollback-delete-job', project_id=pid, status='failed', requested=1))

    @contextmanager
    def failed_commit():
        with session() as s:
            yield s
            raise RuntimeError('Synthetic commit failure')

    monkeypatch.setattr(main, 'session', failed_commit)
    result = logged.delete(f'/api/projects/{pid}')
    assert result.status_code == 500
    with session() as s:
        assert s.get(Project, pid) is not None
        assert s.get(Reference, rid) is not None
        assert s.get(Job, 'rollback-delete-job') is not None
    assert (folder / 'reference.pdf').exists()


def test_duplicate_reference_upload_cleans_only_new_staging_folder(logged, monkeypatch):
    pid = create_project(logged)
    staged = []

    async def parse_fixture(file, path):
        path.write_bytes(b'%PDF-synthetic-duplicate-only')
        staged.append(path.parent)
        return ['Synthetic extracted reference']

    monkeypatch.setattr(main, 'save_upload', parse_fixture)
    first = logged.post(f'/api/projects/{pid}/references', files={'file': ('fixture.pdf', b'fixture', 'application/pdf')})
    second = logged.post(f'/api/projects/{pid}/references', files={'file': ('again.pdf', b'fixture', 'application/pdf')})
    assert first.status_code == second.status_code == 200
    assert first.json()['id'] == second.json()['id']
    assert second.json()['reused'] is True
    assert staged[0].exists()
    assert not staged[1].exists()
    with session() as s:
        assert len(list(s.scalars(select(Reference).where(Reference.project_id == pid)))) == 1


def test_reference_cleanup_rejects_redirected_storage_root(tmp_path, monkeypatch):
    data = tmp_path / 'data'
    root = data / 'references'
    outside = tmp_path / 'outside'
    rid = str(uuid.uuid4())
    folder = root / rid
    folder.mkdir(parents=True)
    (folder / 'retained.txt').write_text('Synthetic retained file', 'utf-8')
    original_resolve = Path.resolve

    def redirected_root(path, *args, **kwargs):
        if path == root:
            return outside
        return original_resolve(path, *args, **kwargs)

    monkeypatch.setattr(main, 'DATA', data)
    monkeypatch.setattr(Path, 'resolve', redirected_root)
    with pytest.raises(ValueError, match='存储路径无效'):
        main.remove_reference_folder(rid)
    assert (folder / 'retained.txt').exists()


def test_reference_cleanup_rejects_escape_ids_and_links(tmp_path):
    with pytest.raises(ValueError):
        main.remove_reference_folder('../outside')
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'retained.txt').write_text('Synthetic preserved file', 'utf-8')
    rid = str(uuid.uuid4())
    link = DATA / 'references' / rid
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip('Test account cannot create a directory symlink')
    try:
        with pytest.raises(ValueError):
            main.remove_reference_folder(rid)
        assert (outside / 'retained.txt').exists()
    finally:
        link.unlink()
