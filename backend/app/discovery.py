import datetime as dt
import re
import unicodedata

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


def search(query, start_year, config):
    """Each provider can fail independently; return diagnostics, never invent hits."""
    results, errors = [], []
    with httpx.Client(timeout=35, trust_env=False) as c:
        try:
            r = c.get('https://api.crossref.org/works', params={'query.bibliographic': query, 'filter': f'from-pub-date:{start_year}-01-01', 'rows': 40}, headers={'User-Agent': 'PaperWorkbench/0.1 (metadata research)'})
            r.raise_for_status()
            for p in r.json()['message']['items']:
                date = p.get('published-online', p.get('published-print', p.get('published', {}))).get('date-parts', [[None]])[0]
                published = p.get('type') in ('journal-article', 'proceedings-article') and bool(p.get('container-title'))
                relations = [x.get('id', '') for key in ('is-preprint-of', 'has-preprint', 'is-version-of', 'has-version') for x in p.get('relation', {}).get(key, [])]
                results.append({'title': (p.get('title') or [''])[0], 'abstract': re.sub('<[^>]+>', '', p.get('abstract', '')), 'doi': doi(p.get('DOI')), 'authors': [' '.join([x.get('given', ''), x.get('family', '')]).strip() for x in p.get('author', [])], 'year': date[0], 'publication_date': '-'.join(map(str, date)), 'journal': (p.get('container-title') or [''])[0], 'url': p.get('URL', ''), 'pdf_urls': [x['URL'] for x in p.get('link', []) if x.get('content-type') == 'application/pdf'], 'publication_status': 'published' if published else ('preprint' if p.get('type') == 'posted-content' else 'unknown'), 'versions': relations + [doi(p.get('DOI'))], 'source': 'Crossref'})
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
                    inverted = p.get('abstract_inverted_index') or {}
                    words = {i: word for word, indices in inverted.items() for i in indices}
                    abstract = ' '.join(words[i] for i in sorted(words))
                    results.append({'title': p.get('title') or '', 'abstract':abstract, 'doi': doi(p.get('doi')), 'authors': [x['author']['display_name'] for x in p.get('authorships', [])], 'year': p.get('publication_year'), 'publication_date': p.get('publication_date', ''), 'journal': (loc.get('source') or {}).get('display_name', ''), 'url': loc.get('landing_page_url') or p.get('doi') or '', 'pdf_urls': list(dict.fromkeys(x['pdf_url'] for x in p.get('locations', []) if x.get('pdf_url'))), 'publication_status': 'published' if published else ('preprint' if p.get('type') == 'preprint' else 'unknown'), 'versions': [doi(p.get('doi'))], 'source': 'OpenAlex'})
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
