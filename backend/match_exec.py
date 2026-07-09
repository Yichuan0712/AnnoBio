"""
Runs a user-authored Python `match(input_row, output_row, gt_row)` predicate to pair Score-node run
rows against ground-truth rows, using whatever Python interpreter (system install or a venv) the user
points at in Settings -- mirrors process_exec.py's persistent-subprocess/newline-delimited-JSON
approach, just with a 3-argument call signature instead of a single `row` dict.

Pairing is first-fit greedy: for each run row (in input order), try ground-truth rows (in input order,
skipping ones already claimed by an earlier run row) until `match(...)` returns a truthy value, or a
candidate raises (which is treated as that run row's error and stops further candidates for it), or
candidates are exhausted (no match).
"""

import json
import os
import queue
import subprocess
import tempfile
import threading
import time

PAIR_TIMEOUT_SEC = 10
STARTUP_CHECK_SEC = 0.3

_WRAPPER_HEADER = "import sys, json\n\n"
_WRAPPER_FOOTER = """

for _line in sys.stdin:
    _line = _line.rstrip("\\n")
    if not _line:
        continue
    try:
        _args = json.loads(_line)
        _result = match(_args["input_row"], _args["output_row"], _args["gt_row"])
        sys.stdout.write(json.dumps({"ok": True, "result": bool(_result)}) + "\\n")
    except Exception as _e:
        sys.stdout.write(json.dumps({"ok": False, "error": str(_e)}) + "\\n")
    sys.stdout.flush()
"""


def _build_wrapper(code: str) -> str:
    return _WRAPPER_HEADER + code + _WRAPPER_FOOTER


class _PairRunner:
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
        fd, path = tempfile.mkstemp(suffix=".py", prefix="match_pair_")
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

    def run_pair(self, input_row: dict, output_row: dict, gt_row: dict) -> dict:
        """Returns {"ok": True, "result": bool} or {"ok": False, "error": ...}. Never raises."""
        if self.proc is None or self.proc.poll() is not None:
            err = self._spawn()
            if err:
                return {"ok": False, "error": err}

        payload = {"input_row": input_row, "output_row": output_row, "gt_row": gt_row}
        try:
            self.proc.stdin.write(json.dumps(payload) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError, ValueError) as e:
            self.kill()
            err = self._spawn()
            return {"ok": False, "error": err or f"Interpreter restarted after a pipe error: {e}"}

        try:
            line = self._out_queue.get(timeout=PAIR_TIMEOUT_SEC)
        except queue.Empty:
            self.kill()
            return {"ok": False, "error": f"Timed out after {PAIR_TIMEOUT_SEC}s"}

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


def run_match_pairs(python_path, code, run_rows, gt_rows, on_row, is_cancelled):
    """
    First-fit greedy pairing. `run_rows` is a list of {"input_row": dict, "output_row": dict};
    `gt_rows` is a list of {"gt_row": dict}, both in the order the caller wants tried. For each run
    row (in order), tries gt rows (in order, skipping ones already claimed) until match() returns
    truthy (claims that gt row and stops) or raises (records this run row's error and stops trying
    further candidates for it) or candidates run out (no match, not an error).

    Calls on_row(index, outcome) once per run row, where outcome is one of:
      {"ok": True, "matched_gt_index": <int in gt_rows> or None}
      {"ok": False, "error": <str>}
    Stops early once is_cancelled() returns True.
    """
    runner = _PairRunner(python_path, code)
    claimed = [False] * len(gt_rows)
    try:
        for i, run_row in enumerate(run_rows):
            if is_cancelled():
                return
            matched_index = None
            errored = None
            for j, gt_row in enumerate(gt_rows):
                if claimed[j]:
                    continue
                outcome = runner.run_pair(run_row.get("input_row") or {}, run_row.get("output_row") or {}, gt_row.get("gt_row") or {})
                if not outcome.get("ok"):
                    errored = outcome.get("error") or "Unknown error"
                    break
                if outcome.get("result"):
                    matched_index = j
                    claimed[j] = True
                    break
            if errored is not None:
                on_row(i, {"ok": False, "error": errored})
            else:
                on_row(i, {"ok": True, "matched_gt_index": matched_index})
    finally:
        runner.kill()
