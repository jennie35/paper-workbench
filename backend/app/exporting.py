"""Saved project exports. Never run analysis or read model configuration."""
import html
import json


def clean_export(value):
    """Exclude deployment internals and credentials from all bundle branches."""
    private = {'artifact_dir', 'canonical_artifact_dir', 'api_key', 'openalex_key',
               'password', 'admin_password', 'authorization', 'token', 'encryption_key'}
    if isinstance(value, dict):
        return {key: clean_export(item) for key, item in value.items() if key.lower() not in private}
    if isinstance(value, list):
        return [clean_export(item) for item in value]
    return value


def project_markdown(bundle):
    project = bundle.get('project') or {}
    lines = ['# ' + project.get('name', '研究文献库'),
             '私人导出 · 仅保存已有记录，不触发分析；研究行动均为待执行建议。',
             '## 课题配置', '```json', json.dumps(project, ensure_ascii=False, indent=2), '```',
             '## 已保存的研究报告']
    for paper in bundle.get('papers', []):
        lines.append(f'- [{paper["id"]} {paper.get("title", "")}]({paper["id"]}/reading-note.md)')
    if not bundle.get('papers'):
        lines.append('尚无登记完成的精读记录；候选与草稿不计入完成篇数。')
    lines.extend(['## 参考资料与阅读范围', '```json', json.dumps(bundle.get('references', []), ensure_ascii=False, indent=2), '```'])
    for job in bundle.get('jobs', []):
        lines.extend(['## 批次 ' + job['id'], '```json', json.dumps(job, ensure_ascii=False, indent=2), '```'])
    lines.extend(['## 保存边界', bundle.get('notice', ''),
                  '结构校验通过不等于科学结论得到验证。原始 PDF 不包含于此导出包。'])
    return '\n\n'.join(lines) + '\n'


