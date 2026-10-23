"""Chinese title variants are review hints, never scientific identity proof."""
from functools import lru_cache

from .discovery import title_key


@lru_cache(maxsize=1)
def chinese_converter():
    try:
        from opencc import OpenCC
        return OpenCC('t2s')
    except ImportError:
        return None


def review_title_keys(meta):
    converter = chinese_converter()
    variants = [meta.get('title') or '', meta.get('title_en') or '', *(meta.get('title_aliases') or [])]
    return {title_key(converter.convert(str(value)) if converter else str(value)) for value in variants if value}
