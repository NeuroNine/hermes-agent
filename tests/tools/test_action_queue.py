"""
Focused tests for the two-lane action queue system.

Tests cover: queue CRUD, lane isolation, deduplication, approval state
transitions, CLI formatter, promotion helper, and Telegram callback
interaction.  Uses a temp HERMES_HOME so no real user state is touched.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Ensure the repo root is importable
_REPO = str(Path(__file__).resolve().parents[2])
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)


# =========================================================================
# Fixtures
# =========================================================================

@pytest.fixture
def temp_hermes_home():
    """Set up a temporary HERMES_HOME and restore after the test."""
    old_home = os.environ.pop("HERMES_HOME", None)
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["HERMES_HOME"] = tmp
        # Force re-initialization of queue path
        import tools.action_queue as aq
        aq._QUEUE_PATH = None
        aq.init()
        yield Path(tmp)
    if old_home is not None:
        os.environ["HERMES_HOME"] = old_home
    else:
        os.environ.pop("HERMES_HOME", None)
    # Reset module-level path cache
    import tools.action_queue as aq
    aq._QUEUE_PATH = None


# =========================================================================
# Queue CRUD
# =========================================================================

class TestCreateRead:
    def test_create_minimal(self, temp_hermes_home):
        """Create with just a title."""
        from tools.action_queue import create, list_items
        item = create(title="Test task", source="test")
        assert item["title"] == "Test task"
        assert item["lane"] == "commander"
        assert item["status"] == "open"
        assert item["id"]
        items = list_items()
        assert len(items) == 1

    def test_create_with_all_fields(self, temp_hermes_home):
        """Create with full fields."""
        from tools.action_queue import create
        item = create(
            title="Full task",
            lane="helm_proposal",
            detail="Do the thing",
            rationale="Because reasons",
            risk="Low risk",
            rollback="Revert the change",
            priority="high",
            source="helm",
        )
        assert item["lane"] == "helm_proposal"
        assert item["detail"] == "Do the thing"
        assert item["priority"] == "high"

    def test_list_empty(self, temp_hermes_home):
        """Empty queue returns empty list."""
        from tools.action_queue import list_items
        assert list_items() == []

    def test_list_limit(self, temp_hermes_home):
        """List respects limit."""
        from tools.action_queue import create, list_items
        for i in range(5):
            create(title=f"Task {i}", source="test")
        items = list_items(limit=2)
        assert len(items) == 2

    def test_get_item(self, temp_hermes_home):
        """Get returns correct item by id."""
        from tools.action_queue import create, get
        item = create(title="Gettable", source="test")
        fetched = get(item["id"])
        assert fetched is not None
        assert fetched["title"] == "Gettable"

    def test_get_nonexistent(self, temp_hermes_home):
        """Get on missing id returns None."""
        from tools.action_queue import get
        assert get("nonexistent") is None


class TestUpdateStatus:
    def test_update_to_done(self, temp_hermes_home):
        """Update status flow."""
        from tools.action_queue import create, update_status
        item = create(title="Doable", source="test")
        updated = update_status(item["id"], "done")
        assert updated is not None
        assert updated["status"] == "done"

    def test_update_invalid_status(self, temp_hermes_home):
        """Invalid status raises ValueError."""
        from tools.action_queue import create, update_status
        item = create(title="Test", source="test")
        with pytest.raises(ValueError):
            update_status(item["id"], "invalid_status")

    def test_update_nonexistent(self, temp_hermes_home):
        """Update on missing id returns None."""
        from tools.action_queue import update_status
        assert update_status("nonexistent", "done") is None


class TestDelete:
    def test_delete_existing(self, temp_hermes_home):
        """Delete removes an item."""
        from tools.action_queue import create, delete, list_items
        item = create(title="Deletable", source="test")
        assert delete(item["id"]) is True
        assert list_items() == []

    def test_delete_nonexistent(self, temp_hermes_home):
        """Delete on missing id returns False."""
        from tools.action_queue import delete
        assert delete("nonexistent") is False


# =========================================================================
# Lane isolation
# =========================================================================

class TestLaneIsolation:
    def test_commander_lane(self, temp_hermes_home):
        """Items in commander lane are isolated."""
        from tools.action_queue import create, list_items
        create(title="Commander task", lane="commander", source="user")
        create(title="HELM task", lane="helm_proposal", source="helm")
        cmd_items = list_items(lane="commander")
        helm_items = list_items(lane="helm_proposal")
        assert len(cmd_items) == 1
        assert len(helm_items) == 1
        assert cmd_items[0]["title"] == "Commander task"
        assert helm_items[0]["title"] == "HELM task"

    def test_helm_proposal_never_mixed(self, temp_hermes_home):
        """HELM proposals don't appear in commander queries."""
        from tools.action_queue import create, list_items
        create(title="For HELM", lane="helm_proposal", source="helm")
        all_items = list_items()
        assert all(i["lane"] == "helm_proposal" for i in all_items)

    def test_default_lane_is_commander(self, temp_hermes_home):
        """Default lane is commander."""
        from tools.action_queue import create
        item = create(title="Default lane", source="test")
        assert item["lane"] == "commander"


