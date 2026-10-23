import datetime as dt
import re
import unicodedata
import calendar
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor

import httpx


def doi(value):
    value = re.sub(r'^https?://(?:dx\.)?doi\.org/', '', (value or '').strip(), flags=re.I)
    return re.sub(r'^doi:\s*', '', value, flags=re.I).lower().rstrip(' .')


def title_key(value):
    return ''.join(c for c in unicodedata.normalize('NFKC', value).casefold() if c.isalnum())


def source_ids(paper):
    ids = {**(paper.get('external_ids') or {}), **(paper.get('ids') or {}), **(paper.get('source_ids') or {})}
    if paper.get('openalex_id'):
        ids.setdefault('openalex', paper['openalex_id'])
    if re.match(r'^https://openalex\.org/W\d+$', str(paper.get('source_id') or '')):
        ids.setdefault('openalex', paper['source_id'])
    return ids


def identity(paper):
    if doi(paper.get('doi')):
        return 'doi:' + doi(paper['doi'])
    ids = source_ids(paper)
    for provider in ('openalex', 'pmid', 'pmcid', 'arxiv', 'cnki', 'wanfang', 'vip'):
        if ids.get(provider):
            return 'source:' + provider + ':' + str(ids[provider]).strip().lower()
    if paper.get('identity_token') and not (paper.get('authors') and paper.get('year') and paper.get('journal')):
        return 'incomplete:' + paper['identity_token']
    # Long CJK titles must not overflow a DB unique key. Preserve all identity
    # constituents in metadata; hash the canonical composite, never title alone.
    composite = [title_key(paper.get('title', '')), sorted(title_key(a) for a in paper.get('authors', [])),
                 str(paper.get('year') or ''), title_key(paper.get('journal') or '')]
    return 'bibliography:' + hashlib.sha256(json.dumps(composite, ensure_ascii=False).encode()).hexdigest()


def same_paper(a, b):
    da, db = doi(a.get('doi')), doi(b.get('doi'))
    aliases_a = {doi(x) for x in a.get('versions', [])} | {da}
    aliases_b = {doi(x) for x in b.get('versions', [])} | {db}
    if (aliases_a - {''}) & (aliases_b - {''}):
        return True
    if a.get('identity_token') and a.get('identity_token') == b.get('identity_token'):
        return True
    ia, ib = source_ids(a), source_ids(b)
    if any(str(ia[k]).casefold() == str(ib[k]).casefold() for k in ('openalex', 'pmid', 'pmcid', 'arxiv', 'cnki', 'wanfang', 'vip') if ia.get(k) and ib.get(k)):
        return True
    # Conflicting canonical DOI values are not automatically merged from a
    # similar title. Explicit version aliases above remain supported.
    if da and db and da != db:
        return False
    if title_key(a.get('title', '')) != title_key(b.get('title', '')):
        return False
    if a.get('year') and b.get('year') and str(a['year']) != str(b['year']):
        return False
    if a.get('journal') and b.get('journal') and title_key(a['journal']) != title_key(b['journal']):
        return False
    aa = {title_key(x) for x in a.get('authors', [])}
    ab = {title_key(x) for x in b.get('authors', [])}
    # Incomplete records need review, not title-only identity assignment.
    return bool(aa & ab) if aa or ab else bool(a.get('year') and a.get('journal'))


def imported_candidates(project_id):
    from sqlalchemy import select
    from .db import session, ImportedCandidate
    with session() as s:
        return [dict(json.loads(x.metadata_json), imported_candidate_id=x.id) for x in
                s.scalars(select(ImportedCandidate).where(ImportedCandidate.project_id == project_id, ImportedCandidate.status == 'pending')).all()]


