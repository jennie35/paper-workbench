"""External Norman skill adapter; no third-party skill files are redistributed."""
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import zipfile

import httpx
from .config import DATA
from .security import safe_request

REFERENCES = ['reading-workflow.md', 'figure-and-equation-reading.md', 'evidence-and-research-cards.md', 'future-research-planning.md', 'output-and-brand.md', 'paper-types.md']


class Skill:
    def __init__(self):
        self.root = Path(os.getenv('NORMAN_SKILL_PATH', '/skill')).resolve()
        self.bridge = os.getenv('NORMAN_BRIDGE_URL', '').rstrip('/')
        self.token = os.getenv('NORMAN_BRIDGE_TOKEN', '')

    def instructions(self):
        paths = [self.root / 'SKILL.md'] + [self.root / 'references' / x for x in REFERENCES]
        if any(not p.is_file() for p in paths):
            raise ValueError('外部 Norman 技能或适用引用缺失，请配置 NORMAN_SKILL_PATH')
        return '\n\n'.join(p.read_text('utf-8-sig') for p in paths)

    def command(self):
        if platform.system() == 'Windows':
            return [str(self.root / 'bin/windows-x64/norman-reader.exe')]
        if platform.system() == 'Darwin':
            return ['/bin/sh', str(self.root / 'bin/norman-reader')]
        raise ValueError('当前技能原生引擎仅支持 Windows/macOS；Linux 请配置 HTTPS Norman bridge')

    def preflight(self):
        self.instructions()
        if self.bridge:
            from .security import public_url
            public_url(self.bridge)
            if not self.token:
                raise ValueError('NORMAN_BRIDGE_TOKEN 缺失')
            r = safe_request('GET', self.bridge + '/health', headers={'Authorization': 'Bearer ' + self.token}, timeout=30)
            r.raise_for_status()
            return r.json()
        folder = DATA / 'engine-check'
        folder.mkdir(parents=True, exist_ok=True)
        self.run(['version'], folder)
        return {'available': True, 'engine': platform.system()}

    def run(self, args, cwd):
        scratch = Path(cwd) / '.engine-tmp'
        scratch.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, TEMP=str(scratch.resolve()), TMP=str(scratch.resolve()))
        result = subprocess.run(self.command() + args, cwd=cwd, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300)
        if result.returncode:
            raise ValueError('Norman 引擎失败：' + result.stdout[-1200:] + result.stderr[-600:])
        return result.stdout

    def operation(self, op, folder, pages=None):
        folder = Path(folder).resolve()
        if self.bridge:
            payload = io.BytesIO()
            with zipfile.ZipFile(payload, 'w', zipfile.ZIP_DEFLATED) as z:
                if op in ('extract', 'render'):
                    z.write(folder / 'paper.pdf', 'paper.pdf')
                else:
                    for name in ['reading-note.md', 'evidence.json', 'source/source_map.json']:
                        z.write(folder / name, name)
                    for p in (folder / 'assets').glob('*.png'):
                        z.write(p, 'assets/' + p.name)
                    if (folder / 'assets/research-flow.svg').exists():
                        z.write(folder / 'assets/research-flow.svg', 'assets/research-flow.svg')
            with httpx.Client(timeout=360, trust_env=False) as c:
                r = safe_request('POST', self.bridge + '/run', headers={'Authorization': 'Bearer ' + self.token}, data={'operation': op, 'pages': ','.join(map(str, pages or []))}, files={'bundle': ('input.zip', payload.getvalue(), 'application/zip')}, timeout=360)
                r.raise_for_status()
                if len(r.content) > 100 * 1024 * 1024:
                    raise ValueError('引擎响应过大')
                with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                    if sum(x.file_size for x in z.infolist()) > 150 * 1024 * 1024:
                        raise ValueError('引擎解包结果过大')
                    for info in z.infolist():
                        target = (folder / info.filename).resolve()
                        if not target.is_relative_to(folder) or info.file_size > 100 * 1024 * 1024:
                            raise ValueError('无效引擎结果路径')
                        if not info.is_dir():
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(z.read(info))
            return
        if op == 'extract':
            args = ['extract', str(folder / 'paper.pdf'), '--out', str(folder / 'source')]
        elif op == 'render':
            args = ['render', str(folder / 'paper.pdf'), '--pages', ','.join(map(str, pages)), '--out', str(folder / 'assets')]
        elif op == 'validate':
            args = ['validate', str(folder / 'reading-note.md'), '--mode', 'extend', '--evidence', str(folder / 'evidence.json'), '--source-map', str(folder / 'source/source_map.json')]
        else:
            raise ValueError('不支持的操作')
        output = self.run(args, folder)
        (folder / (op + '-log.txt')).write_text(output, 'utf-8')