def offline_index(bundle):
    """Local-file index with four views and filters; no imports, fetch or APIs."""
    esc = lambda value: html.escape(str(value), quote=True)
    project = bundle.get('project') or {}
    papers, jobs = bundle.get('papers', []), bundle.get('jobs', [])
    last = jobs[-1] if jobs else None
    recent_ids = set((last or {}).get('checkpoint', {}).get('completed', []))
    themes = sorted({str(theme) for p in papers for theme in (p.get('themes') or [p.get('theme') or '未分类'])})
    articles = []
    for p in papers:
        a = p.get('analysis') or {}
        logic = a.get('research_logic') or {}
        priorities = logic.get('reading_priorities') or a.get('reading_list') or []
        actions = a.get('actions') or []
        date = str(a.get('analyzed_date') or p.get('analyzed_date') or p.get('created_at') or '')[:10]
        kinds = p.get('themes') or [p.get('theme') or '未分类']
        search = ' '.join([p.get('title', ''), p.get('doi', ''), a.get('summary', ''), ' '.join(kinds)])
        recent = not last or p['id'] in recent_ids or p.get('batch_id') == last['id']
        evidence = ''.join('<li>' + esc(x if isinstance(x, str) else json.dumps(x, ensure_ascii=False)) + '</li>' for x in priorities)
        action_html = ''.join('<section class="action"><h3>' + esc(x.get('id', '') + ' ' + x.get('title', '待执行行动')) + '（待执行）</h3><pre>' + esc(json.dumps(x, ensure_ascii=False, indent=2)) + '</pre></section>' for x in actions)
        articles.append('<article data-record="1" data-search="' + esc(search.lower()) + '" data-date="' + esc(date) + '" data-themes="' + esc('|'.join(kinds)) + '" data-priorities="' + esc('|'.join(str(x.get('priority', '')) for x in actions)) + '" data-recent="' + ('1' if recent else '0') + '" data-evidence="' + ('1' if priorities else '0') + '" data-actions="' + ('1' if actions else '0') + '"><h2><a href="' + esc(p['id']) + '/index.html">' + esc(p['id'] + ' ' + p.get('title', '')) + '</a></h2><p>' + esc(date) + ' · ' + esc(p.get('journal', '')) + ' · ' + esc(a.get('verification_status', '未核验')) + '</p><div class="overview"><p>' + esc(a.get('summary', '总结尚未保存')) + '</p><p><a href="' + esc(p['id']) + '/index.html">打开完整十一节报告、证据与行动</a></p></div><div class="evidence"><h3>精选精读及原因</h3><ul>' + (evidence or '<li>尚无精读位置记录</li>') + '</ul></div><div class="actions">' + action_html + '</div></article>')
    saved = []
    for job in jobs:
        cp = job.get('checkpoint') or {}
        saved.append('<details><summary>批次 ' + esc(job['id']) + ' · ' + esc(job.get('created_at', '')) + ' · ' + esc(job.get('status', '')) + '</summary><p>目标 ' + esc(job.get('requested', '未记录')) + '；完成 ' + esc(cp.get('actual', len(cp.get('completed', [])))) + '；待核验 ' + esc(cp.get('pending_verification', '未记录')) + '；缺额 ' + esc(cp.get('shortfall', '未记录')) + '</p><h3>跨论文综合、候选、检索与缺额原因</h3><pre>' + esc(json.dumps(cp, ensure_ascii=False, indent=2)) + '</pre><h3>保存的候选草稿与阅读范围（不计完成精读）</h3><pre>' + esc(json.dumps(job.get('candidate_records', []), ensure_ascii=False, indent=2)) + '</pre></details>')
    # All dynamic values above are escaped text/attributes. This fixed script
    # only filters existing nodes; it never evaluates saved model/source text.
    script = '''const controls=[...document.querySelectorAll('[data-filter]')];let view='recent';function apply(){const q=document.querySelector('#search').value.toLowerCase(),date=document.querySelector('#date').value,theme=document.querySelector('#theme').value,priority=document.querySelector('#priority').value;let count=0;for(const card of document.querySelectorAll('[data-record]')){const d=card.dataset,show=(!q||d.search.includes(q))&&(!date||d.date===date)&&(!theme||d.themes.split('|').includes(theme))&&(!priority||d.priorities.split('|').includes(priority))&&(view!=='recent'||d.recent==='1')&&(view!=='evidence'||d.evidence==='1')&&(view!=='actions'||d.actions==='1');card.hidden=!show;if(show)count++;}document.body.dataset.view=view;document.querySelector('#count').textContent='当前显示 '+count+' 篇；候选不计入完成精读。';}for(const c of controls)c.addEventListener('input',apply);for(const b of document.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>{view=b.dataset.tab;for(const t of document.querySelectorAll('[data-tab]'))t.setAttribute('aria-pressed',String(t===b));apply();});apply();'''
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src \'self\'; base-uri \'none\'; form-action \'none\'"><title>' + esc(project.get('name', '研究文献库')) + '</title><style>body{max-width:1100px;margin:32px auto;padding:20px;font:16px/1.7 system-ui;color:#183b35;background:#f4f7f5}article,details{padding:20px;margin:18px 0;background:white;border:1px solid #d2ded8;border-radius:12px}input,select,button{font:inherit;padding:8px;margin:5px;max-width:100%}button[aria-pressed=true]{background:#285c49;color:white}pre{white-space:pre-wrap;overflow-wrap:anywhere}body:not([data-view=evidence]) .evidence,body:not([data-view=actions]) .actions,body[data-view=evidence] .overview,body[data-view=actions] .overview{display:none}.action{border-top:1px solid #ddd}[hidden]{display:none!important}a{color:#245d4b}</style></head><body data-view="all"><h1>' + esc(project.get('name', '研究文献库')) + '</h1><p>私人离线导出 · 不联网、不自动调用模型 · 研究行动均为待执行</p><details><summary>课题配置与资料范围</summary><pre>' + esc(json.dumps(project, ensure_ascii=False, indent=2)) + '</pre><h3>参考资料</h3><pre>' + esc(json.dumps(bundle.get('references', []), ensure_ascii=False, indent=2)) + '</pre></details><nav aria-label="研究视图">' + ''.join('<button data-tab="' + name + '" aria-pressed="' + ('true' if name == 'recent' else 'false') + '">' + title + '</button>' for name, title in [('recent', '最近更新'), ('all', '全部文献'), ('evidence', '精选精读'), ('actions', '下一步研究')]) + '</nav><div><input id="search" data-filter placeholder="关键词、题目或 DOI" aria-label="关键词"><input id="date" data-filter type="date" aria-label="分析日期"><select id="theme" data-filter aria-label="主题"><option value="">全部主题</option>' + ''.join('<option>' + esc(x) + '</option>' for x in themes) + '</select><select id="priority" data-filter aria-label="优先级"><option value="">全部优先级</option><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select></div><p id="count">共 ' + str(len(papers)) + ' 篇已登记报告</p>' + ''.join(articles) + ('<p>尚无登记完成的精读记录；请查看保存的候选、草稿与缺额原因。</p>' if not papers else '') + '<h2>保存的批次与跨论文综合</h2>' + ''.join(saved) + '<p>' + esc(bundle.get('notice', '')) + '</p><p><a href="project.md">课题 Markdown</a> · <a href="research.json">完整证据 JSON</a></p><script>' + script + '</script></body></html>'
