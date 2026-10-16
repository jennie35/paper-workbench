import datetime as dt
from contextlib import contextmanager

from sqlalchemy import create_engine, String, Text, Integer, Boolean, ForeignKey, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from .config import DATA, DATABASE_URL

DATA.mkdir(parents=True, exist_ok=True)
engine = create_engine(DATABASE_URL, **({'connect_args': {'check_same_thread': False, 'timeout': 30}} if DATABASE_URL.startswith('sqlite') else {'pool_pre_ping': True}))
Session = sessionmaker(engine, expire_on_commit=False)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


class Base(DeclarativeBase):
    pass


class Setting(Base):
    __tablename__ = 'settings'
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[str] = mapped_column(Text)


class Project(Base):
    __tablename__ = 'projects'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(300))
    goal: Mapped[str] = mapped_column(Text, default='')
    scope: Mapped[str] = mapped_column(Text, default='{}')
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class Reference(Base):
    __tablename__ = 'references'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey('projects.id'))
    filename: Mapped[str] = mapped_column(String(300))
    sha256: Mapped[str] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text)


class Job(Base):
    __tablename__ = 'jobs'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey('projects.id'))
    requested: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(40), default='queued')
    stage: Mapped[str] = mapped_column(String(40), default='检索')
    cancel: Mapped[bool] = mapped_column(Boolean, default=False)
    checkpoint: Mapped[str] = mapped_column(Text, default='{}')
    error: Mapped[str] = mapped_column(Text, default='')
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class Paper(Base):
    __tablename__ = 'papers'
    number: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    identity: Mapped[str] = mapped_column(String(700), unique=True)
    metadata_json: Mapped[str] = mapped_column(Text)
    analysis_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class ProjectPaper(Base):
    __tablename__ = 'project_papers'
    __table_args__ = (UniqueConstraint('project_id', 'paper_number'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey('projects.id'))
    paper_number: Mapped[int] = mapped_column(ForeignKey('papers.number'))
    job_id: Mapped[str] = mapped_column(ForeignKey('jobs.id'))
    analysis_json: Mapped[str] = mapped_column(Text)


@contextmanager
def session():
    with Session() as s:
        try:
            yield s
            s.commit()
        except Exception:
            s.rollback()
            raise


def init_db():
    Base.metadata.create_all(engine)
    with session() as s:
        if not s.get(Setting, 'ledger_counter'):
            s.add(Setting(key='ledger_counter', value='0'))
