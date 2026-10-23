"""Portable reading tools with optional externally installed Norman instructions.

No third-party skill or binary is redistributed. Built-in parsing, rendering and
structural validation remain available on Linux without an external bridge.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil

REFERENCES = ['reading-workflow.md', 'figure-and-equation-reading.md',
              'evidence-and-research-cards.md', 'future-research-planning.md',
              'output-and-brand.md', 'paper-types.md']


class Skill:
    def __init__(self):
        self.root = Path(os.getenv('NORMAN_SKILL_PATH', '/skill')).resolve()
        self.applied = False
        self.enhancement_available = False
        self.native_enabled = False
        self.native_checked = False
        self.native = None

    def _paths(self):
        return [self.root / 'SKILL.md', *[self.root / 'references' / x for x in REFERENCES]]

    def instructions(self):
        if not self.native_checked:
            self.preflight()
        paths = self._paths()
        self.enhancement_available = self.native_enabled and all(path.is_file() for path in paths)
        if not self.enhancement_available:
            self.applied = False
            return ('使用 Paper Workbench 内置 extend 研究流程。Norman 外部技能不可用，'
                    '不得声称应用该技能或附加其署名。所有结论绑定正文来源，图表仅在实际图像请求后核验。')
        content = '\n\n'.join(path.read_text('utf-8-sig') for path in paths)
        self.applied = True
        return content

    def preflight(self):
        import pypdf  # noqa: F401
        import pypdfium2  # noqa: F401
        self.native_checked = True
        self.native_enabled = False
        rules_present = all(path.is_file() for path in self._paths())
        if rules_present and os.getenv('NORMAN_ENABLE', 'auto').lower() not in ('0', 'false', 'off'):
            from .norman_native import NativeNorman
            self.native = NativeNorman()
            try:
                self.native.preflight()
                self.native_enabled = True
            except Exception:
                # Having instructions alone does not mean its required engine works.
                self.applied = False
        self.enhancement_available = self.native_enabled
        return {'available': True, 'engine': 'norman_native' if self.native_enabled else 'builtin_pypdf_pdfium',
                'norman_available': self.enhancement_available,
                'reading_skill': 'norman-paper-reading' if self.enhancement_available else 'paper-workbench',
                'ocr_available': bool(shutil.which('tesseract')),
                'notice': 'Norman 原生工具与规则可用' if self.enhancement_available else 'Norman 工具不可用或未启用，使用内置研究流程'}

    def operation(self, op, folder, pages=None):
        folder = Path(folder).resolve()
        if not self.native_checked:
            self.preflight()
        if self.native_enabled:
            self.native.operation(op, folder, pages)
            if op == 'extract':
                from .reading_core import heading_section
                target = folder / 'source/source_map.json'
                source = json.loads(target.read_text('utf-8-sig'))
                section = 'unknown'
                for block in source.get('blocks', []):
                    for line in str(block.get('text', '')).splitlines():
                        heading = heading_section(line)
                        if heading:
                            section = heading
                            break
                    block.setdefault('section', section)
                    block.setdefault('extraction_method', 'norman_native')
                target.write_text(json.dumps(source, ensure_ascii=False, indent=2), 'utf-8')
            if op != 'validate':
                return
            # Native success still needs the application's core-evidence gate.
        if op == 'extract':
            from .artifacts import inspect_pdf
            records = []
            texts = inspect_pdf(folder / 'paper.pdf', page_records=records)
            from .reading_core import sectioned_blocks
            blocks = sectioned_blocks(texts, records)
            source = {'schema_version': 2,
                      'source': {'sha256': hashlib.sha256((folder / 'paper.pdf').read_bytes()).hexdigest(),
                                 'original_file': '../paper.pdf', 'page_count': len(texts),
                                 'extraction': 'pypdf_with_optional_tesseract'},
                      'pages': records, 'blocks': blocks}
            target = folder / 'source/source_map.json'
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(source, ensure_ascii=False, indent=2), 'utf-8')
        elif op == 'render':
            import pypdfium2 as pdfium
            document = pdfium.PdfDocument(folder / 'paper.pdf')
            try:
                (folder / 'assets').mkdir(exist_ok=True)
                for number in pages or []:
                    if type(number) is not int or not 1 <= number <= len(document):
                        raise ValueError('待渲染原页超出 PDF 范围')
                    page = document[number - 1]
                    try:
                        scale = min(2, 1800 / max(page.get_size()))
                        bitmap = page.render(scale=scale)
                        try:
                            bitmap.to_pil().save(folder / f'assets/page-{number}.png')
                        finally:
                            bitmap.close()
                    finally:
                        page.close()
            finally:
                document.close()
        elif op == 'validate':
            from .schemas import Analysis
            from .reading_core import validate_core_report
            analysis = json.loads((folder / 'analysis.json').read_text('utf-8-sig'))
            source = json.loads((folder / 'source/source_map.json').read_text('utf-8-sig'))
            Analysis.model_validate(analysis)
            validate_core_report(analysis, source)
            if not (folder / 'reading-note.md').is_file() or not (folder / 'evidence.json').is_file():
                raise ValueError('研究笔记或证据文件缺失，不能完成结构校验')
            (folder / ('builtin-validate-log.txt' if self.native_enabled else 'validate-log.txt')).write_text(
                '内置结构、核心内容来源及文件一致性校验通过；不证明科学结论成立。', 'utf-8')
        else:
            raise ValueError('不支持的操作')
