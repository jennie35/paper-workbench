"""Run on the Windows/macOS host that owns the external Norman engine.

Expose only behind HTTPS or an authenticated private network. No arbitrary CLI args.
"""
import io
import os
from pathlib import Path
import secrets
import tempfile
import zipfile

from fastapi import FastAPI, Header, HTTPException, UploadFile, File, Form
from fastapi.responses import Response

from .skill import Skill

app = FastAPI(title='Norman native engine bridge', docs_url=None, redoc_url=None, openapi_url=None)


def authorize(header):
    token = os.getenv('NORMAN_BRIDGE_TOKEN', '')
    if len(token) < 32 or not secrets.compare_digest(header, 'Bearer ' + token):
        raise HTTPException(401, 'Unauthorized')


@app.get('/health')
def health(authorization: str = Header(default='')):
    authorize(authorization)
    skill = Skill()
    skill.bridge = ''
    return skill.preflight()


@app.post('/run')
async def run(bundle: UploadFile = File(...), operation: str = Form(...), pages: str = Form(default=''), authorization: str = Header(default='')):
    authorize(authorization)
    if operation not in ('extract', 'render', 'validate'):
        raise HTTPException(400, 'Unsupported operation')
    content = bytearray()
    while chunk := await bundle.read(1024 * 1024):
        content.extend(chunk)
        if len(content) > 100 * 1024 * 1024:
            raise HTTPException(413, 'Bundle too large')
    with tempfile.TemporaryDirectory(prefix='norman-bridge-') as temp:
        folder = Path(temp).resolve()
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            if sum(x.file_size for x in archive.infolist()) > 150 * 1024 * 1024:
                raise HTTPException(413, 'Unpacked bundle too large')
            for item in archive.infolist():
                path = (folder / item.filename).resolve()
                if not path.is_relative_to(folder):
                    raise HTTPException(400, 'Invalid archive')
                if not item.is_dir():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(archive.read(item))
        page_numbers = [int(x) for x in pages.split(',') if x]
        if operation == 'render' and (not page_numbers or any(not 1 <= x <= 300 for x in page_numbers)):
            raise HTTPException(400, 'Invalid pages')
        skill = Skill()
        skill.bridge = ''
        try:
            skill.operation(operation, folder, page_numbers)
        except Exception:
            raise HTTPException(422, 'Native operation failed; inspect engine availability and input structure')
        result = io.BytesIO()
        with zipfile.ZipFile(result, 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in folder.rglob('*'):
                if path.is_file() and '.engine-tmp' not in path.parts and path.name != 'paper.pdf':
                    archive.write(path, path.relative_to(folder).as_posix())
        return Response(result.getvalue(), media_type='application/zip')

