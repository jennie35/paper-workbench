import httpx
import pytest

from app.provider import Provider
from app.pipeline import safe_error


@pytest.mark.parametrize('error,label', [(httpx.ConnectTimeout, '连接超时'), (httpx.ConnectError, '连接失败'), (httpx.ReadTimeout, '响应超时')])
def test_network_errors_identify_model_service_without_exposing_secrets(monkeypatch, error, label):
    monkeypatch.setattr('app.provider.public_url', lambda url: url)
    def fail(*args, **kwargs):
        raise error('Bearer sk-test-secret https://private.example/query')
    monkeypatch.setattr('app.provider.safe_request', fail)
    provider = Provider({'base_url': 'https://api.openai.com/v1', 'api_key': 'sk-test-secret', 'text_model': 'test', 'vision_model': 'test'})
    with pytest.raises(ValueError) as caught:
        provider.json('Test')
    message = safe_error(caught.value)
    assert '模型 API' in message and label in message
    assert 'sk-test-secret' not in message and 'private.example' not in message
