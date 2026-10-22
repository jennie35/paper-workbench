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


def available(value):
    """Suppress empty template placeholders without rewriting saved research."""
    if isinstance(value, str):
        value = value.strip()
        empty = r"(?:未报告|未核验|未知|未提供|未记录|暂无|不适用|待补充|待填写|none|null|n/?a|[-—–]+)[。.;；\s]*"
        legacy = r"(?:(?:已提供的|现有|当前|所提供的)?(?:来源|资料|材料)(?:中)?(?:尚)?未(?:报告|提供)(?:足够|充分|可用|相关)?(?:信息|证据|内容)(?:[，,；;。]\s*(?:需|需要|尚需|待)(?:核对|查阅|查看|补充|取得|获取)(?:论文)?(?:原文|全文))?|(?:待|需|需要)(?:取得|获取|核对|查阅)(?:论文)?(?:全文|原文)(?:后(?:再)?分析)?)[。.;；\s]*"
        return bool(value) and not re.fullmatch(empty, value, re.I) and not re.fullmatch(legacy, value)
    return value is not None and value != [] and value != {}


def display_text(value):
    """Flatten saved prose fields; no inference or executable Markdown/HTML."""
    if isinstance(value, str):
        return value.strip() if available(value) else ""
    if isinstance(value, list):
        return "；".join(filter(None, (display_text(item) for item in value)))
    if isinstance(value, dict):
        return "；".join(display_text(value[key]) for key in ("summary", "text", "insight", "implication", "description", "reason", "title", "locator", "judgement_change", "judgment_change", "direct", "adapt", "avoid") if available(value.get(key)))
    return str(value) if available(value) else ""


def note_section(text, terms):
    """Read an explicitly saved note section as a card excerpt, never invent one."""
    for match in re.finditer(r"(?m)^#{1,4}\s+(.+)\n([\s\S]*?)(?=^#{1,4}\s+|\Z)", text):
        if any(term in match.group(1) for term in terms):
            lines = [line.strip() for line in match.group(2).splitlines() if available(line)]
            return " ".join(lines)
    return ""


def reference_text(value):
    """Read saved transfer analysis, preferring concrete borrowing over a summary."""
    if isinstance(value, dict):
        keys = ("direct", "direct_transfer", "adapt", "adapt_then_validate", "what_to_borrow", "application_to_topic", "application",
                "adaptation_conditions", "conditions", "evidence_basis", "basis", "avoid", "not_transferable",
                "summary", "text", "insight", "implication", "description", "judgement_change", "judgment_change")
        parts = [reference_text(value.get(key)) for key in keys]
        return "；".join(dict.fromkeys(part for part in parts if part))
    if isinstance(value, list):
        return "；".join(dict.fromkeys(part for item in value if (part := reference_text(item))))
    if isinstance(value, str):
        # Legacy default sentences can occupy one paragraph ahead of a real insight.
        lines = []
        for line in value.splitlines():
            key = re.sub(r"[\s，,；;：:。.!！?？]", "", line)
            if not available(line) or key in {"证据不足时保留原判断", "已取得的来源未报告或未核验需核对原文"}:
                continue
            if re.fullmatch(r"(?:先|需|需要|待)?(?:取得|获取|补充|补齐|核对|确认|阅读)(?:并(?:核对|阅读|确认))?(?:论文)?(?:原文|全文)(?:方法)?(?:(?:后|再|然后|之后|后再)?(?:判断|确认|评估)(?:其|本课题)?(?:是否|能否)?(?:适用|适用性|迁移|借鉴|具有参考价值))?", key):
                continue
            lines.append(line.strip())
        return " ".join(lines)
    return ""


def reference_value(evidence, note):
    """Use existing analysis only; a title or a source-fetching task is no insight."""
    logic = evidence.get("research_logic")
    logic = logic if isinstance(logic, dict) else {}
    keys = ("reference_value", "topic_reference_value", "project_reference", "topic_relevance", "project_relevance",
            "relevance_summary", "research_relevance", "future_insights", "research_implications", "transfer_insights", "transfer")
    for data in (evidence, logic):
        for key in keys:
            if result := reference_text(data.get(key)):
                return result
    terms = ("对本课题的参考借鉴", "可供本课题借鉴", "未来研究启示", "课题相关", "研究迁移", "Implications")
    headings = list(re.finditer(r"(?m)^(#{1,4})\s+(.+)\n", note))
    for index, match in enumerate(headings):
        if not any(term in match.group(2) for term in terms):
            continue
        end = next((item.start() for item in headings[index + 1:] if len(item.group(1)) <= len(match.group(1))), len(note))
        body = re.sub(r"(?m)^#{1,6}\s+.*$", "", note[match.end():end])
        if result := reference_text(body):
            return result
    return ""


