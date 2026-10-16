import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import socket
import time
from urllib.parse import urlparse

import httpx
from cryptography.fernet import Fernet

from .config import MAX_BYTES


def encryption():
    key = os.getenv('ENCRYPTION_KEY', '')
    if not key:
        raise ValueError('ENCRYPTION_KEY 未配置；请先生成 Fernet 密钥')
    return Fernet(key.encode())


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1).hex()
    return salt + ':' + digest


def check_password(password, saved):
    return hmac.compare_digest(password_hash(password, saved.split(':')[0]), saved)


def issue_token():
    expiry = int(time.time()) + 12 * 3600
    body = base64.urlsafe_b64encode(json.dumps({'exp': expiry, 'nonce': secrets.token_hex(16)}).encode()).decode()
    signature = hmac.new(encryption()._signing_key, body.encode(), hashlib.sha256).hexdigest()
    return body + '.' + signature


def valid_token(token):
    try:
        body, sig = token.split('.')
        expected = hmac.new(encryption()._signing_key, body.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, sig) and json.loads(base64.urlsafe_b64decode(body))['exp'] > time.time()
    except (ValueError, KeyError, TypeError):
        return False


def public_url(url):
    """Reject private, local, credentialed and non-HTTPS destinations before any I/O."""
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('仅允许不带凭据的公网 HTTPS 地址（443）')
    for addr in socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM):
        if not ipaddress.ip_address(addr[4][0]).is_global:
            raise ValueError('禁止访问内部地址')
    return url


def safe_request(method, url, **kwargs):
    """Pin public HTTPS destinations for configurable model/bridge endpoints."""
    public_url(url)
    parsed = urlparse(url)
    addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
    if not all(ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('禁止访问内部地址')
    ip = addresses[0][4][0]
    pinned = url.replace('https://' + parsed.netloc, 'https://' + ('[' + ip + ']' if ':' in ip else ip), 1)
    headers = dict(kwargs.pop('headers', {}), Host=parsed.hostname)
    timeout = kwargs.pop('timeout', 180)
    with httpx.Client(timeout=timeout, trust_env=False, follow_redirects=False) as c:
        return c.request(method, pinned, headers=headers, extensions={'sni_hostname': parsed.hostname.encode()}, **kwargs)


def download(url, path):
    """Pin a validated DNS address; follow redirects only after revalidation.

    TLS uses the original server name, preventing DNS rebinding between check/use.
    """
    from urllib.parse import urljoin
    for _ in range(5):
        public_url(url)
        parsed = urlparse(url)
        addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
        ip = addresses[0][4][0]
        if not all(ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise ValueError('禁止访问内部地址')
        pinned = url.replace('https://' + parsed.netloc, 'https://' + ('[' + ip + ']' if ':' in ip else ip), 1)
        try:
            with httpx.Client(timeout=45, follow_redirects=False, trust_env=False) as client:
                with client.stream('GET', pinned, headers={'Host': parsed.hostname, 'User-Agent': 'PaperWorkbench/0.1 (research)'}, extensions={'sni_hostname': parsed.hostname.encode()}) as r:
                    if r.status_code in (301, 302, 303, 307, 308):
                        url = urljoin(url, r.headers['location'])
                        continue
                    r.raise_for_status()
                    size = 0
                    with path.open('wb') as f:
                        for chunk in r.iter_bytes(65536):
                            size += len(chunk)
                            if size > MAX_BYTES:
                                raise ValueError('PDF 超过 50 MB')
                            f.write(chunk)
            if path.read_bytes()[:5] != b'%PDF-':
                raise ValueError('来源返回的不是 PDF')
            return
        except Exception:
            path.unlink(missing_ok=True)
            raise
    raise ValueError('重定向次数过多')

