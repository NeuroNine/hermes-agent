#!/usr/bin/env python3
"""
Durable two-lane action queue backed by JSONL.

Lanes:
  - ``commander``: items requiring the Commander's input or action.
  - ``helm_proposal``: proposed changes HELM wants to make, requiring explicit
    approval before execution by a later worker.

The queue is stored as a JSONL file under ``$HERMES_HOME/action_queue.jsonl``
(profile-safe via ``get_hermes_home()``).  The existing autonomous worker at
``~/.hermes/todos.jsonl`` is left untouched; HELM proposals are *never*
written to that file, so the worker never sees them.

Backward compatibility with existing todos.jsonl:
  - The module writes only to its own ``action_queue.jsonl``.
  - On first read, if ``action_queue.jsonl`` does not exist, it scans the
    legacy ``todos.jsonl`` for ``commander``-lane items and imports them
    transparently (no data loss).
  - The legacy file is read-only; no writes go there.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

VALID_LANES = {"commander", "helm_proposal"}
VALID_STATUSES = {
    "open",           # newly created, not yet acted upon
    "approved",       # HELM proposal: user said yes
    "rejected",       # HELM proposal: user said no
    "discussing",     # under discussion (user engaged)
    "in_progress",    # being worked on
    "done",           # completed
    "dismissed",      # dismissed without action
}
# Subset of statuses the autonomous worker recognizes for legacy items
LEGACY_ACTIVE_STATUSES = {"open", "paused", "in_progress"}

# Default lane for items without an explicit lane
DEFAULT_LANE = "commander"


@dataclass
class ActionItem:
    """A single action item in the durable queue."""

    id: str = ""
    lane: str = DEFAULT_LANE
    title: str = ""
    detail: str = ""
    rationale: str = ""
    risk: str = ""
    rollback: str = ""
    priority: str = "medium"  # low, medium, high, critical
    source: str = ""          # e.g. "helm", "cron", "commander"
    status: str = "open"
    created: str = ""         # ISO-8601
    updated: str = ""         # ISO-8601
    progress: str = ""        # free-form progress note
    approval: Dict[str, Any] = field(default_factory=dict)
    # approval schema:
    #   {
    #       "approved_by": str,     # user identifier
    #       "approved_at": str,     # ISO-8601
    #       "approved_via": str,    # "telegram", "cli", "gateway"
    #       "notes": str,           # optional rejection/discussion notes
    #   }

    def __post_init__(self) -> None:
        now = _now_iso()
        if not self.id:
            self.id = _generate_id(self.title, self.lane)
        if not self.created:
            self.created = now
        if not self.updated:
            self.updated = now
        self.lane = self.lane if self.lane in VALID_LANES else DEFAULT_LANE
        if self.status not in VALID_STATUSES:
            self.status = "open"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ActionItem":
        import dataclasses
        # Filter to known fields, provide defaults for missing
        known = {f.name for f in dataclasses.fields(cls)}
        filtered = {k: v for k, v in d.items() if k in known}
        return cls(**filtered)

    @classmethod
    def from_legacy_dict(cls, d: Dict[str, Any]) -> Optional["ActionItem"]:
        """Convert a legacy todos.jsonl dict to an ActionItem.

        Legacy format has no lane field; we assign to ``commander`` lane.
        Returns None if the item should be skipped (empty or unparseable).
        """
        if not isinstance(d, dict):
            return None
        title = str(d.get("title", d.get("content", ""))).strip()
        if not title:
            return None
        status = str(d.get("status", "open")).strip().lower()
        if status not in VALID_STATUSES and status in LEGACY_ACTIVE_STATUSES:
            pass  # keep legacy statuses that overlap
        elif status not in VALID_STATUSES:
            status = "open"
        return cls(
            id=str(d.get("id", _generate_id(title, "commander"))),
            lane="commander",
            title=title,
            detail=str(d.get("detail", "")),
            rationale=str(d.get("rationale", "")),
            risk=str(d.get("risk", "")),
            rollback=str(d.get("rollback", "")),
            priority=str(d.get("priority", "medium")),
            source=str(d.get("source", "legacy")),
            status=status,
            created=str(d.get("created", _now_iso())),
            updated=str(d.get("updated", _now_iso())),
            progress=str(d.get("progress", "")),
            approval=dict(d.get("approval", {})),
        )


# ---------------------------------------------------------------------------
# Utils
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _generate_id(title: str, lane: str) -> str:
    """Produce a short stable-ish id from title and a uuid prefix."""
    raw = f"{lane[:2]}-{uuid.uuid4().hex[:12]}"
    return raw


def _get_hermes_home() -> Path:
    """Get the profile-safe Hermes home directory."""
    from hermes_constants import get_hermes_home
    return get_hermes_home()


# ---------------------------------------------------------------------------
# Persistent queue
# ---------------------------------------------------------------------------

_QUEUE_PATH: Optional[Path] = None
_lock = threading.RLock()


def _queue_path() -> Path:
    global _QUEUE_PATH
    if _QUEUE_PATH is None:
        _QUEUE_PATH = _get_hermes_home() / "action_queue.jsonl"
    return _QUEUE_PATH


def _legacy_todos_path() -> Path:
    return _get_hermes_home() / "todos.jsonl"


def _read_lines(path: Path) -> List[str]:
    """Read non-empty lines from a JSONL file, returning empty list if missing."""
    try:
        with open(path, "r") as f:
            return [line.strip() for line in f if line.strip()]
    except FileNotFoundError:
        return []
    except (OSError, PermissionError) as e:
        logger.warning("Failed to read %s: %s", path, e)
        return []


def _append_line(path: Path, item: ActionItem) -> None:
    """Append a single line to a JSONL file, creating parent dirs."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(item.to_dict(), ensure_ascii=False) + "\n")


