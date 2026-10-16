import io
import zipfile

from fastapi.testclient import TestClient

from app.bridge import app


def test_bridge_requires_its_own_token(monkeypatch):
    monkeypatch.setenv('NORMAN_BRIDGE_TOKEN','bridge-fixture-token-long-enough-123456789')
    with TestClient(app) as c:
        assert c.get('/health').status_code==401


def test_bridge_rejects_zip_traversal(monkeypatch):
    token='bridge-fixture-token-long-enough-123456789'
    monkeypatch.setenv('NORMAN_BRIDGE_TOKEN',token)
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w') as z:
        z.writestr('../escape.txt','must not be written')
    with TestClient(app) as c:
        r=c.post('/run',headers={'Authorization':'Bearer '+token},data={'operation':'extract'},files={'bundle':('input.zip',stream.getvalue())})
        assert r.status_code==400


def test_bridge_rejects_arbitrary_commands(monkeypatch):
    token='bridge-fixture-token-long-enough-123456789'
    monkeypatch.setenv('NORMAN_BRIDGE_TOKEN',token)
    with TestClient(app) as c:
        r=c.post('/run',headers={'Authorization':'Bearer '+token},data={'operation':'shell'},files={'bundle':('input.zip',b'anything')})
        assert r.status_code==400