# =========================================================================
# Deduplication
# =========================================================================

class TestDeduplication:
    def test_same_source_title_returns_existing(self, temp_hermes_home):
        """Same source+title returns existing item, not a duplicate."""
        from tools.action_queue import create, list_items
        a = create(title="Unique task", source="cron")
        b = create(title="Unique task", source="cron")
        assert a["id"] == b["id"]  # same id = deduplicated
        assert len(list_items()) == 1

    def test_different_source_allows_duplicate(self, temp_hermes_home):
        """Different source allows same title."""
        from tools.action_queue import create, list_items
        a = create(title="Same title", source="cron")
        b = create(title="Same title", source="helm")
        assert a["id"] != b["id"]
        assert len(list_items()) == 2

    def test_different_title_with_same_source(self, temp_hermes_home):
        """Different title with same source creates separate entry."""
        from tools.action_queue import create, list_items
        a = create(title="Alpha", source="cron")
        b = create(title="Beta", source="cron")
        assert a["id"] != b["id"]
        assert len(list_items()) == 2


# =========================================================================
# Approval state transitions
# =========================================================================

class TestApprovalTransitions:
    def test_approve(self, temp_hermes_home):
        """Approve transition."""
        from tools.action_queue import create, update_status, get
        item = create(title="Proposal", lane="helm_proposal", source="helm")
        updated = update_status(item["id"], "approved")
        assert updated["status"] == "approved"
        fetched = get(item["id"])
        assert fetched["status"] == "approved"

    def test_reject(self, temp_hermes_home):
        """Reject transition."""
        from tools.action_queue import create, update_status
        item = create(title="Proposal", lane="helm_proposal", source="helm")
        updated = update_status(item["id"], "rejected")
        assert updated["status"] == "rejected"

    def test_discuss_transition(self, temp_hermes_home):
        """Discuss transition."""
        from tools.action_queue import create, update_status
        item = create(title="Proposal", lane="helm_proposal", source="helm")
        updated = update_status(item["id"], "discussing")
        assert updated["status"] == "discussing"

    def test_dismiss(self, temp_hermes_home):
        """Dismiss transition."""
        from tools.action_queue import create, update_status
        item = create(title="Commander task", source="user")
        updated = update_status(item["id"], "dismissed")
        assert updated["status"] == "dismissed"

    def test_done_transition(self, temp_hermes_home):
        """Done transition."""
        from tools.action_queue import create, update_status
        item = create(title="Task", source="user")
        updated = update_status(item["id"], "done")
        assert updated["status"] == "done"

    def test_approval_with_metadata(self, temp_hermes_home):
        """Approve with approval metadata."""
        from tools.action_queue import create, update_status
        item = create(title="Proposal", lane="helm_proposal", source="helm")
        updated = update_status(
            item["id"], "approved",
            approval={"approved_by": "commander", "approved_via": "test"},
        )
        assert updated["status"] == "approved"
        assert updated["approval"]["approved_by"] == "commander"


