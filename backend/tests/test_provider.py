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


@pytest.fixture
def mocked_provider(monkeypatch):
    monkeypatch.setattr('app.provider.public_url', lambda url: url)
    sleeps = []
    monkeypatch.setattr('app.provider.time.sleep', sleeps.append)
    provider = Provider({'base_url': 'https://synthetic-provider.example/v1', 'api_key': 'SYNTHETIC-PRIVATE-KEY', 'text_model': 'text-fixture', 'vision_model': 'vision-fixture'})
    return provider, sleeps


@pytest.mark.parametrize('code', ['insufficient_quota', 'credit_balance_exhausted', 'organization_usage_limit_exceeded', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded'])
@pytest.mark.parametrize('field', ['code', 'type'])
def test_quota_errors_stop_without_retries_and_do_not_echo_response(monkeypatch, mocked_provider, code, field):
    provider, sleeps = mocked_provider
    calls = []
    def quota(*args, **kwargs):
        calls.append(True)
        return httpx.Response(429, json={'error': {field: code, 'message': 'SYNTHETIC-PRIVATE-KEY https://private.example/secret'}})
    monkeypatch.setattr('app.provider.safe_request', quota)
    with pytest.raises(ValueError) as caught:
        provider.json('Synthetic prompt')
    message = str(caught.value)
    assert 'HTTP 429' in message and '额度不足或已达到消费上限' in message
    assert '供应商控制台' in message
    assert 'SYNTHETIC-PRIVATE-KEY' not in message and 'private.example' not in message and code not in message
    assert len(calls) == 1 and sleeps == []


@pytest.mark.parametrize('code', ['rate_limit_exceeded', 'rate_limit_error', 'slow_down'])
@pytest.mark.parametrize('field', ['code', 'type'])
def test_rate_errors_keep_bounded_retries_and_explain_frequency(monkeypatch, mocked_provider, code, field):
    provider, sleeps = mocked_provider
    calls = []
    def limited(*args, **kwargs):
        calls.append(True)
        return httpx.Response(429, json={'error': {field: code, 'message': 'SYNTHETIC-PRIVATE-KEY https://private.example/secret'}})
    monkeypatch.setattr('app.provider.safe_request', limited)
    with pytest.raises(ValueError) as caught:
        provider.json('Synthetic prompt')
    message = str(caught.value)
    assert 'HTTP 429' in message and '频率或 Token 用量超过限制' in message
    assert 'SYNTHETIC-PRIVATE-KEY' not in message and 'private.example' not in message and code not in message
    assert len(calls) == 3 and sleeps == [1, 2]


@pytest.mark.parametrize('body', [
    {'error': {'code': 'UNRECOGNIZED-PRIVATE-CODE', 'message': 'insufficient_quota SYNTHETIC-PRIVATE-KEY https://private.example'}},
    {'error': {'code': ['insufficient_quota'], 'type': {'name': 'rate_limit_error'}}},
    {'error': 'insufficient_quota'}, ['insufficient_quota'], None,
])
def test_unknown_429_does_not_guess_from_message_or_echo_body(monkeypatch, mocked_provider, body):
    provider, sleeps = mocked_provider
    calls = []
    def unknown(*args, **kwargs):
        calls.append(True)
        return httpx.Response(429, json=body)
    monkeypatch.setattr('app.provider.safe_request', unknown)
    with pytest.raises(ValueError) as caught:
        provider.json('Synthetic prompt')
    message = str(caught.value)
    assert '未提供可识别' in message and 'HTTP 429' in message
    assert 'SYNTHETIC-PRIVATE-KEY' not in message and 'private.example' not in message
    assert 'UNRECOGNIZED-PRIVATE-CODE' not in message and 'insufficient_quota' not in message
    assert len(calls) == 3 and sleeps == [1, 2]


def test_non_json_429_is_safe_and_can_recover_after_retry(monkeypatch, mocked_provider):
    provider, sleeps = mocked_provider
    responses = iter([httpx.Response(429, text='SYNTHETIC-PRIVATE-KEY https://private.example'), httpx.Response(200, json={'choices': [{'message': {'content': '{"ok":true}'}}]})])
    monkeypatch.setattr('app.provider.safe_request', lambda *args, **kwargs: next(responses))
    assert provider.json('Synthetic prompt') == {'ok': True}
    assert sleeps == [1]


def test_quota_category_takes_precedence_over_rate_type(monkeypatch, mocked_provider):
    provider, sleeps = mocked_provider
    monkeypatch.setattr('app.provider.safe_request', lambda *args, **kwargs: httpx.Response(429, json={'error': {'code': 'insufficient_quota', 'type': 'rate_limit_error'}}))
    with pytest.raises(ValueError, match='额度不足'):
        provider.json('Synthetic prompt')
    assert sleeps == []


def test_non_429_errors_preserve_generic_diagnostic(monkeypatch, mocked_provider):
    provider, sleeps = mocked_provider
    monkeypatch.setattr('app.provider.safe_request', lambda *args, **kwargs: httpx.Response(401, json={'error': {'code': 'insufficient_quota', 'message': 'SYNTHETIC-PRIVATE-KEY'}}))
    with pytest.raises(ValueError) as caught:
        provider.json('Synthetic prompt')
    assert str(caught.value) == '模型 API 请求失败（HTTP 401），请检查兼容性、配额及配置'
    assert sleeps == []
