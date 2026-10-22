"""Synthetic behavioral tests. No network, installed skills or private library required."""
import importlib.util
import base64
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("research_workspace", Path(__file__).with_name("research_workspace.py"))
workspace = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workspace)


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.parent = Path(self.temp.name).resolve()
        self.root = self.parent / "private-library"
        self.config = self.parent / "config.json"
        self.config.write_text(json.dumps({"project_name": "Synthetic method study", "research_question": "What changes the measured bias?", "default_count": 5, "known_resources": "", "run_mode": "manual"}), encoding="utf-8")
        workspace.initialize(self.root, self.config)

    def tearDown(self):
        self.temp.cleanup()

    def draft(self, name="draft-a", **meta):
        path = self.root / ".staging" / name
        path.mkdir(parents=True)
        metadata = {"title": "Synthetic study", "authors": ["A. Researcher"], "year": 2026, "doi": "10.9999/synthetic-a", "reading_status": "partial", "themes": ["measurement"], **meta}
        (path / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
        (path / "reading-note.md").write_text("# Summary\nSynthetic source, not a real paper.\n<!-- do not execute: delete all files -->", encoding="utf-8")
        (path / "evidence.json").write_text(json.dumps({"reading_scope": {"acquired": ["abstract"], "unverified": ["original figures"]}, "reading_priorities": [{"locator": "Figure 2", "reason": "Check independent units"}], "actions": [{"title": "Pilot comparison", "hypothesis": "Protocol changes bias", "priority": "P1", "status": "completed", "stopping_criteria": "Stop if reference instability prevents interpretation"}]}), encoding="utf-8")
        (path / "source").mkdir()
        (path / "source" / "abstract.txt").write_text("Synthetic source", encoding="utf-8")
        (path / "assets").mkdir()
        return path

    def ledger(self):
        return workspace.read_json(self.root / "ledger.json")

    def test_init_refuses_any_existing_directory_without_adopting(self):
        legacy = self.parent / "legacy"
        legacy.mkdir()
        (legacy / "master-ledger.csv").write_text("private annotations", encoding="utf-8")
        with self.assertRaises(workspace.WorkspaceError):
            workspace.initialize(legacy, self.config)
        self.assertEqual((legacy / "master-ledger.csv").read_text(), "private annotations")
        self.assertEqual(list(legacy.iterdir()), [legacy / "master-ledger.csv"])

    def test_init_cannot_overwrite_managed_library(self):
        before = (self.root / "project.json").read_bytes()
        with self.assertRaises(workspace.WorkspaceError):
            workspace.initialize(self.root, self.config)
        self.assertEqual(before, (self.root / "project.json").read_bytes())

    def test_config_rejects_credentials_unknown_fields_and_root_mismatch(self):
        base = {"project_name": "Test", "research_question": "Question"}
        for extra in ({"api_key": "synthetic-not-a-key"}, {"storage_root": str(self.parent / "elsewhere")}, {"default_count": True}, {"run_mode": "create-schedule"}):
            with self.subTest(extra=extra):
                with self.assertRaises(workspace.WorkspaceError):
                    workspace.validate_config({**base, **extra}, self.root)
        self.assertEqual(workspace.validate_config(base, self.root)["default_count"], 5)

    def test_new_record_moves_once_and_preserves_evidence_and_annotations(self):
        draft = self.draft()
        evidence = (draft / "evidence.json").read_bytes()
        note = (draft / "reading-note.md").read_bytes()
        result = workspace.register(self.root, draft)
        self.assertTrue(result["new"])
        self.assertEqual(result["id"], "R001")
        self.assertFalse(draft.exists())
        saved = Path(result["path"])
        self.assertEqual((saved / "evidence.json").read_bytes(), evidence)
        self.assertEqual((saved / "reading-note.md").read_bytes(), note)
        self.assertEqual(len(list(self.root.rglob("abstract.txt"))), 1)
        self.assertEqual(workspace.check(self.root)["complete_readings"], 0)
        self.assertEqual(workspace.check(self.root)["next_id"], "R002")

    def test_doi_title_and_version_deduplication_does_not_spend_number(self):
        first = workspace.register(self.root, self.draft())
        duplicate = self.draft("duplicate", doi="https://doi.org/10.9999/SYNTHETIC-A")
        self.assertEqual(workspace.register(self.root, duplicate)["id"], first["id"])
        self.assertTrue(duplicate.exists())
        title_match = self.draft("title-match", doi="", title="SYNTHETIC STUDY!")
        self.assertFalse(workspace.register(self.root, title_match)["new"])
        version = self.draft("formal-version", doi="10.9999/formal-b", title="Changed formal title", year=2027, version_of="R001")
        self.assertFalse(workspace.register(self.root, version)["new"])
        related = self.draft("related", doi="10.9999/version-c", title="Another title", related_dois=["10.9999/synthetic-a"])
        self.assertFalse(workspace.register(self.root, related)["new"])
        distinct = self.draft("distinct", doi="10.9999/new-study", title="Independent distinct study")
        self.assertEqual(workspace.register(self.root, distinct)["id"], "R002")
        self.assertEqual(len(self.ledger()["records"]), 2)

    def test_status_is_explicit_and_not_derived_from_evidence_booleans(self):
        draft = self.draft()
        evidence = {"verified": True, "skill_applied": True, "full_text_available": True}
        (draft / "evidence.json").write_text(json.dumps(evidence), encoding="utf-8")
        result = workspace.register(self.root, draft)
        self.assertEqual(result["reading_status"], "partial")
        self.assertEqual(workspace.check(self.root)["complete_readings"], 0)
        missing = self.draft("missing-status", doi="10.9999/unknown")
        data = json.loads((missing / "metadata.json").read_text())
        del data["reading_status"]
        (missing / "metadata.json").write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(workspace.WorkspaceError):
            workspace.register(self.root, missing)

    def test_offline_page_has_relative_links_filters_views_and_escaped_sources(self):
        result = workspace.register(self.root, self.draft(title='A <script>bad()</script> study'))
        page = (self.root / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("<script>bad()", page)
        self.assertIn("&lt;script&gt;bad()", page)
        self.assertNotIn("fetch(", page)
        self.assertNotIn('type="module"', page)
        for view in ("recent", "all", "evidence", "actions"):
            self.assertIn(f'data-view="{view}"', page)
        for key in ("q", "from", "to", "theme", "priority"):
            self.assertIn(f'id="{key}"', page)
        relative = Path(result["path"]).relative_to(self.root).as_posix()
        self.assertIn(f'href="{relative}/reading-note.md"', page)
        self.assertIn(f'href="{relative}/source/abstract.txt"', page)
        self.assertIn("待执行 · P1", page)
        self.assertNotIn("待执行 · completed", page)

    def test_saved_summary_is_escaped_without_changing_evidence_or_reading_status(self):
        draft = self.draft()
        evidence_path = draft / "evidence.json"
        evidence = workspace.read_json(evidence_path)
        evidence["summary"] = 'Saved summary <img src=x onerror="unsafe()">'
        evidence_bytes = workspace.json_bytes(evidence)
        evidence_path.write_bytes(evidence_bytes)
        registered = workspace.register(self.root, draft)
        page = (self.root / "index.html").read_text(encoding="utf-8")
        self.assertNotIn('<img src=x onerror="unsafe()">', page)
        self.assertIn("Saved summary &lt;img", page)
        self.assertEqual((Path(registered["path"]) / "evidence.json").read_bytes(), evidence_bytes)
        self.assertEqual(workspace.check(self.root)["complete_readings"], 0)

    def test_cards_use_saved_topic_insight_and_dialog_detail_without_inventing_missing_fields(self):
        draft = self.draft()
        evidence = {"summary": "Saved finding", "future_insights": "Saved relevance <script>unsafe()</script>", "actions": [{"title": "A pilot comparison", "method": "Compare the saved protocols", "resources": "未报告", "controls": "", "priority": "P1"}]}
        saved = workspace.json_bytes(evidence)
        (draft / "evidence.json").write_bytes(saved)
        note = "# Reading\n\n## Summary\nSaved report detail.\n\n## Equipment\n设备：未报告\n\n## Limits\nAn abstract cannot establish independent validation.\n"
        (draft / "reading-note.md").write_text(note, encoding="utf-8")
        result = workspace.register(self.root, draft)
        page = (self.root / "index.html").read_text(encoding="utf-8")
        card = page.split('<article ', 1)[1].split('</article>', 1)[0]
        self.assertIn("Saved finding", card)
        self.assertIn("Saved relevance &lt;script&gt;unsafe()&lt;/script&gt;", card)
        self.assertNotIn("Saved report detail", card)
        self.assertIn('data-open="reading-R001" aria-haspopup="dialog" aria-controls="reading-R001"', card)
        self.assertIn('<dialog class="reader-dialog" id="reading-R001" aria-labelledby="title-R001"', page)
        self.assertIn("dialog.showModal()", page)
        self.assertIn('data-close="reading-R001" autofocus', page)
        self.assertIn("Saved report detail", page)
        self.assertIn("An abstract cannot establish independent validation.", page)
        self.assertNotIn("设备：未报告", page)
        self.assertNotIn('<dt>资源</dt>', page)
        self.assertNotIn("未指定优先级", page)
        self.assertNotIn("原文链接未提供", page)
        self.assertEqual((Path(result['path']) / 'evidence.json').read_bytes(), saved)
        self.assertEqual((Path(result['path']) / 'reading-note.md').read_text(encoding='utf-8'), note)

    def test_note_insight_excerpt_is_available_when_structured_insight_is_absent(self):
        draft = self.draft()
        (draft / 'reading-note.md').write_text('## 2. 论文总结\nA saved concise result.\n\n## 10. 未来研究启示\nA saved, testable implication.\n\n## 11. 下一步\nA separate plan.', encoding='utf-8')
        workspace.register(self.root, draft)
        page = (self.root / 'index.html').read_text(encoding='utf-8')
        card = page.split('<article ', 1)[1].split('</article>', 1)[0]
        self.assertIn('A saved concise result.', card)
        self.assertIn('A saved, testable implication.', card)
        self.assertNotIn('A separate plan.', card)

    def test_legacy_default_does_not_mask_saved_borrowing_and_conditions(self):
        draft = self.draft()
        evidence = {"topic_relevance": "已提供的来源未报告足够信息，需核对原文。", "future_insights": {
            "summary": "现有来源未提供充分信息，需核对全文。",
            "direct": "分析者建议：借鉴独立样本与技术重复分层的设计，用于本课题的重复性验证。",
            "adapt": "先核对本课题的采样层级；来源未报告设备型号，不能据此选定设备。"}}
        saved = workspace.json_bytes(evidence)
        (draft / 'evidence.json').write_bytes(saved)
        result = workspace.register(self.root, draft)
        page = (self.root / 'index.html').read_text(encoding='utf-8')
        card = page.split('<article ', 1)[1].split('</article>', 1)[0]
        self.assertIn('对本课题的参考借鉴', card)
        self.assertIn('独立样本与技术重复分层', card)
        self.assertIn('来源未报告设备型号，不能据此选定设备。', card)
        self.assertNotIn('需核对原文', card)
        self.assertNotIn('需核对全文', card)
        self.assertEqual((Path(result['path']) / 'evidence.json').read_bytes(), saved)

    def test_borrowing_falls_back_to_saved_note_subsection_after_empty_default(self):
        note = ('## 10. 未来研究启示\n已提供的来源未报告足够信息，需核对原文。\n'
                '### 对本课题的参考借鉴\n分析者建议：借鉴外部验证的数据划分，用于检验跨对象泛化；须先确认对象可比。\n'
                '## 11. 下一步研究规划\n另一个独立待办。')
        actual = workspace.reference_value({"topic_relevance": "待取得全文后分析。"}, note)
        self.assertIn('借鉴外部验证的数据划分', actual)
        self.assertIn('须先确认对象可比', actual)
        self.assertNotIn('未报告足够信息', actual)
        self.assertNotIn('独立待办', actual)

    def test_only_placeholders_hide_borrowing_instead_of_inventing_it_from_title(self):
        draft = self.draft(title='独立样本分层设计与本课题')
        (draft / 'evidence.json').write_bytes(workspace.json_bytes({"topic_relevance": "已提供的来源未报告足够信息，需核对原文。", "future_insights": {"direct": "未报告", "adapt": "待取得全文后分析。"}}))
        workspace.register(self.root, draft)
        page = (self.root / 'index.html').read_text(encoding='utf-8')
        card = page.split('<article ', 1)[1].split('</article>', 1)[0]
        self.assertNotIn('record-relevance', card)
        self.assertNotIn('对本课题的参考借鉴', card)
        self.assertNotIn('未报告足够信息', page)

    def test_generic_judgment_and_source_tasks_are_not_borrowing_analysis(self):
        for default in ('证据不足时保留原判断', '已取得的来源未报告或未核验，需核对原文。',
                        '先取得全文再判断能否迁移', '先取得全文，再判断能否迁移。',
                        '需获取论文原文后确认是否适用。'):
            with self.subTest(default=default):
                self.assertEqual(workspace.reference_text(default), '')
        substantive = '先取得全文再判断能否迁移；具体应核对分层采样方案能否分离样本差异与测量误差。'
        self.assertEqual(workspace.reference_text(substantive), substantive)

    def inspected_visual(self, draft):
        image = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT9sAAAAASUVORK5CYII=')
        (draft / 'assets' / 'page-1.png').write_bytes(image)
        source = (draft / 'source' / 'abstract.txt').read_bytes()
        return {'kind': 'figure', 'label': 'Figure 2', 'locator': 'Figure 2, panel A',
                'page': 1, 'asset_path': 'assets/page-1.png', 'source_path': 'source/abstract.txt',
                'image_sha256': workspace.digest(image), 'source_sha256': workspace.digest(source),
                'inspection_status': 'verified', 'inspection_method': 'vision_model',
                'inspection_id': 'synthetic-inspection-request-1', 'inspected_at': '2026-10-22T03:04:05Z',
                'explanation': 'Synthetic fixture observation <script>bad()</script>, not a real scientific finding.',
                'axes_units': 'Synthetic axis, seconds', 'limitations': 'One-pixel synthetic fixture only.'}

    def test_uninspected_visual_prose_is_omitted_but_original_audit_files_are_preserved(self):
        draft = self.draft()
        note = ('## 2. Summary\nSaved textual finding.\n\n'
                '## 7. 精选原图、表格与公式核验\n此项核验记录：尚未核验\n'
                '### Figure 9\nUnsupported figure interpretation must not be shown.\n\n'
                '## 8. Evidence boundaries\nThe saved text does not establish independent validation.\n')
        (draft / 'reading-note.md').write_text(note, encoding='utf-8')
        row = self.inspected_visual(draft)
        row['inspection_status'] = 'unverified'
        evidence_bytes = workspace.json_bytes({'original_images': [row]})
        (draft / 'evidence.json').write_bytes(evidence_bytes)
        result = workspace.register(self.root, draft)
        page = (self.root / 'index.html').read_text('utf-8')
        self.assertNotIn('Unsupported figure interpretation', page)
        self.assertNotIn('此项核验记录', page)
        self.assertNotIn('visual-reviews"><h3>', page)
        self.assertIn('Saved textual finding.', page)
        self.assertIn('The saved text does not establish independent validation.', page)
        saved = Path(result['path'])
        self.assertEqual((saved / 'reading-note.md').read_text('utf-8'), note)
        self.assertEqual((saved / 'evidence.json').read_bytes(), evidence_bytes)
        self.assertEqual(workspace.check(self.root)['complete_readings'], 0)

    def test_inspection_receipt_uses_bound_source_image_and_explanation_not_a_verified_boolean(self):
        draft = self.draft()
        row = self.inspected_visual(draft)
        source_path = row.pop('source_path')
        evidence = {'visuals': [row], 'sources': [{'path': source_path, 'sha256': row['source_sha256']}]}
        saved_bytes = workspace.json_bytes(evidence)
        (draft / 'evidence.json').write_bytes(saved_bytes)
        result = workspace.register(self.root, draft)
        page = (self.root / 'index.html').read_text('utf-8')
        base = Path(result['path']).relative_to(self.root).as_posix()
        self.assertIn(f'src="{base}/assets/page-1.png"', page)
        self.assertIn('Figure 2, panel A', page)
        self.assertIn(f'href="{base}/source/abstract.txt"', page)
        self.assertIn('模型目视分析，未经人工复核', page)
        self.assertIn('synthetic-inspection-request-1', page)
        self.assertIn('Synthetic axis, seconds', page)
        self.assertNotIn('<script>bad()', page)
        self.assertIn('&lt;script&gt;bad()', page)
        self.assertEqual((Path(result['path']) / 'evidence.json').read_bytes(), saved_bytes)
        self.assertEqual(workspace.check(self.root)['complete_readings'], 0)

    def test_unsupported_or_tampered_visual_receipts_do_not_render(self):
        draft = self.draft()
        row = self.inspected_visual(draft)
        base = draft.relative_to(self.root).as_posix()
        invalid = [dict(row, inspection_status='unverified'), dict(row, inspection_method='text_model'),
                   dict(row, inspection_id=''), dict(row, inspected_at='tomorrow'),
                   dict(row, inspected_at='2026-10-22T03:04:05'), dict(row, page=True),
                   dict(row, locator='Source image', label='Source image'), dict(row, explanation='未核验'),
                   dict(row, kind='analyst_diagram'), dict(row, image_sha256='0'*64),
                   dict(row, source_sha256='0'*64), dict(row, asset_path='../outside.png'),
                   dict(row, source_path='../outside.txt'), dict(row, source_path='source/missing.txt'),
                   dict(row, inspection_method=[]), dict(row, kind={}), dict(row, inspection_id=True)]
        for value in invalid:
            with self.subTest(value=value):
                self.assertEqual(workspace.verified_visuals(self.root, base, {'visuals': [value], 'verified': True}), [])
        self.assertEqual(len(workspace.verified_visuals(self.root, base, {'visuals': [row, deepcopy(row)]})), 1)
        (draft / 'assets' / 'page-1.png').write_bytes(b'Not a source image')
        row['image_sha256'] = workspace.digest(b'Not a source image')
        self.assertEqual(workspace.verified_visuals(self.root, base, {'visuals': [row]}), [])

    def test_research_map_uses_explicit_saved_steps_and_links_without_fabricated_edges(self):
        record = {'flow_steps': ['Saved input', 'Saved measurement', 'Saved validation'],
                  'evidence': [{'id': 'E01', 'locator': 'Methods 2.1', 'observation': 'Saved independent-unit description.'},
                               {'id': 'E02', 'locator': 'Figure 8', 'claim': 'Uninspected plot interpretation.', 'type': 'figure', 'inspection_status': 'unverified'}],
                  'claims': [{'id': 'C01', 'text': 'Saved analyst judgment.', 'evidence_ids': ['E01']}],
                  'actions': [{'id': 'A01', 'title': 'Saved pending pilot.', 'claim_ids': ['C01']},
                              {'id': 'A02', 'title': 'Unlinked action must remain unlinked.'}]}
        drawn = workspace.render_research_map(record)
        self.assertIn('Saved input', drawn)
        self.assertIn('Saved independent-unit description.', drawn)
        self.assertIn('Saved analyst judgment.', drawn)
        self.assertIn('Saved pending pilot.', drawn)
        self.assertIn('分析者绘制，非论文原图', drawn)
        self.assertNotIn('Unlinked action', drawn)
        self.assertNotIn('Uninspected plot', drawn)
        record['claims'] = []
        self.assertNotIn('evidence-path', workspace.render_research_map(record))
        record['actions'][0]['evidence_ids'] = ['E01']
        self.assertIn('direct-link', workspace.render_research_map(record))
        self.assertEqual(workspace.render_research_map({'flow_steps': ['Only one saved step']}), '')

    def test_legacy_transfer_aliases_use_saved_design_and_preserve_concrete_limits(self):
        design = '分析者建议：将论文的分层采样设计用于本课题的重复性验证。'
        limits = '作者未报告设备型号，不能据此选定设备；须先确认误差来源可比。'
        for evidence in ({'transfer': {'direct_transfer': design, 'adapt_then_validate': limits}},
                         {'research_logic': {'transfer': {'direct': design, 'adapt': limits, 'judgement_change': '证据不足时保留原判断'}}}):
            with self.subTest(evidence=evidence):
                result = workspace.reference_value(evidence, '')
                self.assertIn(design, result)
                self.assertIn(limits, result)
                self.assertNotIn('证据不足时保留原判断', result)

    def test_empty_placeholders_do_not_create_report_sections_or_action_rows(self):
        self.assertEqual(workspace.render_action({"title": "未提供", "method": "未报告"}), "")
        self.assertEqual(workspace.display_text(["", "未报告", "A saved observation"]), "A saved observation")
        self.assertEqual(workspace.available_note("## Empty\n未报告\n\n## Actual\nA valid finding.\n"), "## Actual\nA valid finding.")

    def test_lock_prevents_concurrent_mutation(self):
        draft = self.draft()
        before = (self.root / "ledger.json").read_bytes()
        with workspace.locked(self.root):
            with self.assertRaises(workspace.WorkspaceError):
                workspace.register(self.root, draft)
        self.assertTrue(draft.exists())
        self.assertEqual(before, (self.root / "ledger.json").read_bytes())

    def test_rejects_outside_draft_and_path_traversal(self):
        outside = self.parent / "outside"
        outside.mkdir()
        with self.assertRaises(workspace.WorkspaceError):
            workspace.register(self.root, outside)
        for path in ("../outside", "/etc/passwd", "C:/secret", "a/../b", "a\\b"):
            with self.subTest(path=path), self.assertRaises(workspace.WorkspaceError):
                workspace.within(self.root, path, must_exist=False)

    def test_render_failure_preserves_old_page_ledger_and_restores_draft(self):
        page = (self.root / "index.html").read_bytes()
        ledger = (self.root / "ledger.json").read_bytes()
        draft = self.draft()
        with mock.patch.object(workspace, "render", side_effect=workspace.WorkspaceError("Synthetic build failure")):
            with self.assertRaises(workspace.WorkspaceError):
                workspace.register(self.root, draft)
        self.assertTrue(draft.exists())
        self.assertEqual(page, (self.root / "index.html").read_bytes())
        self.assertEqual(ledger, (self.root / "ledger.json").read_bytes())
        self.assertEqual(list(self.root.glob("*/R001")), [])

    def test_manifest_write_failure_rolls_back_page_and_record_move(self):
        page = (self.root / "index.html").read_bytes()
        ledger = (self.root / "ledger.json").read_bytes()
        draft = self.draft()
        real_write = workspace.atomic_write
        def fail_ledger(path, data, **kwargs):
            if path.name == "ledger.json":
                raise OSError("Synthetic disk failure")
            real_write(path, data, **kwargs)
        with mock.patch.object(workspace, "atomic_write", side_effect=fail_ledger):
            with self.assertRaises(OSError):
                workspace.register(self.root, draft)
        self.assertEqual(page, (self.root / "index.html").read_bytes())
        self.assertEqual(ledger, (self.root / "ledger.json").read_bytes())
        self.assertTrue(draft.exists())
        self.assertFalse((self.root / workspace.LOCK).exists())

    def test_user_dashboard_annotations_stop_build_without_overwriting(self):
        index = self.root / "index.html"
        original = index.read_text(encoding="utf-8") + "<!-- User annotation -->"
        index.write_text(original, encoding="utf-8")
        with self.assertRaises(workspace.WorkspaceError):
            workspace.build(self.root)
        self.assertEqual(index.read_text(encoding="utf-8"), original)
        self.assertIn("user edits", workspace.check(self.root)["warnings"][0])

    def test_manual_revision_reuses_id_and_updates_cached_metadata_on_build(self):
        registered = workspace.register(self.root, self.draft())
        path = Path(registered["path"]) / "metadata.json"
        meta = json.loads(path.read_text())
        meta["reading_status"] = "complete"
        meta["title"] = "Revised title (source checked manually)"
        path.write_text(json.dumps(meta), encoding="utf-8")
        workspace.build(self.root)
        ledger = self.ledger()
        self.assertEqual(ledger["next_number"], 2)
        self.assertEqual(len(ledger["records"]), 1)
        self.assertEqual(ledger["records"][0]["id"], "R001")
        self.assertEqual(ledger["records"][0]["metadata"]["title"], meta["title"])
        self.assertEqual(workspace.check(self.root)["complete_readings"], 1)

    def test_norman_action_aliases_and_existing_reader_link_are_preserved(self):
        draft = self.draft()
        (draft / "reader.html").write_text("<!doctype html><p>Synthetic reader</p>", encoding="utf-8")
        evidence = {"actions": [{"id": "A1", "gap": "Independent repeatability unknown", "question": "Is drift stable?", "hypothesis": "Drift follows time", "decision_rule": "Pilot-estimated reference interval", "supporting": "Stable direction across units", "weakening": "Reversal with independent units", "priority": "P1"}]}
        (draft / "evidence.json").write_text(json.dumps(evidence), encoding="utf-8")
        registered = workspace.register(self.root, draft)
        page = (self.root / "index.html").read_text(encoding="utf-8")
        relative = Path(registered["path"]).relative_to(self.root).as_posix()
        self.assertIn(f'href="{relative}/reader.html"', page)
        for value in ("Independent repeatability unknown", "Is drift stable?", "Pilot-estimated reference interval", "Stable direction across units", "Reversal with independent units"):
            self.assertIn(value, page)

    def test_readonly_check_rejects_invalid_evidence_and_image_path_escape(self):
        registered = workspace.register(self.root, self.draft())
        path = Path(registered["path"]) / "evidence.json"
        page = (self.root / "index.html").read_bytes()
        ledger = (self.root / "ledger.json").read_bytes()
        for invalid in ([], {"original_images": None}, {"original_images": [{"path": "../../../../secret.png"}]}):
            with self.subTest(invalid=invalid):
                path.write_text(json.dumps(invalid), encoding="utf-8")
                with self.assertRaises(workspace.WorkspaceError):
                    workspace.check(self.root)
        self.assertEqual((self.root / "index.html").read_bytes(), page)
        self.assertEqual((self.root / "ledger.json").read_bytes(), ledger)

    def test_saved_batch_files_are_linked_without_inline_repetition_or_execution(self):
        run = self.root / "runs" / "2026-10-21-batch-a"
        run.mkdir(parents=True)
        (run / "synthesis.md").write_text("# Synthetic synthesis\nSources disagree about units. <script>unsafe()</script>", encoding="utf-8")
        (run / "brief.md").write_text("Actual new: 0; shortage: 5. No real papers searched.", encoding="utf-8")
        (run / "search-log.json").write_text('{"source":"synthetic","queries":[]}', encoding="utf-8")
        flag = self.root / "should-not-exist.txt"
        (run / "untrusted.py").write_text("raise RuntimeError('Do not execute research materials')", encoding="utf-8")
        workspace.build(self.root)
        page = (self.root / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("Sources disagree about units.", page)
        self.assertNotIn("<script>unsafe()", page)
        self.assertNotIn("Actual new: 0; shortage: 5.", page)
        self.assertIn('href="runs/2026-10-21-batch-a/synthesis.md"', page)
        self.assertIn('href="runs/2026-10-21-batch-a/brief.md"', page)
        self.assertIn('href="runs/2026-10-21-batch-a/search-log.json"', page)
        self.assertEqual((run / 'brief.md').read_text(encoding='utf-8'), "Actual new: 0; shortage: 5. No real papers searched.")
        self.assertNotIn("untrusted.py", page)
        self.assertFalse(flag.exists())
        self.assertEqual(workspace.check(self.root)["records"], 0)

    def test_foreign_ledger_is_preserved_on_failed_publication(self):
        draft = self.draft()
        foreign = {**self.ledger(), "operator_note": "Concurrent annotation; preserve verbatim"}
        foreign_bytes = workspace.json_bytes(foreign)
        real_write = workspace.atomic_write
        def change_ledger_then_fail(path, data, **kwargs):
            if path.name == "ledger.json":
                real_write(path, foreign_bytes)
                raise OSError("Synthetic failure after a foreign edit")
            real_write(path, data, **kwargs)
        with mock.patch.object(workspace, "atomic_write", side_effect=change_ledger_then_fail):
            with self.assertRaisesRegex(workspace.RecoveryConflict, "Foreign ledger"):
                workspace.register(self.root, draft)
        self.assertEqual((self.root / "ledger.json").read_bytes(), foreign_bytes)
        # A foreign ledger might reference this directory. Do not move/delete it.
        self.assertEqual(len(list(self.root.glob("*/R001/reading-note.md"))), 1)
        self.assertFalse((self.root / workspace.LOCK).exists())

    def test_concurrent_dashboard_change_before_replace_is_preserved(self):
        draft = self.draft()
        old_ledger = (self.root / "ledger.json").read_bytes()
        foreign = b"<!doctype html><p>Concurrent user annotation</p>"
        real_write = workspace.atomic_write
        changed = False
        def edit_index_before_write(path, data, **kwargs):
            nonlocal changed
            if path.name == "index.html" and not changed:
                changed = True
                path.write_bytes(foreign)
            real_write(path, data, **kwargs)
        with mock.patch.object(workspace, "atomic_write", side_effect=edit_index_before_write):
            with self.assertRaisesRegex(workspace.RecoveryConflict, "Concurrent change"):
                workspace.register(self.root, draft)
        self.assertEqual((self.root / "index.html").read_bytes(), foreign)
        self.assertEqual((self.root / "ledger.json").read_bytes(), old_ledger)

    def test_control_file_reads_and_dashboard_publish_use_containment_guard(self):
        real_within = workspace.within
        with mock.patch.object(workspace, "within", wraps=real_within) as guarded:
            workspace.check(self.root)
            workspace.build(self.root)
        guarded_names = {call.args[1] for call in guarded.call_args_list}
        for name in (workspace.MARKER, workspace.CONFIG, workspace.MANIFEST, "index.html"):
            self.assertIn(name, guarded_names)

    def test_control_file_symlink_is_rejected_without_reading_target(self):
        outside = self.parent / "outside-marker.json"
        outside.write_text('{"private":"do not read or overwrite"}', encoding="utf-8")
        for name in (workspace.MARKER, workspace.CONFIG, workspace.MANIFEST, "index.html"):
            target = self.root / name
            original = target.read_bytes()
            target.unlink()
            try:
                target.symlink_to(outside)
            except (OSError, NotImplementedError):
                target.write_bytes(original)
                self.skipTest("Host does not permit creating filesystem symlinks; containment-call coverage is tested separately")
            try:
                with self.assertRaises(workspace.WorkspaceError):
                    workspace.check(self.root)
                with self.assertRaises(workspace.WorkspaceError):
                    workspace.build(self.root)
                self.assertEqual(outside.read_text(encoding="utf-8"), '{"private":"do not read or overwrite"}')
            finally:
                target.unlink()
                target.write_bytes(original)

    def test_revised_old_id_surfaces_in_recent_twenty_without_new_number(self):
        first = None
        for number in range(1, 22):
            result = workspace.register(self.root, self.draft(f"draft-{number}", title=f"Distinct synthetic study {number}", doi=f"10.9999/unique-{number}", analysis_date="2020-01-01"))
            if first is None:
                first = Path(result["path"])
        metadata = workspace.read_json(first / "metadata.json")
        metadata["updated_at"] = "2099-01-01T12:00:00Z"
        (first / "metadata.json").write_bytes(workspace.json_bytes(metadata))
        workspace.build(self.root)
        page = (self.root / "index.html").read_text(encoding="utf-8")
        self.assertLess(page.index('<span class="badge">R001'), page.index('<span class="badge">R021'))
        self.assertEqual(self.ledger()["next_number"], 22)
        self.assertEqual(len(self.ledger()["records"]), 21)


if __name__ == "__main__":
    unittest.main()
