#!/usr/bin/env python3
"""Local research-library bookkeeping and offline rendering; no network or model calls.

This program validates file structure, never scientific truth. It accepts assistant-
supplied metadata.json and preserves reading-note.md/evidence.json without rewriting.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import html
import json
import os
from pathlib import Path
import re
import sys
import unicodedata
from urllib.parse import quote, urlsplit, unquote

FORMAT = "research-literature-assistant-v1"
MARKER = ".research-workspace.json"
MANIFEST = "ledger.json"
CONFIG = "project.json"
LOCK = ".research-workspace.lock"
ALLOWED_CONFIG = {
    "project_name", "research_question", "research_stage", "research_object",
    "application_context", "existing_methods", "known_resources", "constraints",
    "reference_materials", "version_differences", "keywords_zh", "keywords_en",
    "include", "exclude", "default_count", "storage_root", "output_language", "run_mode",
}


class WorkspaceError(ValueError):
    pass


class RecoveryConflict(WorkspaceError):
    """A foreign change must be preserved rather than rolled back or adopted."""


_UNSPECIFIED = object()


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise WorkspaceError(f"Cannot read JSON: {path.name}: {exc}") from exc


def digest(data):
    return hashlib.sha256(data).hexdigest()


def root_path(value):
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise WorkspaceError("--root must be an absolute path")
    # Refuse symlink roots instead of silently adopting another user's directory.
    if path.is_symlink():
        raise WorkspaceError("The workspace root must not be a symlink")
    return path.resolve()


def within(root, relative, must_exist=True):
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise WorkspaceError("Expected a nonempty relative POSIX path")
    parts = relative.split("/")
    if any(part in {"", ".", ".."} or ":" in part for part in parts):
        raise WorkspaceError("Unsafe relative path")
    target = root.joinpath(*parts)
    if any(root.joinpath(*parts[:i]).is_symlink() for i in range(1, len(parts) + 1)):
        raise WorkspaceError("Symlink resources are not supported")
    if not target.resolve().is_relative_to(root):
        raise WorkspaceError("Path escapes the workspace")
    if must_exist and not target.exists():
        raise WorkspaceError(f"Missing workspace resource: {relative}")
    return target


def atomic_write(path, data, expected=_UNSPECIFIED):
    if path.is_symlink():
        raise RecoveryConflict(f"Refusing symlink control file: {path.name}")
    tmp = path.with_name(path.name + ".pending")
    if tmp.exists() or tmp.is_symlink():
        raise WorkspaceError(f"Pending file exists; inspect before recovery: {tmp.name}")
    try:
        with tmp.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if path.is_symlink():
            raise RecoveryConflict(f"Control file became a symlink: {path.name}")
        current = path.read_bytes() if path.exists() else None
        if expected is not _UNSPECIFIED and current != expected:
            raise RecoveryConflict(f"Concurrent change to {path.name}; foreign file preserved, inspect recovery manually")
        os.replace(tmp, path)
    finally:
        if tmp.exists() and not tmp.is_symlink() and tmp.read_bytes() == data:
            tmp.unlink()


@contextlib.contextmanager
def locked(root):
    path = root / LOCK
    try:
        stream = path.open("x", encoding="utf-8")
    except FileExistsError as exc:
        raise WorkspaceError("Workspace is locked; do not delete a live lock. Inspect the recorded PID after a crash.") from exc
    try:
        with stream:
            stream.write(json.dumps({"pid": os.getpid(), "started_at": now()}))
        yield
    finally:
        path.unlink(missing_ok=True)


def validate_config(config, root):
    if not isinstance(config, dict):
        raise WorkspaceError("Configuration must be a JSON object")
    unknown = set(config) - ALLOWED_CONFIG
    if unknown:
        raise WorkspaceError("Unsupported configuration fields: " + ", ".join(sorted(unknown)))
    for key in ("project_name", "research_question"):
        value = config.get(key)
        if not isinstance(value, str) or not value.strip() or value.strip().startswith("[填写"):
            raise WorkspaceError(f"Configure {key} before initializing")
    target = config.get("default_count", 5)
    if isinstance(target, bool) or not isinstance(target, int) or not 1 <= target <= 20:
        raise WorkspaceError("default_count must be an integer from 1 to 20")
    if config.get("run_mode", "manual") not in {"manual", "existing-task"}:
        raise WorkspaceError("run_mode must be manual or existing-task (neither creates a scheduled task)")
    declared = config.get("storage_root")
    if declared and root_path(declared) != root:
        raise WorkspaceError("storage_root does not match --root")
    return {**config, "storage_root": str(root), "default_count": target,
            "output_language": config.get("output_language", "zh-CN"),
            "run_mode": config.get("run_mode", "manual")}


def norm_doi(value):
    value = unquote(str(value or "")).strip().casefold()
    value = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value)
    return value.rstrip(" .;,/") if re.match(r"^10\.\d{4,9}/\S+$", value) else ""


def norm_text(value):
    text = unicodedata.normalize("NFKC", str(value)).casefold()
    return "".join(char for char in text if char.isalnum())


def metadata_keys(meta):
    keys = set()
    for value in [meta.get("doi"), *meta.get("related_dois", [])]:
        doi = norm_doi(value)
        if doi:
            keys.add("doi:" + doi)
    authors = meta.get("authors") or []
    authors = authors if isinstance(authors, list) else [authors]
    author_key = "|".join(norm_text(item) for item in authors if str(item).strip())
    if meta.get("title") and author_key and meta.get("year"):
        keys.add("title:" + norm_text(meta["title"]) + "|" + author_key + "|" + str(meta["year"]))
    return keys


def validate_metadata(meta):
    if not isinstance(meta, dict) or not isinstance(meta.get("title"), str) or not meta["title"].strip():
        raise WorkspaceError("metadata.json needs a nonempty title")
    if meta.get("reading_status") not in {"complete", "partial", "candidate"}:
        raise WorkspaceError("metadata.json reading_status must explicitly be complete, partial, or candidate")
    for key in ("related_dois", "themes"):
        if key in meta and not isinstance(meta[key], list):
            raise WorkspaceError(f"metadata.json {key} must be an array")
    if "authors" in meta and not isinstance(meta["authors"], (list, str)):
        raise WorkspaceError("metadata.json authors must be an array or string")
    if meta.get("doi") and not norm_doi(meta["doi"]):
        raise WorkspaceError("Invalid DOI; leave unknown DOI empty rather than inventing one")
    return meta


def load_workspace(root):
    marker = read_json(within(root, MARKER))
    if not isinstance(marker, dict) or marker.get("format") != FORMAT:
        raise WorkspaceError("Not a managed research workspace; do not adopt or overwrite an existing ledger")
    config = validate_config(read_json(within(root, CONFIG)), root)
    ledger = read_json(within(root, MANIFEST))
    if not isinstance(ledger, dict) or ledger.get("format") != FORMAT or not isinstance(ledger.get("records"), list):
        raise WorkspaceError("Invalid managed ledger")
    ids = set()
    largest = 0
    for item in ledger["records"]:
        if not isinstance(item, dict) or not re.fullmatch(r"R\d{3,}", item.get("id", "")):
            raise WorkspaceError("Invalid continuous record ID")
        if item["id"] in ids:
            raise WorkspaceError("Duplicate record ID")
        ids.add(item["id"])
        largest = max(largest, int(item["id"][1:]))
        validate_metadata(item.get("metadata"))
        folder = within(root, item.get("path"))
        if folder.name != item["id"]:
            raise WorkspaceError("Record directory and record ID differ")
        for filename in ("reading-note.md", "evidence.json", "metadata.json"):
            within(root, item["path"] + "/" + filename)
        # Manual revisions keep their directory and ID. Refresh the ledger's cached
        # metadata only when a later successful build/register commits it.
        item["metadata"] = validate_metadata(read_json(folder / "metadata.json"))
    if ledger.get("next_number") != largest + 1 or ids != {f"R{i:03d}" for i in range(1, largest + 1)}:
        raise WorkspaceError("Ledger sequence is inconsistent; preserve IDs and inspect manually")
    return config, ledger


def safe_url(value):
    value = str(value or "")
    parsed = urlsplit(value)
    return value if parsed.scheme in {"http", "https"} and parsed.netloc and not parsed.username else ""


def esc(value):
    return html.escape(str(value), quote=True)


def href(path):
    return quote(path, safe="/-._~")


def actions_from(evidence):
    if not isinstance(evidence, dict):
        return []
    logic = evidence.get("research_logic")
    actions = evidence.get("actions", (logic if isinstance(logic, dict) else {}).get("actions", []))
    return actions if isinstance(actions, list) else []


def validate_evidence(root, base, evidence):
    if not isinstance(evidence, dict):
        raise WorkspaceError("evidence.json must be a JSON object; its contents are not executed")
    images = evidence.get("original_images", [])
    if not isinstance(images, list):
        raise WorkspaceError("original_images must be an array when provided")
    for image in images:
        if not isinstance(image, dict) or not isinstance(image.get("path"), str):
            raise WorkspaceError("Each original_images entry needs a local relative path")
        target = within(root, base + "/" + image["path"])
        if not target.is_file():
            raise WorkspaceError("Original image path is not a file")
    return evidence


def render_action(action):
    if not isinstance(action, dict):
        return "<li>" + esc(action) + " · 待执行</li>"
    name = action.get("title") or action.get("question") or action.get("hypothesis") or "待明确行动"
    action = {**action, "evidence_gap": action.get("evidence_gap") or action.get("gap"),
              "criteria": action.get("criteria") or action.get("decision_rule")}
    fields = [("证据缺口", "evidence_gap"), ("待回答问题", "question"), ("假设", "hypothesis"), ("方法", "method"),
              ("实验单位", "experimental_unit"), ("数据", "data"), ("对照", "controls"),
              ("混杂控制", "confounds"), ("支持方向", "supporting"), ("削弱方向", "weakening"),
              ("判断依据", "criteria"), ("资源", "resources"),
              ("前置条件", "prerequisites"), ("交付成果", "deliverable"),
              ("停止条件", "stopping_criteria"), ("样本量依据", "sample_size_basis")]
    detail = "".join(f"<dt>{label}</dt><dd>{esc(action[key])}</dd>" for label, key in fields if action.get(key))
    return f'<li><strong>{esc(name)}</strong> <span class="badge">待执行 · {esc(action.get("priority", "未指定优先级"))}</span><dl>{detail}</dl></li>'


def render_runs(root):
    """Display supplied batch documents verbatim as escaped text, never synthesize."""
    runs = root / "runs"
    if not runs.exists():
        return ""
    within(root, "runs")
    if not runs.is_dir():
        raise WorkspaceError("runs must be a local directory")
    blocks = []
    for run in sorted(runs.iterdir(), reverse=True):
        within(root, run.relative_to(root).as_posix())
        if not run.is_dir():
            continue
        files = []
        for filename, label in (("synthesis.md", "跨论文综合"), ("brief.md", "当次简报"), ("search-log.json", "检索与筛选记录")):
            path = run / filename
            if not path.exists():
                continue
            relative = path.relative_to(root).as_posix()
            within(root, relative)
            if not path.is_file():
                raise WorkspaceError("Saved batch document must be a local file")
            text = path.read_text(encoding="utf-8-sig")
            files.append(f'<details><summary>{label}</summary><p><a href="{href(relative)}">打开保存文件</a></p><pre>{esc(text)}</pre></details>')
        if files:
            blocks.append(f'<section class="run"><h3>{esc(run.name)}</h3>{"".join(files)}</section>')
    return ('<section aria-label="批次综合与简报"><h2>跨论文综合与当次简报</h2><p>下列内容来自已保存的批次资料；本地构建工具只展示，不生成或核验研究结论。</p>' + "".join(blocks) + "</section>") if blocks else ""


def record_sort_key(record):
    meta = record["metadata"]
    for value in (meta.get("updated_at"), meta.get("analysis_date"), record.get("added_at")):
        if not isinstance(value, str):
            continue
        try:
            stamp = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=dt.timezone.utc)
            return stamp.timestamp(), int(record["id"][1:])
        except (ValueError, OverflowError, OSError):
            continue
    return float("-inf"), int(record["id"][1:])


def render(root, config, ledger):
    articles = []
    for record in sorted(ledger["records"], key=record_sort_key, reverse=True):
        meta = record["metadata"]
        base = record["path"]
        folder = within(root, base)
        text = (folder / "reading-note.md").read_text(encoding="utf-8-sig")
        evidence = validate_evidence(root, base, read_json(folder / "evidence.json"))
        authors = meta.get("authors", [])
        authors = " · ".join(str(item) for item in authors) if isinstance(authors, list) else str(authors)
        themes = ", ".join(str(item) for item in meta.get("themes", []))
        priorities = {str(item.get("priority", "")) for item in actions_from(evidence) if isinstance(item, dict)}
        search = " ".join([record["id"], meta["title"], authors, themes, text])
        source_links = []
        for sub in ("source", "assets"):
            directory = folder / sub
            if directory.exists():
                for file in sorted(directory.rglob("*")):
                    rel = file.relative_to(root).as_posix()
                    within(root, rel)
                    if file.is_file():
                        source_links.append(f'<li><a href="{href(rel)}">{esc(file.relative_to(folder).as_posix())}</a></li>')
        external = safe_url(meta.get("url"))
        if not external and norm_doi(meta.get("doi")):
            external = "https://doi.org/" + norm_doi(meta["doi"])
        source = f'<a href="{esc(external)}" rel="noreferrer">原文</a>' if external else "原文链接未提供"
        original = []
        for image in evidence.get("original_images", []):
            if not isinstance(image, dict) or not image.get("path"):
                continue
            image_path = base + "/" + str(image["path"])
            within(root, image_path)
            original.append(f'<figure><a href="{href(image_path)}"><img loading="lazy" src="{href(image_path)}" alt="{esc(image.get("caption", "来源图像"))}"></a><figcaption>{esc(image.get("caption", ""))} · {esc(image.get("verification_status", "未核验"))}（按保存记录显示；图片存在不代表已目视核验）</figcaption></figure>')
        logic = evidence.get("research_logic")
        reading = evidence.get("reading_priorities", (logic if isinstance(logic, dict) else {}).get("reading_priorities", []))
        selected = "".join("<li>" + esc(item) + "</li>" for item in reading) if isinstance(reading, list) else ""
        date = str(meta.get("analysis_date") or record["added_at"][:10])
        reader_link = ""
        if (folder / "reader.html").exists():
            reader_path = base + "/reader.html"
            if not within(root, reader_path).is_file():
                raise WorkspaceError("reader.html must be a local file")
            reader_link = f'<a href="{href(reader_path)}">排版阅读页</a> · '
        articles.append(f'''<article data-search="{esc(search.casefold())}" data-date="{esc(date)}" data-theme="{esc(themes.casefold())}" data-priority="{esc(' '.join(priorities))}" data-selected="{'yes' if selected else 'no'}">
<header><span class="badge">{esc(record['id'])} · {esc(meta['reading_status'])}</span><span>{esc(date)} · {esc(themes)}</span><h2>{esc(meta['title'])}</h2><p>{esc(authors)} · {esc(meta.get('year', '年份未核实'))} · {source}</p></header>
<div class="reading"><p class="files">{reader_link}<a href="{href(base + '/reading-note.md')}">阅读笔记</a> · <a href="{href(base + '/evidence.json')}">证据 JSON</a> · <a href="{href(base + '/metadata.json')}">题录与阅读状态</a></p><details><summary>展开完整阅读报告</summary><pre>{esc(text)}</pre></details>{''.join(original)}<details><summary>来源与图像文件</summary><ul>{''.join(source_links) or '<li>未保存来源文件</li>'}</ul></details></div>
<section class="selected"><h3>需要重点精读的证据</h3><ul>{selected or '<li>未记录具体精读位置</li>'}</ul></section><section class="actions"><h3>下一步研究</h3><ul>{''.join(render_action(action) for action in actions_from(evidence)) or '<li>尚未记录行动卡</li>'}</ul></section></article>''')
    complete = sum(item["metadata"]["reading_status"] == "complete" for item in ledger["records"])
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: file:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>{esc(config['project_name'])} · 文献研究</title><style>
:root{{color-scheme:light;font:16px/1.65 system-ui,sans-serif;color:#20312e;background:#f3f5f2}}body{{max-width:1100px;margin:auto;padding:28px}}h1{{font-size:2rem;line-height:1.2}}h2{{font-size:1.35rem}}header p{{color:#5b6863}}nav,.filters{{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}}button,input,select{{font:inherit;border:1px solid #c5d1ca;border-radius:8px;padding:8px 12px;background:white}}button[aria-pressed=true]{{background:#215f4b;color:white}}input[type=search]{{flex:1;min-width:180px}}article{{border:1px solid #d9e0da;border-radius:14px;background:white;padding:22px;margin:16px 0}}.badge{{font-size:.8rem;background:#e5eee7;padding:3px 7px;border-radius:5px}}article header>span+span{{margin-left:10px;font-size:.85rem}}a{{color:#145d70}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}}summary{{cursor:pointer}}img{{max-width:100%;max-height:650px}}dl{{display:grid;grid-template-columns:7em 1fr}}dd{{margin:0}}.selected,.actions{{display:none}}body[data-view=evidence] .selected,body[data-view=actions] .actions{{display:block}}body[data-view=evidence] .reading,body[data-view=actions] .reading{{display:none}}[hidden]{{display:none!important}}footer{{font-size:.85rem;color:#61706a}}@media(max-width:600px){{body{{padding:14px}}article{{padding:15px}}dl{{display:block}}}}
</style></head><body data-view="recent"><header><p>可追溯的阅读 · 有边界的推断 · 可检验的行动</p><h1>{esc(config['project_name'])}</h1><p>{esc(config['research_question'])}</p><p>累计登记 {len(ledger['records'])} 篇；按人工保存状态，完成阅读 {complete} 篇。结构检查不等于科学结论得到验证。</p></header>
{render_runs(root)}<nav aria-label="研究视图"><button data-view="recent" aria-pressed="true">最近更新</button><button data-view="all" aria-pressed="false">全部文献</button><button data-view="evidence" aria-pressed="false">精选精读</button><button data-view="actions" aria-pressed="false">下一步研究</button></nav><div class="filters"><input type="search" id="q" placeholder="关键词、作者、编号" aria-label="关键词"><input type="date" id="from" aria-label="起始日期"><input type="date" id="to" aria-label="结束日期"><input id="theme" placeholder="主题" aria-label="主题"><select id="priority" aria-label="优先级"><option value="">全部优先级</option><option>P0</option><option>P1</option><option>P2</option><option>高</option><option>中</option><option>低</option></select></div><p id="count" aria-live="polite"></p><main>{''.join(articles)}</main><p id="empty" hidden>没有符合条件的文献。</p><footer>本页由本地记录构建，无网络检索、模型调用或自动执行。原文链接由你点击打开。完整内容以 reading-note.md 与 evidence.json 为准。最近更新显示最多 20 条，全部文献不限制条数。更新：{esc(ledger.get('updated_at', ''))}</footer>
<script>(()=>{{'use strict';const fields=['q','from','to','theme','priority'].map(id=>document.getElementById(id));const cards=[...document.querySelectorAll('article')];let view='recent';function filter(){{const [q,from,to,theme,priority]=fields.map(el=>el.value.trim().toLowerCase());let shown=0;for(const card of cards){{const d=card.dataset;const match=(!q||d.search.includes(q))&&(!from||d.date>=from)&&(!to||d.date<=to)&&(!theme||d.theme.includes(theme))&&(!priority||d.priority.toLowerCase().split(' ').includes(priority))&&(view!=='evidence'||d.selected==='yes');card.hidden=!match||(view==='recent'&&shown>=20);if(!card.hidden)shown++;}}document.getElementById('count').textContent='当前显示 '+shown+' 篇';document.getElementById('empty').hidden=shown>0;}}for(const field of fields)field.addEventListener('input',filter);for(const button of document.querySelectorAll('button[data-view]'))button.addEventListener('click',()=>{{view=button.dataset.view;document.body.dataset.view=view;for(const item of document.querySelectorAll('button[data-view]'))item.setAttribute('aria-pressed',String(item===button));filter();}});filter();}})();</script></body></html>'''.encode("utf-8")


def publish(root, ledger, page, base_ledger=None):
    """Replace the generated page and commit ledger last, rolling back own writes."""
    index = within(root, "index.html", must_exist=False)
    old_page = index.read_bytes() if index.exists() else None
    ledger_path = within(root, MANIFEST)
    old_ledger = ledger_path.read_bytes()
    if base_ledger is not None and old_ledger != base_ledger:
        raise RecoveryConflict("Ledger changed after loading; foreign ledger preserved, inspect recovery manually")
    old = json.loads(old_ledger.decode("utf-8-sig"))
    expected = old.get("dashboard_sha256")
    if old_page is not None and (not expected or digest(old_page) != expected):
        raise WorkspaceError("index.html has user edits or is unregistered; preserve it and resolve manually")
    ledger = {**ledger, "dashboard_sha256": digest(page)}
    intended_ledger = json_bytes(ledger)
    page_written = False
    try:
        atomic_write(index, page, expected=old_page)
        page_written = True
        atomic_write(ledger_path, intended_ledger, expected=old_ledger)
    except Exception as exc:
        # Check ownership BEFORE rollback. A process that ignores our lock can
        # change either file; preserve that change and the new paper directory.
        if ledger_path.is_symlink() or index.is_symlink():
            raise RecoveryConflict("Control file changed to a symlink; preserve files and inspect recovery manually") from exc
        current_ledger = ledger_path.read_bytes() if ledger_path.exists() else None
        current_page = index.read_bytes() if index.exists() else None
        if current_ledger not in (old_ledger, intended_ledger):
            raise RecoveryConflict("Foreign ledger changed during publication; it was preserved. Inspect page, ledger and staged/new record before recovery") from exc
        if page_written and current_page not in (old_page, page):
            raise RecoveryConflict("Foreign dashboard changed during publication; it was preserved. Inspect ledger and staged/new record before recovery") from exc
        if current_ledger == intended_ledger and current_ledger != old_ledger:
            atomic_write(ledger_path, old_ledger, expected=intended_ledger)
        if page_written and current_page == page:
            if old_page is None:
                index.unlink()
            else:
                atomic_write(index, old_page, expected=page)
        raise
    return ledger


def initialize(root, config_file):
    config = validate_config(read_json(Path(config_file)), root)
    if root.exists() and any(root.iterdir()):
        raise WorkspaceError("init requires an empty directory; never initialize over an existing master ledger or dashboard")
    root.mkdir(parents=True, exist_ok=True)
    with locked(root):
        atomic_write(root / MARKER, json_bytes({"format": FORMAT, "created_at": now()}))
        atomic_write(root / CONFIG, json_bytes(config))
        ledger = {"format": FORMAT, "next_number": 1, "updated_at": now(), "records": []}
        atomic_write(root / MANIFEST, json_bytes(ledger))
        (root / ".staging").mkdir()
        publish(root, ledger, render(root, config, ledger))
    return {"root": str(root), "records": 0, "message": "Initialized an empty local library; no papers retrieved."}


def check(root):
    config, ledger = load_workspace(root)
    missing = []
    for item in ledger["records"]:
        evidence = validate_evidence(root, item["path"], read_json(within(root, item["path"] + "/evidence.json")))
        if not any(evidence.get(key) for key in ("sources", "source_map", "source_blocks", "reading_scope")):
            missing.append(item["id"] + ": evidence source locations/read scope need manual review")
    expected = ledger.get("dashboard_sha256")
    render_runs(root)  # Check saved-document containment without modifying files.
    if expected and digest(within(root, "index.html").read_bytes()) != expected:
        missing.append("index.html differs from its generated hash; build will preserve user edits and stop")
    return {"root": str(root), "project_name": config["project_name"], "records": len(ledger["records"]),
            "complete_readings": sum(item["metadata"]["reading_status"] == "complete" for item in ledger["records"]),
            "next_id": f"R{ledger['next_number']:03d}", "warnings": missing,
            "scope": "Structural checks only; no scientific, visual, skill-application or source-authenticity verification."}


def build(root):
    with locked(root):
        base_ledger = within(root, MANIFEST).read_bytes()
        config, ledger = load_workspace(root)
        ledger = {**ledger, "updated_at": now()}
        publish(root, ledger, render(root, config, ledger), base_ledger=base_ledger)
    return {"root": str(root), "dashboard": str(root / "index.html"), "records": len(ledger["records"])}


def register(root, draft):
    with locked(root):
        base_ledger = within(root, MANIFEST).read_bytes()
        config, ledger = load_workspace(root)
        staging = within(root, ".staging")
        draft = Path(draft)
        if not draft.is_absolute():
            draft = root / draft
        if draft.is_symlink() or not draft.resolve().is_relative_to(staging.resolve()) or draft.resolve() == staging.resolve():
            raise WorkspaceError("--draft must be a directory strictly inside this root's .staging")
        draft = within(root, draft.resolve().relative_to(root).as_posix())
        if not draft.is_dir():
            raise WorkspaceError("Draft must be a directory")
        for entry in draft.rglob("*"):
            within(root, entry.relative_to(root).as_posix())
        meta = validate_metadata(read_json(draft / "metadata.json"))
        if not (draft / "reading-note.md").is_file() or not isinstance(read_json(draft / "evidence.json"), dict):
            raise WorkspaceError("Draft requires reading-note.md and an object evidence.json")
        wanted = metadata_keys(meta)
        version_of = str(meta.get("version_of", ""))
        for item in ledger["records"]:
            if wanted.intersection(metadata_keys(item["metadata"])) or version_of == item["id"] or (norm_doi(version_of) and "doi:" + norm_doi(version_of) in metadata_keys(item["metadata"])):
                return {"id": item["id"], "new": False, "draft_preserved": str(draft), "message": "Duplicate/version relationship; revise existing record manually with history, preserving its ID."}
        record_id = f"R{ledger['next_number']:03d}"
        date = dt.date.today().isoformat()
        parent = within(root, date, must_exist=False)
        parent.mkdir(exist_ok=True)
        destination = parent / record_id
        if destination.exists():
            raise WorkspaceError("Record directory already exists; do not overwrite it")
        entry = {"id": record_id, "path": date + "/" + record_id, "added_at": now(), "metadata": meta}
        updated = {**ledger, "records": [*ledger["records"], entry], "next_number": ledger["next_number"] + 1, "updated_at": now()}
        # A same-filesystem rename avoids duplicating PDFs/images. On failure move it back.
        os.replace(draft, destination)
        try:
            publish(root, updated, render(root, config, updated), base_ledger=base_ledger)
        except RecoveryConflict as exc:
            # A foreign ledger/page may now reference the moved record. Keep all
            # files in place and require bounded manual recovery, never overwrite.
            raise RecoveryConflict(f"{exc}; supplied record retained at {destination}") from exc
        except Exception:
            if destination.exists() and not draft.exists():
                os.replace(destination, draft)
            raise
    return {"id": record_id, "new": True, "path": str(destination), "reading_status": meta["reading_status"],
            "message": "Registered supplied files; no scientific verification was performed by this helper."}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "check", "build", "register"):
        sub = commands.add_parser(name)
        sub.add_argument("--root", required=True, help="Absolute private research-library directory")
        if name == "init":
            sub.add_argument("--config", required=True, help="Configured project JSON; never an API-key file")
        if name == "register":
            sub.add_argument("--draft", required=True, help="Draft directory inside ROOT/.staging")
    args = parser.parse_args(argv)
    try:
        root = root_path(args.root)
        if args.command == "init":
            result = initialize(root, args.config)
        elif args.command == "check":
            result = check(root)
        elif args.command == "build":
            result = build(root)
        else:
            result = register(root, args.draft)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (WorkspaceError, OSError, UnicodeError) as exc:
        print(json.dumps({"error": str(exc), "preserved": "Inspect existing files; the helper does not erase user annotations or research sources."}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
