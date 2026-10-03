"""Console output safe for Windows when prompts contain Unicode (CJK, U+2011, etc.)."""

from __future__ import annotations

import sys


def ensure_console_utf8_windows() -> None:
    """Set Windows console input/output code page to UTF-8 (65001) so UTF-8 bytes display correctly."""
    if sys.platform != "win32":
        return
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
        ctypes.windll.kernel32.SetConsoleCP(65001)
    except Exception:
        pass


def safe_print(s: str, *, file=None, flush: bool = False) -> None:
    """Print to a text stream; on Windows prefer raw UTF-8 to the binary buffer to avoid GBK/UTF-8 mismatch."""
    stream = sys.stdout if file is None else file
    line = s if s.endswith("\n") else s + "\n"

    if sys.platform == "win32":
        buf = getattr(stream, "buffer", None)
        if buf is not None:
            try:
                buf.write(line.encode("utf-8", errors="replace"))
                if flush:
                    buf.flush()
                return
            except Exception:
                pass

    try:
        print(s, file=stream, flush=flush)
        return
    except Exception:
        # Logging must never break the job that is being logged. On Windows an orphaned
        # Electron pipe can raise OSError(22) here after its owning process exits.
        pass

    try:
        enc = getattr(stream, "encoding", None) or "utf-8"
        data = line.encode(enc, errors="replace")
        buf = getattr(stream, "buffer", None)
        if buf is not None:
            buf.write(data)
        else:
            stream.write(data.decode(enc, errors="replace"))
        if flush:
            stream.flush()
    except Exception:
        pass