def openalex_paper(p):
    loc = p.get('primary_location') or {}
    biblio = p.get('biblio') or {}
    inverted = p.get('abstract_inverted_index') or {}
    words = {i: word for word, indices in inverted.items() for i in indices}
    first, last = biblio.get('first_page') or '', biblio.get('last_page') or ''
    locations = [x for x in [p.get('best_oa_location'), loc, *(p.get('locations') or [])] if isinstance(x, dict)]
    return {'title': p.get('title') or p.get('display_name') or '', 'abstract': ' '.join(words[i] for i in sorted(words)),
            'doi': doi(p.get('doi')), 'authors': [x.get('author', {}).get('display_name', '') for x in p.get('authorships', [])],
            'year': p.get('publication_year'), 'publication_date': p.get('publication_date', ''), 'first_publication_date': '',
            'first_publication_date_status': 'unknown', 'publication_date_status': 'source_metadata_not_independently_verified',
            'volume': biblio.get('volume') or '', 'issue': biblio.get('issue') or '',
            'pages': first + ('–' + last if last and last != first else ''), 'journal': (loc.get('source') or {}).get('display_name', ''),
            'url': loc.get('landing_page_url') or p.get('doi') or p.get('id') or '',
            'pdf_urls': list(dict.fromkeys(x['pdf_url'] for x in locations if x.get('pdf_url') and x.get('is_oa') is True)),
            'landing_urls': list(dict.fromkeys(x['landing_page_url'] for x in locations if x.get('landing_page_url') and x.get('is_oa') is True)),
            'publication_status': 'preprint' if p.get('type') == 'preprint' else ('published' if any(x.get('is_published') is True or x.get('version') == 'publishedVersion' for x in locations) else 'unknown'),
            'versions': [doi(p.get('doi'))] if p.get('doi') else [], 'source': 'OpenAlex', 'source_ids': p.get('ids') or {'openalex': p.get('id')},
            'openalex_id': p.get('id'), 'language': p.get('language'), 'citation_count': p.get('cited_by_count'),
            'referenced_works': p.get('referenced_works') or [], 'related_works': p.get('related_works') or [],
            'cited_by_api_url': p.get('cited_by_api_url'), 'content_urls': p.get('content_urls') or {},
            'has_content': p.get('has_content') or {}, 'retrieved_at': dt.datetime.now(dt.timezone.utc).isoformat()}


def merge_metadata(existing, incoming):
    """Keep actual abstracts/fulltext clues when Crossref arrives first."""
    for field in ('pdf_urls', 'landing_urls', 'versions', 'referenced_works', 'related_works'):
        existing[field] = list(dict.fromkeys([*(existing.get(field) or []), *(incoming.get(field) or [])]))
    existing['sources'] = list(dict.fromkeys([*(existing.get('sources') or [existing.get('source')]), incoming.get('source')]))
    for field in ('source_ids', 'content_urls', 'has_content'):
        existing[field] = {**(incoming.get(field) or {}), **(existing.get(field) or {})}
    for field in ('abstract', 'openalex_id', 'language', 'citation_count', 'retrieved_at', 'url', 'journal'):
        if incoming.get(field) is not None and (not existing.get(field) or field == 'citation_count'):
            existing[field] = incoming[field]
    if existing.get('publication_status') == 'unknown' and incoming.get('publication_status'):
        existing['publication_status'] = incoming['publication_status']
    return existing


def crossref_paper(p):
    bibliography = crossref_bibliography(p)
    published = p.get('type') in ('journal-article', 'proceedings-article') and bool(p.get('container-title'))
    relations = [x.get('id', '') for key in ('is-preprint-of', 'has-preprint', 'is-version-of', 'has-version') for x in p.get('relation', {}).get(key, [])]
    links = [x.get('URL') for x in p.get('link', []) if x.get('URL') and (x.get('content-type') == 'application/pdf' or re.search(r'\.pdf(?:[?#]|$)', x.get('URL'), re.I))]
    primary = ((p.get('resource') or {}).get('primary') or {}).get('URL')
    return {'title': (p.get('title') or [''])[0], 'abstract': re.sub('<[^>]+>', ' ', p.get('abstract', '')), 'doi': doi(p.get('DOI')),
            'authors': [' '.join([x.get('given', ''), x.get('family', '')]).strip() for x in p.get('author', [])],
            **bibliography, 'journal': (p.get('container-title') or [''])[0], 'url': p.get('URL', ''), 'pdf_urls': links,
            'landing_urls': [primary] if primary else [],
            'publication_status': 'published' if published else ('preprint' if p.get('type') == 'posted-content' else 'unknown'),
            'versions': relations + [doi(p.get('DOI'))], 'source': 'Crossref', 'source_ids': {'doi': doi(p.get('DOI'))},
            'referenced_works': [doi(x.get('DOI')) for x in p.get('reference', []) if x.get('DOI')],
            'citation_count': p.get('is-referenced-by-count'), 'retrieved_at': dt.datetime.now(dt.timezone.utc).isoformat()}