def available_note(text):
    """Omit standalone empty template rows; preserve substantive limitations."""
    sections = re.split(r"(?m)(?=^#{1,6}\s)", text)
    shown = []
    for section in sections:
        lines = []
        for line in section.splitlines():
            content = re.sub(r"^\s*(?:[-*>]\s*)?", "", line).strip()
            field = re.split(r"[:：]", content, maxsplit=1)
            if content and (not available(content) or len(field) == 2 and not available(field[1])):
                continue
            lines.append(line)
        body = [line for line in lines if line.strip() and not line.startswith("#")]
        if body:
            shown.append("\n".join(lines).strip())
    return "\n\n".join(shown)


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
        return "<li>" + esc(action) + " · 待执行</li>" if available(action) else ""
    name = next((action[key] for key in ("title", "question", "hypothesis") if available(action.get(key))), "")
    if not name:
        return ""
    action = {**action, "evidence_gap": action.get("evidence_gap") or action.get("gap"),
              "criteria": action.get("criteria") or action.get("decision_rule")}
    fields = [("证据缺口", "evidence_gap"), ("待回答问题", "question"), ("假设", "hypothesis"), ("方法", "method"),
              ("实验单位", "experimental_unit"), ("数据", "data"), ("对照", "controls"),
              ("混杂控制", "confounds"), ("支持方向", "supporting"), ("削弱方向", "weakening"),
              ("判断依据", "criteria"), ("资源", "resources"),
              ("前置条件", "prerequisites"), ("交付成果", "deliverable"),
              ("停止条件", "stopping_criteria"), ("样本量依据", "sample_size_basis")]
    detail = "".join(f"<dt>{label}</dt><dd>{esc(display_text(action[key]))}</dd>" for label, key in fields if available(action.get(key)))
    priority = " · " + str(action["priority"]) if available(action.get("priority")) else ""
    return f'<li><strong>{esc(name)}</strong> <span class="action-state">待执行{esc(priority)}</span><dl>{detail}</dl></li>'


def render_runs(root):
    """Link saved batch documents without repeating their full text in the library."""
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
            files.append(f'<a href="{href(relative)}">{label} ↗</a>')
        if files:
            blocks.append(f'<section class="run"><h3>{esc(run.name)}</h3>{"".join(files)}</section>')
    return ('<details class="run-archive"><summary>研究批次 <span>打开保存的综合与简报 ↗</span></summary><section aria-label="批次综合与简报">' + "".join(blocks) + "</section></details>") if blocks else ""


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


