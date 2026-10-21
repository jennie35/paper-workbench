"""Registration failures retain sources and release only an uncommitted view."""
import json
import uuid

import pytest
from sqlalchemy.orm import Session as OrmSession

from app.artifacts import write_record_index
from app.db import Job, Paper, Project, ProjectPaper, Setting, session
from app.pipeline import register
from fixtures import analysis, metadata


def prepared(tmp_path, monkeypatch, tag='first'):
    monkeypatch.setattr('app.pipeline.DATA', tmp_path)
    source = tmp_path / 'papers' / tag
    (source / 'assets').mkdir(parents=True)
    (source / 'source').mkdir()
    (source / 'paper.pdf').write_bytes(b'%PDF-synthetic-source-' + tag.encode())
    (source / 'reading-note.md').write_text('# Synthetic source note\n', 'utf-8')
    (source / 'evidence.json').write_text('{"synthetic":true}', 'utf-8')
    (source / 'source' / 'source_map.json').write_text('{"blocks":[]}', 'utf-8')
    a = dict(analysis(), artifact_dir='papers/' + tag, analyzed_date='2026-10-21', source_sha256=tag)
    p = metadata('Synthetic ' + tag, '10.1234/' + tag)
    return source, p, a


def project_job():
    pid, jid = str(uuid.uuid4()), str(uuid.uuid4())
    with session() as s:
        s.add(Project(id=pid, name='Synthetic registration test'))
        s.add(Job(id=jid, project_id=pid, requested=1))
    return pid, jid


def fail_first_paper_commit(monkeypatch, before_failure=lambda: None, after_commit=False):
    original = OrmSession.commit
    failed = False

    def commit(s):
        nonlocal failed
        if not failed and s.get(Paper, 1) is not None:
            failed = True
            before_failure()
            if after_commit:
                original(s)
            raise RuntimeError('Synthetic database commit failure')
        return original(s)

    monkeypatch.setattr(OrmSession, 'commit', commit)


def test_failed_commit_preserves_sources_and_annotations_and_reuses_number(tmp_path, monkeypatch):
    source, p, a = prepared(tmp_path, monkeypatch)
    pid, jid = project_job()
    canonical = {str(f.relative_to(source)): f.read_bytes() for f in source.rglob('*') if f.is_file()}
    view = tmp_path / '2026-10-21' / 'R001'

    def annotate():
        note = view / 'reading-note.md'
        note.write_text(note.read_text('utf-8') + '\nUSER ANNOTATION: preserve this.\n', 'utf-8')
        (view / 'personal-comments.md').write_text('User-owned research comment.', 'utf-8')

    fail_first_paper_commit(monkeypatch, annotate)
    with pytest.raises(RuntimeError, match='Synthetic database commit failure'):
        register(pid, jid, p, a)
    with session() as s:
        assert s.get(Paper, 1) is None
        assert s.get(Setting, 'ledger_counter').value == '0'
        assert s.query(ProjectPaper).count() == 0
    assert not view.exists()
    recovered = list(tmp_path.glob('.registration-recovery-*/R001'))
    assert len(recovered) == 1
    assert 'USER ANNOTATION' in (recovered[0] / 'reading-note.md').read_text('utf-8')
    assert (recovered[0] / 'personal-comments.md').read_text('utf-8') == 'User-owned research comment.'
    notice = json.loads((recovered[0].parent / 'registration-failure.json').read_text('utf-8'))
    assert notice['status'] == 'not_registered'
    pointer = json.loads((recovered[0] / 'source' / 'reference.json').read_text('utf-8'))
    assert (recovered[0] / pointer['original_pdf']).resolve() == source / 'paper.pdf'
    assert canonical == {str(f.relative_to(source)): f.read_bytes() for f in source.rglob('*') if f.is_file()}

    _, second, second_analysis = prepared(tmp_path, monkeypatch, 'different-paper')
    assert register(pid, jid, second, second_analysis) == (1, True)
    assert json.loads((view / 'record.json').read_text('utf-8'))['doi'] == second['doi']
    with session() as s:
        assert s.get(Setting, 'ledger_counter').value == '1'
        assert json.loads(s.get(Paper, 1).metadata_json)['doi'] == second['doi']
    assert (recovered[0] / 'personal-comments.md').is_file()


def test_failed_commit_never_moves_a_preexisting_annotated_view(tmp_path, monkeypatch):
    _, p, a = prepared(tmp_path, monkeypatch)
    pid, jid = project_job()
    relative = write_record_index(tmp_path, 1, p, a)
    view = tmp_path / relative
    (view / 'reading-note.md').write_text('Existing user annotations.', 'utf-8')
    fail_first_paper_commit(monkeypatch)
    with pytest.raises(RuntimeError, match='Synthetic database commit failure'):
        register(pid, jid, p, a)
    assert (view / 'reading-note.md').read_text('utf-8') == 'Existing user annotations.'
    assert list(tmp_path.glob('.registration-recovery-*')) == []
    assert register(pid, jid, p, a) == (1, True)
    assert (view / 'reading-note.md').read_text('utf-8') == 'Existing user annotations.'


def test_changed_manifest_is_preserved_for_manual_reconciliation(tmp_path, monkeypatch):
    _, p, a = prepared(tmp_path, monkeypatch)
    pid, jid = project_job()
    manifest = tmp_path / '2026-10-21' / 'R001' / 'record.json'

    def annotate_manifest():
        saved = json.loads(manifest.read_text('utf-8'))
        saved['user_annotation'] = 'Keep modified manifest.'
        manifest.write_text(json.dumps(saved), 'utf-8')

    fail_first_paper_commit(monkeypatch, annotate_manifest)
    with pytest.raises(RuntimeError, match='Synthetic database commit failure') as exc:
        register(pid, jid, p, a)
    assert json.loads(manifest.read_text('utf-8'))['user_annotation'] == 'Keep modified manifest.'
    assert any('登记恢复未完成' in note for note in exc.value.__notes__)
    assert list(tmp_path.glob('.registration-recovery-*')) == []


def test_ambiguous_commit_error_does_not_move_a_committed_view(tmp_path, monkeypatch):
    _, p, a = prepared(tmp_path, monkeypatch)
    pid, jid = project_job()
    fail_first_paper_commit(monkeypatch, after_commit=True)
    with pytest.raises(RuntimeError, match='Synthetic database commit failure'):
        register(pid, jid, p, a)
    assert (tmp_path / '2026-10-21' / 'R001' / 'record.json').is_file()
    assert list(tmp_path.glob('.registration-recovery-*')) == []
    assert register(pid, jid, p, a) == (1, False)
