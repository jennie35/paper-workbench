"""Deployment configuration. Never load research data from outside DATA_DIR."""
import os
from pathlib import Path

DATA = Path(os.getenv('DATA_DIR', './data')).resolve()
DATABASE_URL = os.getenv('DATABASE_URL', 'sqlite:///' + (DATA / 'workbench.db').as_posix())
REDIS_URL = os.getenv('REDIS_URL', 'redis://redis:6379/0')
ALLOWED_ORIGINS = [x.strip() for x in os.getenv('ALLOWED_ORIGINS', 'http://localhost:8080').split(',') if x.strip()]
MAX_BYTES = 50 * 1024 * 1024
MAX_PAGES = 300
STAGES = ['接口预检', '检索', '去重', '获取全文', '分析', '图表核验', '校验', '完成']
TASK_BACKEND = os.getenv('TASK_BACKEND', 'rq')
