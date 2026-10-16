import os
import sys
import tempfile
from pathlib import Path

from cryptography.fernet import Fernet
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
TEST_ROOT = Path(tempfile.mkdtemp(prefix='workbench-tests-'))
os.environ['DATA_DIR'] = str(TEST_ROOT)
os.environ['DATABASE_URL'] = 'sqlite:///' + str(TEST_ROOT / 'test.db')
os.environ['ENCRYPTION_KEY'] = Fernet.generate_key().decode()
os.environ['ADMIN_PASSWORD'] = 'test-admin-password-very-long-123'
os.environ['ALLOWED_ORIGINS'] = 'https://example.github.io'


@pytest.fixture(autouse=True)
def reset_db():
    from app.db import Base, engine, init_db
    Base.metadata.drop_all(engine)
    init_db()
    yield


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from app.main import app, _attempts
    _attempts.clear()
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture
def logged(client):
    token = client.post('/api/login', json={'password': os.environ['ADMIN_PASSWORD']}).json()['token']
    client.headers['Authorization'] = 'Bearer ' + token
    return client

