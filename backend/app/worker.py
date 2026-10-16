"""One worker per instance. RQ scheduler handles interrupted job retries."""
from redis import Redis
from rq import Worker
from .config import REDIS_URL
from .db import init_db

if __name__ == '__main__':
    init_db()
    Worker(['analysis'], connection=Redis.from_url(REDIS_URL)).work(with_scheduler=True)

