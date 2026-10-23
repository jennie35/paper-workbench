"""Optional, local multilingual similarity. Never substitute lexical fake vectors."""
import hashlib
import json
import os
import threading

from .config import DATA
from .db import EmbeddingCache, session

MODEL = 'intfloat/multilingual-e5-small'
_model, _model_lock = None, threading.RLock()


def model_input(meta):
    # E5 expects the prefix even for non-English symmetric similarity tasks.
    return 'passage: ' + '\n'.join(str(meta.get(k) or '') for k in ('title', 'title_en', 'abstract'))


def get_model():
    global _model
    with _model_lock:
        if _model is None:
            try:
                from sentence_transformers import SentenceTransformer
            except ImportError:
                raise ValueError('主题相似图尚不可用：请安装 backend/requirements-embeddings.txt 并缓存 multilingual-e5-small 模型') from None
            location = os.getenv('EMBEDDING_MODEL_PATH') or MODEL
            try:
                _model = SentenceTransformer(location, cache_folder=os.getenv('EMBEDDING_CACHE_DIR', str(DATA / 'models')),
                    revision=os.getenv('EMBEDDING_MODEL_REVISION', 'main'),
                    local_files_only=os.getenv('EMBEDDING_ALLOW_DOWNLOAD') != '1', trust_remote_code=False, device='cpu')
                _model.max_seq_length = 512
            except Exception:
                raise ValueError('主题相似图尚不可用：本地模型未就绪。部署者可预缓存模型，或设置 EMBEDDING_ALLOW_DOWNLOAD=1 允许首次下载') from None
        return _model


def vectors(metadata):
    inputs = [model_input(meta) for meta in metadata]
    values, missing = [], []
    version = os.getenv('EMBEDDING_MODEL_REVISION', 'main')
    for index, text in enumerate(inputs):
        fingerprint = hashlib.sha256((MODEL + '\n' + version + '\n' + text).encode()).hexdigest()
        with session() as s:
            cached = s.get(EmbeddingCache, fingerprint)
            values.append(json.loads(cached.vector_json) if cached else None)
        if values[-1] is None:
            missing.append((index, fingerprint, text))
    if missing:
        model = get_model()
        generated = model.encode([x[2] for x in missing], normalize_embeddings=True, batch_size=16, show_progress_bar=False).tolist()
        with _model_lock, session() as s:
            for (index, fingerprint, text), vector in zip(missing, generated):
                values[index] = vector
                if not s.get(EmbeddingCache, fingerprint):
                    s.add(EmbeddingCache(fingerprint=fingerprint, model=MODEL + '@' + version,
                        input_text=text, vector_json=json.dumps(vector)))
    return values, MODEL + '@' + version
