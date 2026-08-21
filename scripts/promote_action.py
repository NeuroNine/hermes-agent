#!/usr/bin/env python3
"""
Promotion helper: inject structured action items into the two-lane queue.

Accepts JSON on stdin or as CLI argument. Deduplicates by source + title.
Prints the item id (new or existing) to stdout for referencing in reports.

Usage:
  echo '{"title":"Check disk space","source":"cron","lane":"commander"}' | \\
      python3 promote_action.py

  python3 promote_action.py '{"title":"Upgrade deps","source":"helm","lane":"helm_proposal"}'

  # With all fields
  echo '{
    "title": "Audit NVMe health",
    "detail": "Run smartctl on both drives",
    "rationale": "Monthly maintenance",
    "risk": "low",
    "rollback": "N/A",
    "priority": "medium",
    "source": "cron",
    "lane": "commander"
  }' | python3 promote_action.py

Output: ``created <id>`` or ``exists <id>``
"""

import json
import sys
import os

# Ensure hermes-agent repo is importable
_REPO = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from tools.action_queue import create, list_items


def main(argv=None) -> int:
    # Read JSON from stdin or argv
    raw: str = ""
    # A direct call to main() is intentionally stdin-driven (important for
    # embedders and tests); the __main__ block passes command-line arguments
    # explicitly.
    args = [] if argv is None else list(argv)
    if args:
        raw = args[0]
    else:
        if sys.stdin.isatty():
            print(__doc__)
            return 0
        raw = sys.stdin.read().strip()

    if not raw:
        print("Error: no input provided", file=sys.stderr)
        return 1

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"Error: invalid JSON: {e}", file=sys.stderr)
        return 1

    if not isinstance(data, dict):
        print("Error: input must be a JSON object", file=sys.stderr)
        return 1

    title = data.get("title", "").strip()
    if not title:
        print("Error: 'title' is required", file=sys.stderr)
        return 1

    source = data.get("source", "").strip()
    lane = data.get("lane", "commander")

    # Validate lane
    from tools.action_queue import VALID_LANES
    if lane not in VALID_LANES:
        print(f"Error: lane must be one of {sorted(VALID_LANES)}, got {lane!r}", file=sys.stderr)
        return 1

    existing = next(
        (
            item for item in list_items(lane=lane)
            if item.get("source", "").strip() == source
            and item.get("title", "").strip() == title
            and item.get("status") in {"open", "discussing"}
        ),
        None,
    )
    item = existing or create(
        title=title,
        lane=lane,
        detail=data.get("detail", ""),
        rationale=data.get("rationale", ""),
        risk=data.get("risk", ""),
        rollback=data.get("rollback", ""),
        priority=data.get("priority", "medium"),
        source=source,
    )

    item_id = item.get("id", "?")
    prefix = "exists" if existing else "created"
    print(f"{prefix} {item_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))