DASHBOARD_CSS = """
:root{color-scheme:light;--bg:#eeefed;--paper:#f7f7f4;--ink:#20242e;--muted:#656975;--line:#d7d9d8;--accent:#82513f;--serif:Georgia,'Noto Serif SC','Songti SC','SimSun',serif;font:15px/1.7 system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--ink);background:var(--bg)}
*{box-sizing:border-box}body{max-width:1512px;margin:0 auto;padding:0 44px}button,input,select{font:inherit;color:inherit}button,a,input,select,summary{-webkit-tap-highlight-color:transparent}button,a,summary{touch-action:manipulation}button{cursor:pointer}button:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:4px}a{color:inherit;text-underline-offset:4px;text-decoration-color:#92969e}a:hover{color:var(--accent)}button{background:transparent;border:0}h1,h2,h3,p{margin-top:0}img{max-width:100%;max-height:650px}figure{margin:24px 0}figcaption{font-size:.8rem;color:var(--muted)}.muted{color:var(--muted)}
.masthead{height:84px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid var(--ink)}.brand{display:flex;align-items:center;gap:11px;font-family:var(--serif);font-size:20px;font-weight:700;letter-spacing:.03em}.brand-dot{display:inline-grid;place-items:center;width:21px;height:21px;background:var(--ink);color:var(--paper);border-radius:50%;font:12px/1 system-ui}.brand small{margin-left:8px;font:10px/1.2 system-ui;letter-spacing:.12em;text-transform:uppercase}.local-label{font-size:11px;letter-spacing:.1em;color:var(--muted)}.local-label:before{content:'';display:inline-block;width:5px;height:5px;margin:0 8px 1px 0;border-radius:50%;background:var(--accent)}
.workspace{display:grid;grid-template-columns:185px minmax(0,1fr);gap:55px;align-items:start}.sidebar{position:sticky;top:26px;padding-top:43px}.rail-label,.eyebrow{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}.rail-label{margin:0 0 18px}.sidebar nav{display:grid}.sidebar button{display:flex;align-items:center;gap:12px;text-align:left;width:100%;padding:13px 0;border-bottom:1px solid var(--line);font-size:13px}.sidebar button:after{content:'↗';margin-left:auto;color:var(--muted);opacity:0;transform:translateX(-3px);transition:opacity .15s,transform .15s}.sidebar button:hover:after,.sidebar button[aria-pressed=true]:after{opacity:1;transform:none}.sidebar button[aria-pressed=true]{font-weight:650;color:var(--accent);border-color:var(--accent)}.nav-number{width:22px;font:12px var(--serif);color:var(--muted)}.rail-note{margin-top:65px;padding-top:16px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);line-height:1.9}.rail-note b{display:block;margin-bottom:8px;color:var(--ink);font-weight:500}.rail-note span{display:block;font:10px/1.6 var(--serif);letter-spacing:.04em}
.content{min-width:0}.hero{padding:49px 0 30px}.eyebrow{display:flex;align-items:center;gap:12px;margin-bottom:24px}.eyebrow:before{content:'';width:28px;border-top:1px solid var(--muted)}h1{font-family:var(--serif);font-size:clamp(34px,4.2vw,64px);font-weight:400;line-height:1.2;letter-spacing:-.035em;max-width:910px;margin-bottom:27px;overflow-wrap:anywhere}.hero-bottom{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(260px,1fr);gap:50px;align-items:end}.research-question{max-width:470px;margin:0;color:var(--muted);font-size:13px;line-height:1.95}.library-stats{display:flex;gap:36px;margin:0;justify-content:flex-end}.library-stats div{min-width:85px}.library-stats dt{font-size:11px;color:var(--muted);white-space:nowrap}.library-stats dd{margin:0;font:49px/1.05 var(--serif);letter-spacing:-.055em}.library-stats dd span{margin-left:7px;font:11px system-ui;color:var(--muted);letter-spacing:0}.verification-note{margin:20px 0 0;padding-top:15px;border-top:1px solid var(--line);font-size:10px;letter-spacing:.02em;color:var(--muted)}
.catalog-bar{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin:19px 0 14px}.catalog-heading{display:flex;gap:12px;align-items:baseline}.catalog-heading h2{font:400 28px/1.2 var(--serif);letter-spacing:-.02em;margin:0}.catalog-heading span{font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}#count{margin:0;font-size:11px;color:var(--muted)}.filters{display:grid;grid-template-columns:minmax(220px,1.6fr) repeat(2,minmax(110px,.7fr)) minmax(105px,.65fr) minmax(100px,.6fr);border-top:1px solid var(--line);border-bottom:1px solid var(--ink);margin-bottom:3px;align-items:end}.filters label{padding:12px 12px 12px 0;min-width:0}.filters label+label{border-left:1px solid var(--line);padding-left:13px}.filters label>span{display:block;margin-bottom:5px;font-size:9px;letter-spacing:.06em;color:var(--muted)}input,select{width:100%;min-width:0;padding:4px 0;background:transparent;border:0;border-radius:0;outline-offset:2px;font-size:11px}input::placeholder{color:var(--muted);opacity:1}select{cursor:pointer}input[type=date]{font-size:11px}input::-webkit-calendar-picker-indicator{opacity:.55}
article{position:relative;display:grid;grid-template-columns:128px minmax(0,1fr);column-gap:28px;padding:31px 0 29px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.record-index{padding-top:4px}.badge{display:block;font:29px/1.1 var(--serif);letter-spacing:-.03em}.record-status{display:inline-block;margin-top:13px;padding-left:10px;position:relative;font-size:10px;line-height:1.6;color:var(--accent)}.record-status:before{content:'';position:absolute;left:0;top:6px;width:4px;height:4px;border-radius:50%;background:currentColor}.record-date{margin:19px 0 0;font-size:10px;color:var(--muted)}.record-body{min-width:0}article header h2{font:400 25px/1.4 var(--serif);letter-spacing:-.02em;margin-bottom:10px}article header p{font-size:10px;color:var(--muted);margin-bottom:15px}.record-theme{margin-bottom:11px;font-size:9px;letter-spacing:.07em;color:var(--muted)}.record-summary{max-width:760px;font-size:12px;line-height:1.95;margin:0 0 18px;color:#515663}.files{display:flex;flex-wrap:wrap;gap:8px 18px;margin:0 0 18px;font-size:10px}.files a{text-decoration:none;border-bottom:1px solid #a5a6a5}.files a:after{content:' ↗';font-size:10px}details{font-size:12px}summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}summary:after{content:'＋';float:right;padding-left:18px;font-size:13px;color:var(--muted)}details[open]>summary:after{content:'−'}article details{border-top:1px solid var(--line)}article details+details{margin-top:3px}article summary{padding:11px 0;font-size:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.95 system-ui,-apple-system,'Segoe UI',sans-serif;margin:10px 0 22px;color:#414652}ul{padding-left:20px}li{margin-bottom:10px}article details ul{font-size:10px}article .selected,article .actions{display:none}.selected h3,.actions h3{font:400 19px var(--serif);margin:20px 0 14px}.selected li,.actions li{font-size:12px}.actions dl{display:grid;grid-template-columns:8em minmax(0,1fr);gap:7px 16px;font-size:11px;margin:15px 0 24px}.actions dt{color:var(--muted)}.actions dd{margin:0}.actions li+li{padding-top:18px;border-top:1px solid var(--line)}body[data-view=evidence] .selected,body[data-view=actions] .actions{display:block}body[data-view=evidence] .reading,body[data-view=actions] .reading{display:none}.run-archive{border-top:1px solid var(--ink);border-bottom:1px solid var(--line);margin:33px 0 0}.run-archive>summary{padding:18px 0;font:400 20px/1.4 var(--serif)}.run-archive>summary>span{font:10px system-ui;color:var(--muted);margin-left:20px}.run-archive>section{padding:8px 0 16px}.run-archive p,.run-archive summary,.run-archive a{font-size:11px}.run-archive>summary{font:400 20px/1.4 var(--serif)}.run h3{font:400 16px var(--serif);margin:20px 0 13px}.run details{border-top:1px solid var(--line);padding:12px 0}.run-archive>section>p{max-width:660px}#empty{padding:55px 0;text-align:center;color:var(--muted);font:20px var(--serif)}footer{display:flex;justify-content:space-between;gap:40px;padding:28px 0 30px;color:var(--muted);font-size:9px;line-height:1.9}footer p{max-width:620px;margin:0}footer .updated{min-width:140px;text-align:right;font-size:9px}footer .updated span{display:block;letter-spacing:.1em;text-transform:uppercase;font-size:8px}[hidden]{display:none!important}
@media(min-width:1500px){body{padding:0 56px}.workspace{gap:70px}}@media(max-width:1100px){body{padding:0 28px}.workspace{grid-template-columns:150px minmax(0,1fr);gap:32px}.hero-bottom{gap:20px}.library-stats{gap:20px}.library-stats dd{font-size:42px}.filters{grid-template-columns:minmax(180px,1.5fr) repeat(2,minmax(108px,1fr))}.filters label:nth-child(4){border-left:0;padding-left:0;border-top:1px solid var(--line)}.filters label:nth-child(5){border-top:1px solid var(--line)}article{grid-template-columns:100px minmax(0,1fr);gap:18px}.badge{font-size:26px}}
@media(max-width:760px){body{padding:0 20px}.masthead{height:68px}.brand{font-size:18px}.brand small{display:none}.local-label{font-size:9px}.workspace{display:block}.sidebar{position:static;padding-top:0}.rail-label,.rail-note{display:none}.sidebar nav{grid-template-columns:repeat(4,minmax(0,1fr));margin-top:3px}.sidebar button{gap:6px;font-size:11px;padding:17px 0 14px;justify-content:center}.sidebar button:after{display:none}.nav-number{width:auto;font-size:10px}.hero{padding:30px 0 20px}h1{font-size:38px;line-height:1.25;margin-bottom:23px}.eyebrow{font-size:8px;letter-spacing:.12em;margin-bottom:20px}.hero-bottom{grid-template-columns:1fr;gap:20px}.research-question{font-size:12px;max-width:100%}.library-stats{justify-content:flex-start;gap:45px}.library-stats div{display:flex;flex-direction:column-reverse;gap:6px}.library-stats dd{font-size:41px}.library-stats dt{font-size:10px}.verification-note{font-size:9px;margin-top:19px}.catalog-heading h2{font-size:25px}.catalog-heading span{display:none}.catalog-bar{margin-top:12px}.filters{grid-template-columns:repeat(2,minmax(0,1fr))}.filters .filter-search{grid-column:1/-1;padding:12px 0;border-bottom:1px solid var(--line)}.filters label:nth-child(2),.filters label:nth-child(4){border-left:0;padding-left:0}.filters label:nth-child(3){border-left:1px solid var(--line);padding-left:13px}.filters label:nth-child(4),.filters label:nth-child(5){border-top:1px solid var(--line)}.filters label:nth-child(5){border-left:1px solid var(--line);padding-left:13px}input,select{font-size:12px}article{grid-template-columns:65px minmax(0,1fr);gap:15px;padding:24px 0}.badge{font-size:23px}.record-status{font-size:9px;padding-left:8px}.record-date{font-size:8px;margin-top:16px}article header h2{font-size:21px;line-height:1.5}.record-theme,article header p{font-size:9px}.record-summary{font-size:11px}.files{font-size:9px;gap:9px 14px}article summary{font-size:10px}.actions dl{display:block}.actions dt{margin-top:12px}.actions dd{margin:3px 0}.run-archive>summary{font-size:17px}.run-archive>summary>span{display:none}footer{display:block;font-size:9px}footer .updated{text-align:left;margin-top:16px}footer .updated span{display:inline;margin-right:10px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}@media print{body{padding:0;background:white}.sidebar,.filters{display:none}.workspace{display:block}.masthead{height:58px}.hero{padding-top:25px}article{break-inside:avoid}.content{width:100%}footer{border-top:1px solid var(--line)}}
.catalog-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;padding-top:22px}.catalog-list article{display:flex;flex-direction:column;gap:0;min-width:0;min-height:360px;padding:24px;border:1px solid var(--line);background:var(--paper);transition:border-color .15s,transform .15s}.catalog-list article:hover{border-color:#9a8c83;transform:translateY(-2px)}.record-index{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 0 20px}.badge{font-size:23px}.record-status{margin:0}.record-body{display:flex;flex:1;flex-direction:column}.record-date{margin:0}.record-theme{font-size:10px}.catalog-list article header h2{font-size:23px;margin:0 0 12px}.record-open{display:block;text-align:left;padding:0;font:inherit;line-height:inherit;letter-spacing:inherit}.record-open:hover{color:var(--accent)}.record-summary,.record-relevance{font-size:12px;line-height:1.85;margin:0 0 16px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}.record-relevance{border-left:2px solid #c5b1a7;padding-left:12px;color:#59504c}.record-relevance b{display:block;font-size:9px;letter-spacing:.06em;margin-bottom:5px;color:var(--accent)}.card-footer{display:flex;justify-content:space-between;gap:14px;align-items:center;margin-top:auto;padding-top:19px;border-top:1px solid var(--line);font-size:10px}.card-detail{padding:0;color:var(--accent)}.card-preview{font-size:11px;line-height:1.85;display:none;border-top:1px solid var(--line);padding-top:12px;margin-bottom:18px}.card-preview p{margin:0}.card-preview b{font-size:10px}body[data-view=evidence] .card-preview.selected,body[data-view=actions] .card-preview.actions{display:block}.reader-dialog{color:var(--ink);background:var(--paper);width:min(1000px,calc(100vw - 44px));max-height:92dvh;border:1px solid #a5a6a5;padding:0;overflow:auto}.reader-dialog::backdrop{background:#20242e99;backdrop-filter:blur(3px)}.reader-toolbar{position:sticky;top:0;z-index:2;background:var(--paper);padding:16px 30px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:11px}.reader-toolbar button{padding:4px 0;color:var(--accent)}.reader-content{padding:35px 50px 48px;max-width:920px;margin:auto}.reader-content h2{font:400 34px/1.4 var(--serif);letter-spacing:-.025em;margin-bottom:18px}.reader-content h3{font:400 23px var(--serif);margin:32px 0 15px}.reader-content pre{font-size:13px;line-height:2}.reader-content .files{font-size:11px;border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:25px}.reader-content .selected,.reader-content .actions{display:block}.reader-content .selected li,.reader-content .actions li{font-size:13px}.reader-content .actions dl{display:grid;grid-template-columns:8em minmax(0,1fr);gap:7px 16px;font-size:12px}.reader-content .actions dd{margin:0}.reader-content .actions dt{color:var(--muted)}.action-state{display:block;margin-top:5px;font-size:10px;color:var(--accent)}.run{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px 24px}.run h3{margin-right:auto}.run a{font-size:11px}.target-count{font-size:11px;color:var(--accent);margin:16px 0 0}.record-meta{font-size:11px;color:var(--muted)}
@media(min-width:1350px){.catalog-list{grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.catalog-list article{padding:23px}.catalog-list article header h2{font-size:21px}}
@media(max-width:980px){.catalog-list{grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}.catalog-list article{padding:20px}.catalog-list article header h2{font-size:22px}}
@media(max-width:600px){.catalog-list{grid-template-columns:1fr;gap:16px}.catalog-list article{min-height:320px}.reader-dialog{width:calc(100vw - 20px);max-height:95dvh}.reader-toolbar{padding:13px 20px}.reader-content{padding:24px 23px 35px}.reader-content h2{font-size:28px}.reader-content .actions dl{display:block}.reader-content .actions dt{margin-top:10px}}
@media print{.catalog-list{display:block}.catalog-list article{margin-bottom:20px}.reader-dialog[open]{position:static;max-height:none;width:auto;overflow:visible}.reader-toolbar{display:none}}
"""


