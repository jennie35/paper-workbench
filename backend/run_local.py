"""Start a persistent personal workspace on this computer. Never binds to a public IP."""
import argparse
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlsplit

from cryptography.fernet import Fernet


def configure(port):
    root = Path(__file__).resolve().parents[1]
    data = root / 'data'
    data.mkdir(exist_ok=True)
    private = data / 'local-settings.json'
    if private.exists():
        settings = json.loads(private.read_text('utf-8'))
    else:
        settings = {'admin_password': secrets.token_urlsafe(18), 'encryption_key': Fernet.generate_key().decode()}
        private.write_text(json.dumps(settings), 'utf-8')
        try:
            private.chmod(0o600)
        except OSError:
            pass
    os.environ.update(DATA_DIR=str(data), DATABASE_URL='sqlite:///' + (data / 'workbench.db').as_posix(), ADMIN_PASSWORD=settings['admin_password'], ENCRYPTION_KEY=settings['encryption_key'], TASK_BACKEND='local', SERVE_FRONTEND='1', FRONTEND_DIR=str(root / 'frontend'), ALLOWED_ORIGINS=f'http://127.0.0.1:{port},http://localhost:{port}')
    # Local trial mode can reuse the user's HTTP(S) proxy for the official API.
    proxy = os.getenv('HTTPS_PROXY') or os.getenv('https_proxy', '')
    if urlsplit(proxy).scheme in ('http', 'https'):
        os.environ.setdefault('OPENAI_HTTP_PROXY', proxy)
    # Reuse the installed external skill only if the deployer has not set a path.
    skill = Path.home() / '.codex/skills/norman-paper-reading'
    if skill.is_dir():
        os.environ.setdefault('NORMAN_SKILL_PATH', str(skill))
    return settings


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8095)
    parser.add_argument('--show-password', action='store_true', help='Show the generated local workspace password and exit')
    args = parser.parse_args()
    settings = configure(args.port)
    if args.show_password:
        print(settings['admin_password'])
    else:
        import uvicorn
        print(f'Personal workbench: http://127.0.0.1:{args.port}/', flush=True)
        print('Password is stored privately in data/local-settings.json. Use --show-password to display it.', flush=True)
        uvicorn.run('app.main:app', host='127.0.0.1', port=args.port, workers=1, log_level='warning', proxy_headers=False)