def source_date(parts):
    """Preserve supplied precision; zero-padding never invents a day/month."""
    if not isinstance(parts, list) or not 1 <= len(parts) <= 3 or any(type(v) is not int for v in parts):
        return ''
    try:
        dt.date(parts[0], parts[1] if len(parts) > 1 else 1, parts[2] if len(parts) > 2 else 1)
    except ValueError:
        return ''
    return '-'.join([str(parts[0]).zfill(4), *[str(v).zfill(2) for v in parts[1:]]])


def date_bounds(value):
    bits = list(map(int, value.split('-')))
    year, month = bits[0], bits[1] if len(bits) > 1 else 1
    lower = dt.date(year, month, bits[2] if len(bits) > 2 else 1)
    upper = dt.date(year, bits[1] if len(bits) > 1 else 12,
                    bits[2] if len(bits) > 2 else calendar.monthrange(year, bits[1] if len(bits) > 1 else 12)[1])
    return lower, upper


def crossref_bibliography(p):
    dates = {}
    for key in ('published-online', 'published-print', 'published'):
        obj = p.get(key) or {}
        parts = obj.get('date-parts') or []
        value = source_date(parts[0]) if parts and isinstance(parts[0], list) else ''
        if value:
            dates[key] = value
    distinct = set(dates.values())
    earliest = next((v for v in distinct if all(v == other or date_bounds(v)[1] < date_bounds(other)[0] for other in distinct)), '')
    known = earliest or dates.get('published-online') or dates.get('published-print') or dates.get('published') or ''
    issue_year = int(dates['published-print'][:4]) if dates.get('published-print') else None
    return {'publication_date': known, 'first_publication_date': earliest,
            'first_publication_date_status': 'earliest_source_record' if earliest else 'unknown',
            'publication_date_status': 'source_metadata_not_independently_verified',
            'publication_date_precision': {1: 'year', 2: 'month', 3: 'day'}.get(len(known.split('-'))) if known else 'unknown',
            'publication_dates': dates, 'online_date': dates.get('published-online', ''), 'print_date': dates.get('published-print', ''),
            'year': issue_year or (int(known[:4]) if known else None), 'issue_year': issue_year,
            'volume': p.get('volume') or '', 'issue': p.get('issue') or '', 'pages': p.get('page') or '',
            'article_number': p.get('article-number') or ''}


def search(query, start_year, config):
    """Each provider can fail independently; return diagnostics, never invent hits."""
    def crossref():
        with httpx.Client(timeout=25, trust_env=False) as c:
            try:
                r = c.get('https://api.crossref.org/works', params={'query.bibliographic': query, 'filter': f'from-pub-date:{start_year}-01-01', 'rows': 40}, headers={'User-Agent': 'PaperWorkbench/0.1 (metadata research)'})
                r.raise_for_status()
                return [crossref_paper(p) for p in r.json()['message']['items']], []
            except (httpx.HTTPError, KeyError, TypeError, ValueError):
                return [], ['Crossref 元数据请求失败或返回不完整']

    def openalex():
        key = config.get('openalex_key')
        # Basic public queries are available without an API key. A key is only
        # sent to this fixed source host, never to publishers or model endpoints.
        with httpx.Client(timeout=25, trust_env=False) as c:
            try:
                headers = {'Authorization': 'Bearer ' + key} if key else {}
                r = c.get('https://api.openalex.org/works', params={'search': query, 'filter': f'from_publication_date:{start_year}-01-01', 'per-page': 40}, headers=headers)
                if r.status_code in (401, 403):
                    return [], ['OpenAlex 访问受限；可配置有效密钥，Crossref 检索仍继续']
                if r.status_code == 429:
                    return [], ['OpenAlex 请求额度或频率受限；稍后重试或配置自己的密钥']
                r.raise_for_status()
                return [openalex_paper(p) for p in r.json()['results']], []
            except (httpx.HTTPError, KeyError, TypeError, ValueError):
                return [], ['OpenAlex 元数据请求失败或返回不完整']

    # One request per provider; parallelism never violates Crossref's public
    # pool concurrency=1. Sources cannot receive the model API credentials.
    results, errors = [], []
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(fn) for fn in (crossref, openalex)]
        for future in futures:
            found, diagnostics = future.result()
            results.extend(found)
            errors.extend(diagnostics)
    merged = []
    for p in results:
        if not p['title']:
            continue
        existing = next((x for x in merged if same_paper(x, p)), None)
        if existing:
            merge_metadata(existing, p)
        else:
            merged.append(p)
    return merged, errors
