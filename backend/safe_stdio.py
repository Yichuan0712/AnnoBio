"""Console output safe for Windows (GBK) when prompts contain Unicode (e.g. U+2011 non-breaking hyphen)."""

from __future__ import annotations

import sys


def safe_print(s: str, *, file=None, flush: bool = False) -> None:
    """Print to a text stream; on UnicodeEncodeError, write replacement-encoded bytes to the underlying buffer."""
    stream = sys.stdout if file is None else file
    try:
        print(s, file=stream, flush=flush)
    except UnicodeEncodeError:
        enc = getattr(stream, "encoding", None) or "utf-8"
        line = s if s.endswith("\n") else s + "\n"
        data = line.encode(enc, errors="replace")
        buf = getattr(stream, "buffer", None)
        if buf is not None:
            buf.write(data)
        else:
            try:
                stream.write(data.decode(enc, errors="replace"))
            except Exception:
                stream.write(line.encode("ascii", errors="replace").decode("ascii"))
        if flush:
            stream.flush()
