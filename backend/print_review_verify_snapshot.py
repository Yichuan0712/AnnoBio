#!/usr/bin/env python3
"""
Print which run rows and GT rows participate in Review Verify (same expansion as app/src/reviewSuggestionTest.js).

Usage:
  python print_review_verify_snapshot.py verify_snapshot.json

JSON shape: see review_verify_debug.format_verify_debug_report (comparison_rows, targets, run_results, verify_outputs, gt_content).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from review_verify_debug import format_verify_debug_report


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"Not a file: {path}", file=sys.stderr)
        return 2
    data = json.loads(path.read_text(encoding="utf-8"))
    print(format_verify_debug_report(data).rstrip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
