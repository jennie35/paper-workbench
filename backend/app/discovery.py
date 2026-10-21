import datetime as dt
import re
import unicodedata
import calendar

import httpx


def doi(value):
    value = re.sub(r'^https?://(?:dx\.)?doi\.org/', '', (value or '').strip(), flags=re.I)
    return re.sub(r'^doi:\s*', '', value, flags=re.I).lower().rstrip(' .')


def title_key(value):
    return ''.join(c for c in unicodedata.normalize('NFKC', value).casefold() if c.isalnum())


def identity(paper):
    return 'doi:' + doi(paper['doi']) if paper.get('doi') else 'title:' + title_key(paper['title'])


def same_paper(a, b):
    da, db = doi(a.get('doi')), doi(b.get('doi'))
    aliases_a = {doi(x) for x in a.get('versions', [])} | {da}
    aliases_b = {doi(x) for x in b.get('versions', [])} | {db}
    if (aliases_a - {''}) & (aliases_b - {''}):
        return True
    if title_key(a['title']) != title_key(b['title']):
        return False
    aa = {title_key(x) for x in a.get('authors', [])}
    ab = {title_key(x) for x in b.get('authors', [])}
    return bool(aa & ab) or not (aa and ab)


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
    results, errors = [], []
    with httpx.Client(timeout=35, trust_env=False) as c:
        try:
            r = c.get('https://api.crossref.org/works', params={'query.bibliographic': query, 'filter': f'from-pub-date:{start_year}-01-01', 'rows': 40}, headers={'User-Agent': 'PaperWorkbench/0.1 (metadata research)'})
            r.raise_for_status()
            for p in r.json()['message']['items']:
                bibliography = crossref_bibliography(p)
                published = p.get('type') in ('journal-article', 'proceedings-article') and bool(p.get('container-title'))
                relations = [x.get('id', '') for key in ('is-preprint-of', 'has-preprint', 'is-version-of', 'has-version') for x in p.get('relation', {}).get(key, [])]
                results.append({'title': (p.get('title') or [''])[0], 'abstract': re.sub('<[^>]+>', '', p.get('abstract', '')), 'doi': doi(p.get('DOI')), 'authors': [' '.join([x.get('given', ''), x.get('family', '')]).strip() for x in p.get('author', [])], **bibliography, 'journal': (p.get('container-title') or [''])[0], 'url': p.get('URL', ''), 'pdf_urls': [x['URL'] for x in p.get('link', []) if x.get('content-type') == 'application/pdf'], 'publication_status': 'published' if published else ('preprint' if p.get('type') == 'posted-content' else 'unknown'), 'versions': relations + [doi(p.get('DOI'))], 'source': 'Crossref'})
        except (httpx.HTTPError, KeyError, TypeError):
            errors.append('Crossref 元数据请求失败或返回不完整')
        key = config.get('openalex_key')
        if key:
            try:
                r = c.get('https://api.openalex.org/works', params={'search': query, 'filter': f'from_publication_date:{start_year}-01-01', 'per-page': 40}, headers={'Authorization': 'Bearer ' + key})
                r.raise_for_status()
                for p in r.json()['results']:
                    loc = p.get('primary_location') or {}
                    published = loc.get('is_published') is True
                    biblio = p.get('biblio') or {}
                    first, last = biblio.get('first_page') or '', biblio.get('last_page') or ''
                    inverted = p.get('abstract_inverted_index') or {}
                    words = {i: word for word, indices in inverted.items() for i in indices}
                    abstract = ' '.join(words[i] for i in sorted(words))
                    results.append({'title': p.get('title') or '', 'abstract':abstract, 'doi': doi(p.get('doi')), 'authors': [x['author']['display_name'] for x in p.get('authorships', [])], 'year': p.get('publication_year'), 'publication_date': p.get('publication_date', ''), 'first_publication_date': '', 'first_publication_date_status': 'unknown', 'publication_date_status': 'source_metadata_not_independently_verified', 'volume': biblio.get('volume') or '', 'issue': biblio.get('issue') or '', 'pages': first + ('–' + last if last and last != first else ''), 'journal': (loc.get('source') or {}).get('display_name', ''), 'url': loc.get('landing_page_url') or p.get('doi') or '', 'pdf_urls': list(dict.fromkeys(x['pdf_url'] for x in p.get('locations', []) if x.get('pdf_url'))), 'publication_status': 'published' if published else ('preprint' if p.get('type') == 'preprint' else 'unknown'), 'versions': [doi(p.get('doi'))], 'source': 'OpenAlex'})
            except (httpx.HTTPError, KeyError, TypeError):
                errors.append('OpenAlex 元数据请求失败或返回不完整')
        else:
            errors.append('OpenAlex 未配置，当前仅使用 Crossref')
    merged = []
    for p in results:
        if not p['title']:
            continue
        existing = next((x for x in merged if same_paper(x, p)), None)
        if existing:
            existing['pdf_urls'] = list(dict.fromkeys(existing['pdf_urls'] + p['pdf_urls']))
            existing['versions'] = list(dict.fromkeys(existing['versions'] + p['versions']))
        else:
            merged.append(p)
    return merged, errors
