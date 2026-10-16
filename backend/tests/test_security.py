import socket
from unittest.mock import patch

import pytest

from app.security import public_url, password_hash, check_password, issue_token, valid_token, safe_request
from app.artifacts import rendered_note, flow_svg


@pytest.mark.parametrize('url',['http://example.com','https://127.0.0.1/a','https://10.0.0.1','https://169.254.169.254','https://[::1]/','file:///etc/passwd','https://user:pass@example.com','https://example.com:8443'])
def test_ssrf_rejected(url):
    with pytest.raises((ValueError,socket.gaierror)):
        public_url(url)


def test_dns_rebinding_rejected():
    values=[[(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',443))],[(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',443))]]
    with patch('app.security.socket.getaddrinfo',side_effect=values):
        with pytest.raises(ValueError,match='内部地址'):
            safe_request('GET','https://example.com/test')


@pytest.mark.parametrize('host,uses_proxy', [('api.openai.com', True), ('example.com', False), ('api.openai.com.example.com', False)])
def test_official_proxy_is_allowlisted_and_other_endpoints_stay_pinned(monkeypatch, host, uses_proxy):
    monkeypatch.setenv('OPENAI_HTTP_PROXY', 'http://127.0.0.1:7890')
    addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))]
    with patch('app.security.socket.getaddrinfo', return_value=addresses), patch('app.security.httpx.Client') as client:
        safe_request('GET', f'https://{host}/v1/models')
        options = client.call_args.kwargs
        assert options['trust_env'] is False and options['follow_redirects'] is False
        assert ('proxy' in options) is uses_proxy
        request = client.return_value.__enter__.return_value.request.call_args
        assert request.args[1] == (f'https://{host}/v1/models' if uses_proxy else 'https://8.8.8.8/v1/models')
        assert request.kwargs['headers']['Host'] == host


def test_proxy_does_not_bypass_private_destination_guard(monkeypatch):
    monkeypatch.setenv('OPENAI_HTTP_PROXY', 'http://127.0.0.1:7890')
    addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]
    with patch('app.security.socket.getaddrinfo', return_value=addresses), patch('app.security.httpx.Client') as client:
        with pytest.raises(ValueError, match='内部地址'):
            safe_request('GET', 'https://api.openai.com/v1/models')
        client.assert_not_called()


def test_password_and_token_tampering():
    saved=password_hash('long-password')
    assert check_password('long-password',saved)
    assert not check_password('wrong',saved)
    token=issue_token()
    assert valid_token(token)
    assert not valid_token(token+'bad')


def test_untrusted_markdown_cannot_execute_html():
    out=rendered_note('<script>alert(1)</script>\n[bad](javascript:alert(1))')
    assert '<script>' not in out
    assert 'href="javascript:' not in out
    svg=flow_svg(['<script>alert(1)</script>','End'])
    assert '<script>' not in svg and '分析者绘制' in svg
    assert '<img' not in rendered_note('![private](https://example.com/collect?secret=private)')
    assert 'assets/page-1.png' in rendered_note('![original](assets/page-1.png)')
