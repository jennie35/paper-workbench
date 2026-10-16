"""Production transaction regression; CI supplies a disposable PostgreSQL service."""
import os
from concurrent.futures import ThreadPoolExecutor
import uuid

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from fixtures import metadata, analysis


@pytest.mark.skipif(not os.getenv('PG_CONCURRENCY_URL'),reason='Disposable PostgreSQL service not configured')
def test_concurrent_registration_uses_real_row_lock(monkeypatch):
    import app.db as db
    from app.pipeline import register
    engine=create_engine(os.environ['PG_CONCURRENCY_URL'])
    db.Base.metadata.drop_all(engine)
    db.Base.metadata.create_all(engine)
    monkeypatch.setattr(db,'Session',sessionmaker(engine,expire_on_commit=False))
    pid,jid=str(uuid.uuid4()),str(uuid.uuid4())
    with db.session() as s:
        s.add(db.Setting(key='ledger_counter',value='0'))
        s.add(db.Project(id=pid,name='Concurrent fixture',goal='',scope='{}'))
        s.flush()
        s.add(db.Job(id=jid,project_id=pid,requested=5))
    def record(i):
        return register(pid,jid,metadata('Concurrent title','10.1234/concurrency'),analysis())
    with ThreadPoolExecutor(max_workers=6) as pool:
        results=list(pool.map(record,range(12)))
    assert {number for number,_ in results}=={1}
    assert sum(new for _,new in results)==1
    with db.session() as s:
        assert len(s.scalars(select(db.Paper)).all())==1
        assert len(s.scalars(select(db.ProjectPaper)).all())==1
        assert s.get(db.Setting,'ledger_counter').value=='1'
    engine.dispose()