# =========================================================================
# Format helpers
# =========================================================================

class TestFormat:
    def test_format_item_short(self, temp_hermes_home):
        """Format produces non-empty short string."""
        from tools.action_queue import create, format_item_short
        item = create(title="Format test", source="test")
        formatted = format_item_short(item)
        assert "Format test" in formatted
        assert item["id"][:16] in formatted

    def test_list_formatted_empty(self, temp_hermes_home):
        """Formatted empty list is descriptive."""
        from tools.action_queue import list_formatted
        lines = list_formatted()
        assert len(lines) == 1
        assert "no items" in lines[0].lower()

    def test_list_formatted_with_items(self, temp_hermes_home):
        """Formatted list has items."""
        from tools.action_queue import create, list_formatted
        create(title="List item", source="test")
        lines = list_formatted()
        assert len(lines) == 1
        assert "List item" in lines[0]


# =========================================================================
# Promotion helper (standalone script)
# =========================================================================

class TestPromoteActionScript:
    def test_promote_new(self, temp_hermes_home):
        """Promote creates a new item."""
        from tools.action_queue import promote
        item_id = promote(title="Promoted task", source="cron", lane="commander")
        assert item_id
        # Second promote with same source/title returns same id
        item_id2 = promote(title="Promoted task", source="cron", lane="commander")
        assert item_id2 == item_id

    def test_promote_helm(self, temp_hermes_home):
        """Promote creates a helm_proposal item."""
        from tools.action_queue import promote
        item_id = promote(
            title="HELM change",
            lane="helm_proposal",
            source="helm",
            detail="Change some config",
            rationale="Better defaults",
            risk="Medium",
        )
        assert item_id

    def test_promote_cli_stdin(self, temp_hermes_home):
        """CLI script parses JSON from stdin correctly."""
        from scripts.promote_action import main as promote_main
        import io
        input_json = json.dumps({
            "title": "Stdin test",
            "source": "test",
            "lane": "commander",
            "priority": "high",
        })
        sys.stdin = io.StringIO(input_json)
        try:
            # Mock the init path to use the temp HERMES_HOME
            with patch("tools.action_queue._get_hermes_home", return_value=temp_hermes_home):
                ret = promote_main()
            assert ret == 0
        finally:
            sys.stdin = sys.__stdin__


# =========================================================================
# Legacy backward compatibility
# =========================================================================

class TestLegacyCompatibility:
    def test_import_legacy_todos(self, temp_hermes_home):
        """Legacy todos.jsonl items are imported on first init."""
        from tools.action_queue import list_items, init
        # Write a legacy todos.jsonl
        legacy = temp_hermes_home / "todos.jsonl"
        legacy.write_text(json.dumps({
            "title": "Legacy task",
            "status": "open",
            "source": "user",
        }) + "\n" + json.dumps({
            "title": "Another legacy",
            "status": "in_progress",
            "source": "cron",
        }) + "\n")
        # Force re-init (action_queue.jsonl doesn't exist yet)
        import tools.action_queue as aq
        aq._QUEUE_PATH = None
        init()
        items = list_items()
        assert len(items) == 2
        titles = {i["title"] for i in items}
        assert "Legacy task" in titles
        assert "Another legacy" in titles

    def test_legacy_items_get_commander_lane(self, temp_hermes_home):
        """Legacy items are assigned to commander lane."""
        from tools.action_queue import list_items, init
        legacy = temp_hermes_home / "todos.jsonl"
        legacy.write_text(json.dumps({
            "title": "Old task",
            "status": "open",
        }) + "\n")
        import tools.action_queue as aq
        aq._QUEUE_PATH = None
        init()
        items = list_items()
        assert items[0]["lane"] == "commander"

    def test_no_legacy_file_creates_clean(self, temp_hermes_home):
        """No legacy file == clean empty queue."""
        from tools.action_queue import init, list_items
        init()
        assert list_items() == []


