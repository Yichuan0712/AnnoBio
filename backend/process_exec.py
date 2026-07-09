"""
Runs a user-authored Python `process(row)` function once per dataset row, using whatever
Python interpreter (system install or a venv) the user explicitly points at in Settings --
so real third-party packages are available, unlike the sandboxed JS-in-a-Worker approach
this replaced. There's no implicit default interpreter; the caller must set one. One
persistent subprocess handles a whole run, talking newline-delimited JSON over
stdin/stdout; it's killed and respawned on a per-row timeout or crash, mirroring the Worker's
terminate()-and-restart behavior this replaced.
"""

import json
import os
import queue
import subprocess
import tempfile
import threading
import time

ROW_TIMEOUT_SEC = 10
STARTUP_CHECK_SEC = 0.3

_WRAPPER_HEADER = "import sys, json\n\n"
_WRAPPER_FOOTER = """

for _line in sys.stdin:
    _line = _line.rstrip("\\n")
    if not _line:
        continue
    try:
        _row = json.loads(_line)
        _result = process(_row)
        sys.stdout.write(json.dumps({"ok": True, "result": _result}) + "\\n")
    except Exception as _e:
        sys.stdout.write(json.dumps({"ok": False, "error": str(_e)}) + "\\n")
    sys.stdout.flush()
"""


def _build_wrapper(code: str) -> str:
    return _WRAPPER_HEADER + code + _WRAPPER_FOOTER


def check_python(python_path: str) -> dict:
    """Runs `<python_path> --version`. Returns {ok, version} or {ok: False, error}."""
    path = (python_path or "").strip()
    if not path:
        return {"ok": False, "error": "No interpreter path set"}
    try:
        proc = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=5)
        version = (proc.stdout or proc.stderr or "").strip()
        if proc.returncode != 0:
            return {"ok": False, "error": version or f"Exit code {proc.returncode}"}
        return {"ok": True, "version": version}
    except FileNotFoundError:
        return {"ok": False, "error": "Interpreter not found"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Timed out"}
    except OSError as e:
        return {"ok": False, "error": str(e)}


class _RowRunner:
    """Owns one persistent Python subprocess for a run; respawns it on timeout or crash."""

    def __init__(self, python_path: str, code: str):
        self.python_path = python_path
        self.code = code
        self.proc: subprocess.Popen | None = None
        self._tmp_path: str | None = None
        self._out_queue: "queue.Queue[str | None]" = queue.Queue()

    def _spawn(self) -> str | None:
        """Starts the subprocess. Returns an error string if it fails or crashes immediately."""
        self._cleanup_tmp_file()
        fd, path = tempfile.mkstemp(suffix=".py", prefix="process_row_")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(_build_wrapper(self.code))
        self._tmp_path = path
        try:
            self.proc = subprocess.Popen(
                [self.python_path, "-u", path],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        except OSError as e:
            self.proc = None
            return str(e)

        self._out_queue = queue.Queue()

        def _reader():
            proc = self.proc
            if proc is None or proc.stdout is None:
                return
            for line in proc.stdout:
                self._out_queue.put(line)
            self._out_queue.put(None)  # stdout closed (process exited)

        threading.Thread(target=_reader, daemon=True).start()

        # Give it a brief moment to crash on a syntax/import error before trusting it.
        time.sleep(STARTUP_CHECK_SEC)
        if self.proc.poll() is not None:
            return self._read_stderr() or f"Python process exited immediately (code {self.proc.returncode})"
        return None

    def _read_stderr(self) -> str:
        try:
            return (self.proc.stderr.read() or "").strip() if self.proc and self.proc.stderr else ""
        except (OSError, ValueError):
            return ""

    def run_row(self, row: dict) -> dict:
        """Returns {"ok": True, "result": ...} or {"ok": False, "error": ...}. Never raises."""
        if self.proc is None or self.proc.poll() is not None:
            err = self._spawn()
            if err:
                return {"ok": False, "error": err}

        try:
            self.proc.stdin.write(json.dumps(row) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError, ValueError) as e:
            self.kill()
            err = self._spawn()
            return {"ok": False, "error": err or f"Interpreter restarted after a pipe error: {e}"}

        try:
            line = self._out_queue.get(timeout=ROW_TIMEOUT_SEC)
        except queue.Empty:
            self.kill()
            return {"ok": False, "error": f"Timed out after {ROW_TIMEOUT_SEC}s"}

        if line is None:
            stderr = self._read_stderr()
            self.kill()
            return {"ok": False, "error": stderr or "Python process exited unexpectedly"}
        try:
            outcome = json.loads(line)
        except json.JSONDecodeError:
            return {"ok": False, "error": f"Malformed output: {line.strip()[:200]}"}
        if not isinstance(outcome, dict) or "ok" not in outcome:
            return {"ok": False, "error": f"Malformed output: {line.strip()[:200]}"}
        return outcome

    def _cleanup_tmp_file(self) -> None:
        if self._tmp_path:
            try:
                os.remove(self._tmp_path)
            except OSError:
                pass
            self._tmp_path = None

    def kill(self) -> None:
        if self.proc is not None:
            try:
                self.proc.kill()
                self.proc.wait(timeout=2)
            except Exception:
                pass
            self.proc = None
        self._cleanup_tmp_file()


def run_process_rows(python_path, code, headers, rows, on_row, is_cancelled):
    """
    Runs `code`'s process(row) once per row (a dict keyed by `headers`). Calls
    on_row(index, outcome) after each row, where outcome is {"ok": True, "result": ...}
    or {"ok": False, "error": ...}. Stops early once is_cancelled() returns True.
    """
    runner = _RowRunner(python_path, code)
    try:
        for i, row_values in enumerate(rows):
            if is_cancelled():
                return
            row = {h: (row_values[idx] if idx < len(row_values) else "") for idx, h in enumerate(headers)}
            outcome = runner.run_row(row)
            on_row(i, outcome)
    finally:
        runner.kill()
