"""Bounded public PDF acquisition and opt-in metered OpenAlex content."""
import datetime as dt
import json
import os
import re
import threading
from urllib.parse import urlencode

from .db import Setting, session
from .security import download

_budget_lock = threading.RLock()


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
    for url in list(dict.fromkeys(metadata.get('pdf_urls') or []))[:8]:
        try:
            download(url, path)
            validate_download(path)
            return {'url': url.split('?', 1)[0], 'source': '公开期刊或机构全文', 'diagnostics': diagnostics}
        except Exception:
            path.unlink(missing_ok=True)
            # Neither provider URLs nor exception strings may disclose credentials.
            diagnostics.append('公开全文地址暂不可读取')
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
