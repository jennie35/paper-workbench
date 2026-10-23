"""Bounded public PDF acquisition and opt-in metered OpenAlex content."""
import datetime as dt
import json
import os
import re
import threading
import socket
import ipaddress
from html.parser import HTMLParser
from urllib.parse import urlencode, urlparse, urljoin

import httpx

from .db import Setting, session
from .security import download, public_url

_budget_lock = threading.RLock()


def read_landing_page(url):
    """Public HTTPS only; revalidate redirects and stop streaming after 1 MiB."""
    limit = 1024 * 1024
    for _ in range(4):
        public_url(url)
        parsed = urlparse(url)
        addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
        if not addresses or not all(ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise ValueError('禁止访问内部地址')
        ip = addresses[0][4][0]
        pinned = parsed._replace(scheme='https', netloc=('[' + ip + ']' if ':' in ip else ip)).geturl()
        with httpx.Client(timeout=15, trust_env=False, follow_redirects=False) as client:
            with client.stream('GET', pinned,
                               headers={'Host': parsed.hostname, 'User-Agent': 'PaperWorkbench/0.2 (public scholarly sources)', 'Accept': 'text/html,application/pdf;q=0.8'},
                               extensions={'sni_hostname': parsed.hostname.encode()}) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    url = urljoin(url, response.headers.get('location', ''))
                    continue
                response.raise_for_status()
                content_type = response.headers.get('content-type', '').lower()
                if 'application/pdf' in content_type:
                    return url, None
                if response.headers.get('content-length', '').isdigit() and int(response.headers['content-length']) > limit:
                    raise ValueError('公开落地页超过读取预算')
                chunks, size = [], 0
                for chunk in response.iter_bytes(65536):
                    size += len(chunk)
                    if size > limit:
                        raise ValueError('公开落地页超过读取预算')
                    chunks.append(chunk)
                body = b''.join(chunks)
                if body.startswith(b'%PDF-'):
                    return url, None
                if content_type and not any(x in content_type for x in ('text/html', 'application/xhtml', 'text/plain')):
                    raise ValueError('公开来源未返回论文网页')
                return url, body.decode(response.encoding or 'utf-8', errors='replace')
    raise ValueError('公开落地页重定向次数过多')


class _PdfLinks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.preferred, self.links = [], []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'meta' and (values.get('name') or values.get('property') or '').lower() in ('citation_pdf_url', 'wkhealth_pdf_url', 'eprints.document_url'):
            if values.get('content'):
                self.preferred.append(values['content'])
        elif tag == 'link' and 'application/pdf' in values.get('type', '').lower() and values.get('href'):
            self.preferred.append(values['href'])
        elif tag == 'a' and values.get('href') and re.search(r'(?:\.pdf(?:[?#]|$)|/article/download/|/pdf(?:[/?#]|$))', values['href'], re.I):
            self.links.append(values['href'])


def landing_pdf_urls(metadata):
    """Use published links, never guess a provider's private download endpoint."""
    pages = list(dict.fromkeys([*(metadata.get('landing_urls') or []), metadata.get('url')]))
    results, notices = [], []
    for page in [x for x in pages if isinstance(x, str) and x][:2]:
        try:
            final_url, html = read_landing_page(page)
            if html is None:
                return [final_url]
            parser = _PdfLinks()
            parser.feed(html)
            for value in [*parser.preferred, *parser.links]:
                url = urljoin(final_url, value)
                if urlparse(url).scheme == 'https' and url not in results:
                    results.append(url)
            if results:
                break
        except Exception:
            notices.append('期刊或机构公开网页暂不可读取')
    if notices:
        metadata['acquisition_diagnostics'] = list(dict.fromkeys([*(metadata.get('acquisition_diagnostics') or []), *notices]))
    return results[:4]


def validate_download(path):
    from pypdf import PdfReader
    if path.stat().st_size > 50 * 1024 * 1024:
        raise ValueError('PDF 超过 50 MB')
    reader = PdfReader(path)
    if reader.is_encrypted or not 1 <= len(reader.pages) <= 300:
        raise ValueError('PDF 已加密或页数不在1–300范围内')


def reserve_content_download(config):
    try:
        limit = min(1000, max(0, int(config.get('openalex_content_daily_limit', os.getenv('OPENALEX_CONTENT_DAILY_LIMIT', '0')))))
    except (ValueError, TypeError):
        limit = 0
    if not limit:
        return False
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    with _budget_lock, session() as s:
        # The ledger row is always present and provides a cross-process lock.
        from sqlalchemy import select
        s.execute(select(Setting).where(Setting.key == 'ledger_counter').with_for_update()).scalar_one()
        row = s.get(Setting, 'openalex_content_usage')
        used = json.loads(row.value) if row else {}
        count = used.get('count', 0) if used.get('date') == today else 0
        if count >= limit:
            return False
        value = json.dumps({'date': today, 'count': count + 1, 'limit': limit})
        if row:
            row.value = value
        else:
            s.add(Setting(key='openalex_content_usage', value=value))
    return True


def acquire_pdf(metadata, path, config):
    diagnostics = []
    attempted = set()

    def try_urls(urls, source):
        for url in list(dict.fromkeys(urls))[:8]:
            if url in attempted:
                continue
            attempted.add(url)
            try:
                download(url, path)
                validate_download(path)
                return {'url': url.split('?', 1)[0], 'source': source, 'diagnostics': diagnostics}
            except Exception:
                path.unlink(missing_ok=True)
                # Neither provider URLs nor exception strings may disclose credentials.
                diagnostics.append('公开全文地址暂不可读取')
        return None

    result = try_urls(metadata.get('pdf_urls') or [], '公开期刊或机构全文')
    if result:
        return result
    discovered = landing_pdf_urls(metadata)
    if discovered:
        metadata['pdf_urls'] = list(dict.fromkeys([*(metadata.get('pdf_urls') or []), *discovered]))
        result = try_urls(discovered, '期刊或机构公开网页中列出的全文')
        if result:
            return result
    metadata['acquisition_diagnostics'] = list(dict.fromkeys([*(metadata.get('acquisition_diagnostics') or []), *diagnostics]))
    content = (metadata.get('content_urls') or {}).get('pdf')
    if not content:
        return None
    match = re.fullmatch(r'https://content\.openalex\.org/works/(W\d+)\.pdf', content)
    if not match or not config.get('openalex_key') or not reserve_content_download(config):
        return None
    try:
        download(content + '?' + urlencode({'api_key': config['openalex_key']}), path)
        validate_download(path)
        return {'url': content, 'source': 'OpenAlex content API（预算内下载）', 'diagnostics': diagnostics}
    except Exception:
        path.unlink(missing_ok=True)
        return None
