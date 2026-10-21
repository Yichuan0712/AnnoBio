"""Pure ports of the app's text operations and Thompson sampler (no app imports)."""
from __future__ import annotations

import math
import re
from typing import Callable


def find_segment(content: str, old: str) -> str | None:
    """app/src/reviewWorkingText.js findSegmentInContent, including first-match behavior."""
    if not content or not old.strip():
        return None
    if old in content:
        return old
    trimmed = old.strip()
    if trimmed in content:
        return trimmed
    # JS escapes punctuation, then replaces actual whitespace runs with \\s+.
    pattern = r"\s+".join(re.escape(part) for part in re.split(r"\s+", trimmed))
    match = re.search(pattern, content)
    return match.group(0) if match else None


def resolve_unique_span(content: str, old: str) -> str | None:
    """Use the original backend resolver, plus a no-dependency whitespace fallback.

    Install the `original` extra to retain its RapidFuzz branch as well. The
    original truncation, Markdown and unique-prefix logic is preserved in spans.py.
    """
    from .spans import _resolve_old_sentence_unique
    hit = _resolve_old_sentence_unique(content, old)
    if hit is not None:
        return hit
    segment = find_segment(content, old)
    if segment is not None:
        start = content.find(segment)
        return segment if content.find(segment, start + 1) < 0 else None
    quotes = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u00a0": " "})

    def normalized(text):
        chars, positions = [], []
        for index, character in enumerate(text):
            for char in character.translate(quotes):
                if not char.isspace():
                    chars.append(char)
                    positions.append(index)
        return "".join(chars), positions

    text, positions = normalized(content)
    needle, _ = normalized(old)
    start = text.find(needle) if needle else -1
    if start < 0 or text.find(needle, start + 1) >= 0:
        return None
    return content[positions[start]:positions[start + len(needle) - 1] + 1]


def paragraph_around(text: str, old: str) -> str:
    segment = find_segment(text, old)
    if segment is None:
        return text
    at = text.find(segment)
    before = text.rfind("\n\n", 0, at + 1)
    after = text.find("\n\n", at + len(segment))
    return text[0 if before < 0 else before + 2:len(text) if after < 0 else after].strip()


def sample_beta(a: float, b: float, uniform: Callable[[], float]) -> float:
    """Port of reviewSuggestionOptimization.js's Gaussian/Gamma/Beta sampler.

    Passing the same uniform stream permits checking parity independently of
    the host language's default RNG. Zero uniforms have JS-like log(0) semantics.
    """
    if not (a > 0 and b > 0):
        return 0.5

    def gaussian():
        u = uniform()
        log = math.log(u) if u > 0 else -math.inf
        return math.sqrt(-2 * log) * math.cos(2 * math.pi * uniform())

    def gamma(shape):
        if shape < 1:
            return gamma(1 + shape) * math.pow(uniform(), 1 / shape)
        d = shape - 1 / 3
        c = 1 / math.sqrt(9 * d)
        while True:
            while True:
                x = gaussian()
                v = 1 + c * x
                if v > 0:
                    break
            v = v * v * v
            u = uniform()
            if u < 1 - 0.0331 * x * x * x * x:
                return d * v
            if (math.log(u) if u > 0 else -math.inf) < 0.5 * x * x + d * (1 - v + math.log(v)):
                return d * v

    x, y = gamma(a), gamma(b)
    return x / (x + y) if x + y > 0 else 0.5