def render(root, config, ledger):
    articles = []
    dialogs = []
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
        search = " ".join([record["id"], meta["title"], authors, themes, available_note(text)])
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
        source = f'<a href="{esc(external)}" rel="noreferrer">原文 ↗</a>' if external else ""
        original = []
        for image in evidence.get("original_images", []):
            if not isinstance(image, dict) or not image.get("path"):
                continue
            image_path = base + "/" + str(image["path"])
            within(root, image_path)
            original.append(f'<figure><a href="{href(image_path)}"><img loading="lazy" src="{href(image_path)}" alt="{esc(image.get("caption", "来源图像"))}"></a><figcaption>{esc(image.get("caption", ""))} · {esc(image.get("verification_status", "未核验"))}（按保存记录显示；图片存在不代表已目视核验）</figcaption></figure>')
        logic = evidence.get("research_logic")
        reading = evidence.get("reading_priorities", (logic if isinstance(logic, dict) else {}).get("reading_priorities", []))
        reading = [display_text(item) for item in reading if available(item)] if isinstance(reading, list) else []
        reading = [item for item in reading if item]
        selected = "".join("<li>" + esc(item) + "</li>" for item in reading)
        date = str(meta.get("analysis_date") or record["added_at"][:10])
        reader_link = ""
        if (folder / "reader.html").exists():
            reader_path = base + "/reader.html"
            if not within(root, reader_path).is_file():
                raise WorkspaceError("reader.html must be a local file")
            reader_link = f'<a href="{href(reader_path)}">排版阅读页</a>'
        status_label = {"complete": "完成阅读", "partial": "部分报告", "candidate": "仅候选"}[meta["reading_status"]]
        summary = display_text(evidence.get("summary")) or note_section(text, ("论文总结", "简明总结", "Summary"))
        logic = logic if isinstance(logic, dict) else {}
        relevance = reference_value(evidence, text)
        summary_html = f'<p class="record-summary">{esc(summary)}</p>' if summary else ""
        relevance_html = f'<p class="record-relevance"><b>对本课题的参考借鉴</b>{esc(relevance)}</p>' if relevance else ""
        action_html = "".join(render_action(action) for action in actions_from(evidence))
        action_names = [str(action.get("title") or action.get("question") or "") for action in actions_from(evidence) if isinstance(action, dict)]
        action_names = [name for name in action_names if available(name)]
        selected_preview = f'<div class="card-preview selected"><b>精选精读</b><p>{esc(reading[0])}</p></div>' if reading else ""
        action_preview = f'<div class="card-preview actions"><b>待执行行动</b><p>{esc("；".join(action_names[:2]))}</p></div>' if action_names else ""
        citation = " · ".join(str(value) for value in (authors, meta.get("venue"), meta.get("year")) if available(value))
        dialog_id = "reading-" + record["id"]
        theme_html = f'<div class="record-theme">{esc(themes)}</div>' if themes else ""
        articles.append(f'''<article data-search="{esc(search.casefold())}" data-date="{esc(date)}" data-theme="{esc(themes.casefold())}" data-priority="{esc(' '.join(priorities))}" data-selected="{'yes' if selected else 'no'}">
<div class="record-index"><span class="badge">{esc(record['id'])}</span><span class="record-status" title="保存的阅读状态：{esc(meta['reading_status'])}">{status_label}</span></div><div class="record-body"><header>{theme_html}<h2><button class="record-open" data-open="{dialog_id}" aria-haspopup="dialog" aria-controls="{dialog_id}">{esc(meta['title'])}</button></h2>{f'<p>{esc(citation)}</p>' if citation else ''}</header>{summary_html}{relevance_html}{selected_preview}{action_preview}<div class="card-footer"><span class="record-date">{esc(date)}</span><button class="card-detail" data-open="{dialog_id}" aria-haspopup="dialog" aria-controls="{dialog_id}">查看详细分析 ↗</button></div></div></article>''')
        original_html = '<section><h3>保存的原图与核验记录</h3>' + "".join(original) + '</section>' if original else ""
        selected_html = f'<section class="selected"><h3>需要重点精读的证据</h3><ul>{selected}</ul></section>' if selected else ""
        actions_html = f'<section class="actions"><h3>下一步研究 · 待执行</h3><ul>{action_html}</ul></section>' if action_html else ""
        sources_html = f'<details><summary>来源与图像文件</summary><ul>{"".join(source_links)}</ul></details>' if source_links else ""
        note = available_note(text)
        report_html = f'<section><h3>研究分析</h3><pre>{esc(note)}</pre></section>' if note else ""
        dialogs.append(f'''<dialog class="reader-dialog" id="{dialog_id}" aria-labelledby="title-{esc(record['id'])}"><div class="reader-toolbar"><span>{esc(record['id'])} · {status_label}</span><button data-close="{dialog_id}" autofocus>关闭 · 返回文献库 ×</button></div><div class="reader-content"><h2 id="title-{esc(record['id'])}">{esc(meta['title'])}</h2>{f'<p class="record-meta">{esc(citation)}</p>' if citation else ''}{summary_html}{relevance_html}<div class="files">{source}{reader_link}<a href="{href(base + '/reading-note.md')}">阅读笔记</a><a href="{href(base + '/evidence.json')}">证据 JSON</a><a href="{href(base + '/metadata.json')}">题录与阅读状态</a></div>{report_html}{original_html}{selected_html}{actions_html}{sources_html}</div></dialog>''')
    complete = sum(item["metadata"]["reading_status"] == "complete" for item in ledger["records"])
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: file:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>{esc(config['project_name'])} · 文献研究</title><style>
{DASHBOARD_CSS}
</style></head><body data-view="recent"><header class="masthead"><div class="brand"><span class="brand-dot" aria-hidden="true">·</span>研序 <small>Paper Workbench</small></div><span class="local-label">本地研究档案 · OFFLINE LIBRARY</span></header>
<div class="workspace"><aside class="sidebar"><p class="rail-label">Research index / 研究目录</p><nav aria-label="研究视图"><button data-view="recent" aria-pressed="true"><span class="nav-number" aria-hidden="true">I.</span>最近更新</button><button data-view="all" aria-pressed="false"><span class="nav-number" aria-hidden="true">II.</span>全部文献</button><button data-view="evidence" aria-pressed="false"><span class="nav-number" aria-hidden="true">III.</span>精选精读</button><button data-view="actions" aria-pressed="false"><span class="nav-number" aria-hidden="true">IV.</span>下一步研究</button></nav><p class="rail-note"><b>可追溯的阅读<br>有边界的推断<br>可检验的行动</b><span>Read. Question. Test.</span>从保存的证据出发，<br>让下一步研究有据可循。</p></aside>
<main class="content"><section class="hero"><p class="eyebrow">Personal research library / 课题文献库</p><h1>{esc(config['project_name'])}</h1><div class="hero-bottom"><p class="research-question">{esc(config['research_question'])}</p><dl class="library-stats"><div><dt>累计登记</dt><dd>{len(ledger['records']):02d}<span>篇</span></dd></div><div><dt>按保存状态完成阅读</dt><dd>{complete:02d}<span>篇</span></dd></div></dl></div><p class="target-count">目标新增 {esc(config.get("default_count", 5))} 篇</p><p class="verification-note">阅读状态来自保存记录。结构检查不等于科学结论得到验证。</p></section>
<section aria-label="文献目录"><div class="catalog-bar"><div class="catalog-heading"><h2 id="view-title">最近更新</h2><span id="view-caption">Recently updated</span></div><p id="count" aria-live="polite"></p></div><div class="filters"><label class="filter-search"><span>检索已保存的研究</span><input type="search" id="q" placeholder="关键词、作者或论文编号…" aria-label="关键词"></label><label><span>起始日期</span><input type="date" id="from" aria-label="起始日期"></label><label><span>结束日期</span><input type="date" id="to" aria-label="结束日期"></label><label><span>研究主题</span><input id="theme" placeholder="全部主题" aria-label="主题"></label><label><span>行动优先级</span><select id="priority" aria-label="优先级"><option value="">全部优先级</option><option>P0</option><option>P1</option><option>P2</option><option>高</option><option>中</option><option>低</option></select></label></div><div class="catalog-list">{''.join(articles)}</div><p id="empty" hidden>没有符合条件的文献。</p></section>{render_runs(root)}<footer><p>本页由本地记录构建，无网络检索、模型调用或自动执行。原文链接由你点击打开。完整内容以 reading-note.md 与 evidence.json 为准。最近更新显示最多 20 条，全部文献不限制条数。</p><p class="updated"><span>Last updated</span>{esc(ledger.get('updated_at', ''))}</p></footer></main></div>{"".join(dialogs)}
<script>(()=>{{'use strict';const fields=['q','from','to','theme','priority'].map(id=>document.getElementById(id));const cards=[...document.querySelectorAll('.catalog-list article')];for(const button of document.querySelectorAll('[data-open]'))button.addEventListener('click',()=>{{const dialog=document.getElementById(button.dataset.open);dialog.showModal();}});for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>document.getElementById(button.dataset.close).close());for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{{if(event.target===dialog){{const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}}}});let view='recent';function filter(){{const [q,from,to,theme,priority]=fields.map(el=>el.value.trim().toLowerCase());let shown=0;for(const card of cards){{const d=card.dataset;const match=(!q||d.search.includes(q))&&(!from||d.date>=from)&&(!to||d.date<=to)&&(!theme||d.theme.includes(theme))&&(!priority||d.priority.toLowerCase().split(' ').includes(priority))&&(view!=='evidence'||d.selected==='yes');card.hidden=!match||(view==='recent'&&shown>=20);if(!card.hidden)shown++;}}document.getElementById('count').textContent='当前显示 '+shown+' 篇';document.getElementById('empty').hidden=shown>0;}}for(const field of fields)field.addEventListener('input',filter);for(const button of document.querySelectorAll('button[data-view]'))button.addEventListener('click',()=>{{view=button.dataset.view;document.body.dataset.view=view;const labels={{recent:['最近更新','Recently updated'],all:['全部文献','The research catalog'],evidence:['精选精读','Evidence worth reading'],actions:['下一步研究','From evidence to action']}};document.getElementById('view-title').textContent=labels[view][0];document.getElementById('view-caption').textContent=labels[view][1];for(const item of document.querySelectorAll('button[data-view]'))item.setAttribute('aria-pressed',String(item===button));filter();}});filter();}})();</script></body></html>'''.encode("utf-8")


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
