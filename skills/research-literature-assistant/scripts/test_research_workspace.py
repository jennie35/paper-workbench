"""Synthetic behavioral tests. No network, installed skills or private library required."""
import importlib.util
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

    def test_saved_synthesis_brief_and_search_log_are_shown_without_execution(self):
        run = self.root / "runs" / "2026-10-21-batch-a"
        run.mkdir(parents=True)
        (run / "synthesis.md").write_text("# Synthetic synthesis\nSources disagree about units. <script>unsafe()</script>", encoding="utf-8")
        (run / "brief.md").write_text("Actual new: 0; shortage: 5. No real papers searched.", encoding="utf-8")
        (run / "search-log.json").write_text('{"source":"synthetic","queries":[]}', encoding="utf-8")
        flag = self.root / "should-not-exist.txt"
        (run / "untrusted.py").write_text("raise RuntimeError('Do not execute research materials')", encoding="utf-8")
        workspace.build(self.root)
        page = (self.root / "index.html").read_text(encoding="utf-8")
        self.assertIn("Sources disagree about units.", page)
        self.assertIn("&lt;script&gt;unsafe()&lt;/script&gt;", page)
        self.assertNotIn("<script>unsafe()", page)
        self.assertIn("Actual new: 0; shortage: 5.", page)
        self.assertIn('href="runs/2026-10-21-batch-a/search-log.json"', page)
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