def _rewrite_lines(path: Path, items: List[ActionItem]) -> None:
    """Atomically rewrite the entire JSONL file (write to temp, rename)."""
    tmp = path.with_suffix(".jsonl.tmp")
    with open(tmp, "w") as f:
        for item in items:
            f.write(json.dumps(item.to_dict(), ensure_ascii=False) + "\n")
    tmp.replace(path)


def _import_legacy_if_needed() -> None:
    """On first access, import legacy todos.jsonl items to action_queue.jsonl if
    the new file doesn't exist yet."""
    queue_file = _queue_path()
    legacy = _legacy_todos_path()
    if not legacy.exists():
        return  # no legacy data
    # An empty queue file may have been created by init() before legacy data
    # arrived (or by a test/setup probe).  Import in that case as well; a
    # non-empty queue is authoritative and must never be merged implicitly.
    if queue_file.exists() and queue_file.stat().st_size > 0:
        return
    lines = _read_lines(legacy)
    items: List[ActionItem] = []
    for line in lines:
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            continue
        item = ActionItem.from_legacy_dict(raw)
        if item is not None:
            items.append(item)
    if items:
        _rewrite_lines(queue_file, items)
        logger.info("Imported %d legacy items from %s", len(items), legacy.name)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def init() -> None:
    """Ensure the queue file exists and legacy data is imported.

    Safe to call multiple times.
    """
    with _lock:
        _import_legacy_if_needed()
        path = _queue_path()
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("")