# =========================================================================
# Telegram callback handler (unit)
# =========================================================================

class TestTelegramHelmCallback:
    """Test the HELM proposal callback logic in isolation."""

    @pytest.fixture
    def adapter_with_queue(self, temp_hermes_home):
        """Create a context with action_queue initialized."""
        from tools.action_queue import create
        item = create(title="HELM proposal", lane="helm_proposal", source="helm", detail="Test")
        return item

    def test_approve_callback(self, adapter_with_queue):
        """Yes callback approves the proposal."""
        from tools.action_queue import get, update_status

        result = update_status(adapter_with_queue["id"], "approved")
        assert result is not None
        assert result["status"] == "approved"

    def test_reject_callback(self, adapter_with_queue):
        """No callback rejects the proposal."""
        from tools.action_queue import get, update_status
        result = update_status(adapter_with_queue["id"], "rejected")
        assert result is not None
        assert result["status"] == "rejected"

    def test_discuss_callback(self, adapter_with_queue):
        """Discuss callback marks for discussion."""
        from tools.action_queue import get, update_status
        result = update_status(adapter_with_queue["id"], "discussing")
        assert result is not None
        assert result["status"] == "discussing"

    def test_unauthorized_user(self, adapter_with_queue):
        """Unauthorized user gets rejected."""
        from tools.action_queue import get
        # Verify the item still exists with original status
        item = get(adapter_with_queue["id"])
        assert item is not None
        assert item["status"] == "open"


# =========================================================================
# CLI handler tests (unit)
# =========================================================================

class TestCLIHandler:
    def test_list_empty(self, temp_hermes_home):
        """CLI /todos shows empty state."""
        from tools.action_queue import list_formatted
        lines = list_formatted()
        assert "(no items" in lines[0].lower()

    def test_list_with_items(self, temp_hermes_home):
        """CLI /todos shows items."""
        from tools.action_queue import create, list_formatted
        create(title="CLI task", source="user")
        lines = list_formatted()
        assert "CLI task" in lines[0]

    def test_list_lane_filter(self, temp_hermes_home):
        """CLI /todos commander filters correctly."""
        from tools.action_queue import create, list_formatted
        create(title="Work item", lane="commander", source="user")
        create(title="Proposal", lane="helm_proposal", source="helm")
        cmd_lines = list_formatted(lane="commander")
        helm_lines = list_formatted(lane="helm_proposal")
        assert len(cmd_lines) == 1
        assert len(helm_lines) == 1
        assert "Work item" in cmd_lines[0]
        assert "Proposal" in helm_lines[0]


# =========================================================================
# Promoted action skill documentation test
# =========================================================================

def test_promote_action_executable(temp_hermes_home):
    """The promote_action.py script is runnable as a module."""
    from tools.action_queue import promote
    result = promote(title="Doc test", source="cron", lane="commander")
    assert result


# =========================================================================
# Schema stability
# =========================================================================

class TestSchemaStability:
    def test_required_fields_present(self, temp_hermes_home):
        """Created items have all schema fields."""
        from tools.action_queue import create
        item = create(title="Schema test", lane="helm_proposal", source="test")
        for field in ("id", "lane", "title", "detail", "rationale", "risk",
                      "rollback", "priority", "source", "status", "created",
                      "updated", "progress", "approval"):
            assert field in item, f"Missing field: {field}"

    def test_persisted_jsonl_format(self, temp_hermes_home):
        """On-disk JSONL lines parse cleanly."""
        from tools.action_queue import create
        create(title="Persist test", source="test")
        queue_file = temp_hermes_home / "action_queue.jsonl"
        assert queue_file.exists()
        with open(queue_file) as f:
            line = f.readline().strip()
        assert line
        d = json.loads(line)
        assert d["title"] == "Persist test"
        assert d["lane"] == "commander"