def list_items(
    lane: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """List action items, optionally filtered by lane and/or status.

    Returns plain dicts sorted by ``created`` descending (newest first).
    """
    with _lock:
        init()
        raw = _read_lines(_queue_path())
        items: List[ActionItem] = []
        for line in raw:
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            item = ActionItem.from_dict(d)
            if lane and item.lane != lane:
                continue
            if status and item.status != status:
                continue
            items.append(item)
    # Sort by created descending
    items.sort(key=lambda x: x.created, reverse=True)
    return [i.to_dict() for i in items[:limit]]


def create(
    title: str,
    lane: str = DEFAULT_LANE,
    detail: str = "",
    rationale: str = "",
    risk: str = "",
    rollback: str = "",
    priority: str = "medium",
    source: str = "",
    **extra: Any,
) -> Dict[str, Any]:
    """Create a new action item and persist it.

    Returns the serialized item dict including the assigned id.
    """
    with _lock:
        init()
        # Deduplicate: if source + title match an existing open item, return it
        existing = _find_duplicate(source, title, lane)
        if existing is not None:
            return existing.to_dict()

        item = ActionItem(
            title=title.strip(),
            lane=lane,
            detail=detail.strip(),
            rationale=rationale.strip(),
            risk=risk.strip(),
            rollback=rollback.strip(),
            priority=priority,
            source=source.strip() if source else "",
        )
        _append_line(_queue_path(), item)
        logger.info("Created action item %s in lane %s: %s", item.id, item.lane, item.title)
        return item.to_dict()


def _find_duplicate(source: str, title: str, lane: str) -> Optional[ActionItem]:
    """Return an existing open item matching source + title in the given lane,
    or None."""
    raw = _read_lines(_queue_path())
    for line in raw:
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("lane") != lane:
            continue
        if d.get("status") not in ("open", "discussing"):
            continue
        if d.get("title", "").strip() == title.strip() and d.get("source", "") == source.strip():
            return ActionItem.from_dict(d)
    return None


def get(item_id: str) -> Optional[Dict[str, Any]]:
    """Fetch a single item by id."""
    with _lock:
        raw = _read_lines(_queue_path())
        for line in raw:
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("id") == item_id:
                return ActionItem.from_dict(d).to_dict()
    return None


def update_status(item_id: str, new_status: str, **meta: Any) -> Optional[Dict[str, Any]]:
    """Update the status of an item and persist.

    Returns the updated item dict, or None if not found.
    Extra keyword args are merged into the item (e.g. progress, approval).
    """
    if new_status not in VALID_STATUSES:
        raise ValueError(f"Invalid status: {new_status!r}. Valid: {sorted(VALID_STATUSES)}")

    with _lock:
        init()
        path = _queue_path()
        raw = _read_lines(path)
        found = False
        items: List[ActionItem] = []
        for line in raw:
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("id") == item_id:
                # Update this item
                item = ActionItem.from_dict(d)
                item.status = new_status
                item.updated = _now_iso()
                # Apply extra metadata safely
                import dataclasses as _dc
                for k, v in meta.items():
                    if k in {f.name for f in _dc.fields(ActionItem)}:
                        setattr(item, k, v)
                items.append(item)
                found = True
            else:
                items.append(ActionItem.from_dict(d))
        if not found:
            return None
        _rewrite_lines(path, items)
        # Return the item that was actually updated, not the final item in the
        # file (which may belong to another lane).
        for item in items:
            if item.id == item_id:
                return item.to_dict()
        return None


def delete(item_id: str) -> bool:
    """Remove an item entirely."""
    with _lock:
        init()
        path = _queue_path()
        raw = _read_lines(path)
        new_items: List[ActionItem] = []
        found = False
        for line in raw:
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("id") == item_id:
                found = True
            else:
                new_items.append(ActionItem.from_dict(d))
        if not found:
            return False
        _rewrite_lines(path, new_items)
        return True


def promote(
    source: str,
    title: str,
    lane: str = DEFAULT_LANE,
    detail: str = "",
    rationale: str = "",
    risk: str = "",
    rollback: str = "",
    priority: str = "medium",
) -> str:
    """Promote a structured action item into the queue.

    Deduplicates by source + title. Returns the item id (new or existing).
    This is the API callable by cron/report jobs.
    """
    item_dict = create(
        title=title, lane=lane, detail=detail,
        rationale=rationale, risk=risk, rollback=rollback,
        priority=priority, source=source,
    )
    return str(item_dict["id"])


# ---------------------------------------------------------------------------
# CLI helper: render items for terminal display
# ---------------------------------------------------------------------------

def format_item_short(item: Dict[str, Any]) -> str:
    """One-line summary of an action item for CLI / gateway listing."""
    status_icons = {
        "open": "🟢",
        "approved": "✅",
        "rejected": "❌",
        "discussing": "💬",
        "in_progress": "🔄",
        "done": "✔️",
        "dismissed": "⏭️",
    }
    icon = status_icons.get(item.get("status", ""), "❓")
    item_id = item.get("id", "?")[:16]  # truncate for display
    title = item.get("title", "(untitled)")
    lane_tag = item.get("lane", "?")[:2]
    priority = item.get("priority", "medium")
    priority_tag = ""
    if priority == "high":
        priority_tag = " 🔥"
    elif priority == "critical":
        priority_tag = " 🚨"
    elif priority == "low":
        priority_tag = " ↓"
    return f"{icon} `{item_id}` [{lane_tag}] {title}{priority_tag}"


def list_formatted(
    lane: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
) -> List[str]:
    """Return a list of formatted short lines for display."""
    items = list_items(lane=lane, status=status, limit=limit)
    if not items:
        if lane:
            return [f"(no items in lane '{lane}')"]
        return ["(no items in queue)"]
    result: List[str] = []
    for item in items:
        result.append(format_item_short(item))
    return result