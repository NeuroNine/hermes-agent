"""
Focused tests for the research action-items promotion bridge (Phase 2).

Tests cover: parsing, malformed input, idempotence, lane mapping,
explicit proposal gating, dry-run mode, and CLI interface.
Uses a temp HERMES_HOME so no live state is touched.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

# Ensure the repo root is importable
_REPO = str(Path(__file__).resolve().parents[2])
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

# Import promote_research from ~/.hermes/scripts/ via importlib
import importlib.util
_BRIDGE_PATH = Path.home() / ".hermes" / "scripts" / "promote_research.py"
if _BRIDGE_PATH.exists():
    _spec = importlib.util.spec_from_file_location("promote_research", str(_BRIDGE_PATH))
    promote_research = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(promote_research)
else:
    promote_research = None  # Tests will skip gracefully

# =========================================================================
# Fixtures
# =========================================================================


@pytest.fixture
def temp_hermes_home():
    """Set up a temporary HERMES_HOME and restore after the test."""
    old_home = os.environ.pop("HERMES_HOME", None)
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["HERMES_HOME"] = tmp
        import tools.action_queue as aq
        aq._QUEUE_PATH = None
        aq.init()
        yield Path(tmp)
    if old_home is not None:
        os.environ["HERMES_HOME"] = old_home
    else:
        os.environ.pop("HERMES_HOME", None)
    import tools.action_queue as aq
    aq._QUEUE_PATH = None


@pytest.fixture
def action_items_file(temp_hermes_home):
    """Create a sample action-items.jsonl with various record types."""
    path = temp_hermes_home / "research" / "action-items.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    records = [
        # Open commander items (default lane)
        {"entity": "check-disk-space", "action": "Check disk space on storage",
         "why": "Monthly maintenance", "status": "open"},
        # Open HELM proposal (explicit lane)
        {"entity": "add-watcher", "action": "Add storage watcher script",
         "why": "Automate disk checks", "status": "open",
         "lane": "helm_proposal"},
        # Open HELM proposal via kind field
        {"entity": "update-config", "action": "Update default config values",
         "why": "Better defaults", "status": "open",
         "kind": "helm_proposal"},
        # Non-open item (should be skipped)
        {"entity": "completed-task", "action": "Do something",
         "why": "Was needed", "status": "completed"},
        # Already resolved / expired
        {"entity": "expired-item", "action": "Old task",
         "why": "Was needed", "status": "expired"},
        # Malformed line
    ]
    lines = "\n".join(json.dumps(r) for r in records)
    # Add a malformed line
    lines += '\n{not valid json\n'
    # Add an empty line
    lines += '\n\n'
    # Add a comment-style line
    lines += '\n# this is a comment\n'
    path.write_text(lines)
    return path


# =========================================================================
# Parsing
# =========================================================================


class TestParseActionItem:
    def test_valid_json(self, temp_hermes_home):
        """Valid JSON object is parsed correctly."""
        parse_action_item = promote_research.parse_action_item
        result = parse_action_item('{"entity": "test", "action": "Do it", "status": "open"}', 1)
        assert result is not None
        assert result["entity"] == "test"
        assert result["action"] == "Do it"

    def test_malformed_json(self, temp_hermes_home):
        """Malformed JSON returns None."""
        parse_action_item = promote_research.parse_action_item
        result = parse_action_item("{not valid", 1)
        assert result is None

    def test_not_dict(self, temp_hermes_home):
        """Non-dict JSON returns None."""
        parse_action_item = promote_research.parse_action_item
        result = parse_action_item('["array", "not", "dict"]', 1)
        assert result is None

    def test_empty_line(self, temp_hermes_home):
        """Empty or whitespace-only lines return None."""
        parse_action_item = promote_research.parse_action_item
        assert parse_action_item("", 1) is None
        assert parse_action_item("   ", 1) is None

    def test_comment_line(self, temp_hermes_home):
        """Comment lines (starting with #) return None."""
        parse_action_item = promote_research.parse_action_item
        assert parse_action_item("# this is a comment", 1) is None


# =========================================================================
# Lane mapping
# =========================================================================


class TestDetermineLane:
    def test_default_commander(self):
        """No lane/kind field defaults to commander."""
        determine_lane = promote_research.determine_lane
        assert determine_lane({"entity": "x", "action": "y"}) == "commander"

    def test_explicit_commander(self):
        """Explicit lane=commander is preserved."""
        determine_lane = promote_research.determine_lane
        assert determine_lane({"entity": "x", "action": "y", "lane": "commander"}) == "commander"

    def test_helm_proposal_lane(self):
        """lane=helm_proposal routes to helm proposal."""
        determine_lane = promote_research.determine_lane
        assert determine_lane({"entity": "x", "action": "y", "lane": "helm_proposal"}) == "helm_proposal"

    def test_helm_proposal_kind(self):
        """kind=helm_proposal routes to helm proposal."""
        determine_lane = promote_research.determine_lane
        assert determine_lane({"entity": "x", "action": "y", "kind": "helm_proposal"}) == "helm_proposal"

    def test_invalid_lane_falls_back_to_commander(self):
        """Invalid lane value falls back to commander."""
        determine_lane = promote_research.determine_lane
        assert determine_lane({"entity": "x", "action": "y", "lane": "invalid"}) == "commander"

    def test_lane_overrides_kind(self):
        """Explicit lane field takes precedence over kind."""
        determine_lane = promote_research.determine_lane
        result = determine_lane({"entity": "x", "action": "y", "lane": "commander", "kind": "helm_proposal"})
        assert result == "commander"


# =========================================================================
# Open status detection
# =========================================================================


class TestIsOpen:
    def test_open_status(self):
        """status=open returns True."""
        is_open = promote_research.is_open
        assert is_open({"status": "open"}) is True

    def test_non_open_status(self):
        """Non-open statuses return False."""
        is_open = promote_research.is_open
        assert is_open({"status": "completed"}) is False
        assert is_open({"status": "expired"}) is False
        assert is_open({"status": "duplicate-resolved"}) is False

    def test_missing_status_defaults_to_open(self):
        """Missing status defaults to open (treat as actionable)."""
        is_open = promote_research.is_open
        # Our implementation defaults missing status to "open"
        assert is_open({}) is True

    def test_empty_status(self):
        """Empty string status returns False."""
        is_open = promote_research.is_open
        assert is_open({"status": ""}) is False


# =========================================================================
# Full promotion pipeline
# =========================================================================


class TestPromoteAll:
    def test_promote_open_items(self, action_items_file):
        """Open items in commander lane are promoted."""
        import tools.action_queue as aq
        # Promote using the bridge
        promote_all = promote_research.promote_all
        result = promote_all(input_path=str(action_items_file))

        assert result["promoted"] == 3  # check-disk + add-watcher + update-config
        assert result["existing"] == 0
        assert result["errors"] == 0

        # Verify items actually landed in queue
        cmd_items = aq.list_items(lane="commander")
        helm_items = aq.list_items(lane="helm_proposal")

        # check-disk-space → commander (default)
        # add-watcher → helm_proposal (explicit lane)
        # update-config → helm_proposal (kind field)
        assert len(cmd_items) == 1
        assert cmd_items[0]["title"] == "Check disk space on storage"
        assert len(helm_items) == 2
        helm_titles = {i["title"] for i in helm_items}
        assert "Add storage watcher script" in helm_titles
        assert "Update default config values" in helm_titles

    def test_idempotence(self, action_items_file):
        """Second promote of same items is idempotent (returns exists)."""
        promote_all = promote_research.promote_all
        _check_exists = promote_research._check_exists

        # First run
        result1 = promote_all(input_path=str(action_items_file))
        assert result1["promoted"] == 3
        assert result1["existing"] == 0

        # Second run — same records, should all be existing
        result2 = promote_all(input_path=str(action_items_file))
        assert result2["promoted"] == 0
        assert result2["existing"] == 3

    def test_dry_run_no_writes(self, action_items_file):
        """Dry-run does not create any queue entries."""
        promote_all = promote_research.promote_all
        import tools.action_queue as aq

        result = promote_all(input_path=str(action_items_file), dry_run=True)

        # All 3 open items should appear as dry-run IDs
        dry_ids = [i["id"] for i in result["items"] if "dry-run" in i["id"]]
        assert len(dry_ids) == 3

        # Queue should still be empty
        assert aq.list_items() == []

    def test_skip_non_open(self, action_items_file):
        """Non-open items are skipped."""
        promote_all = promote_research.promote_all

        result = promote_all(input_path=str(action_items_file))
        # 3 promoted, 2 skipped (completed + expired), 1 malformed, 1 empty, 1 comment
        # Records: check-disk (open) → promoted
        #          add-watcher (open) → promoted
        #          update-config (open) → promoted
        #          completed-task (completed) → skipped
        #          expired-item (expired) → skipped
        #          {not valid json → malformed → skipped
        #          (empty) → skipped
        #          # comment → skipped
        # 3 promoted + 2 non-open skipped + 1 malformed skipped + 1 empty skipped + 1 comment skipped
        assert result["promoted"] == 3
        assert result["errors"] == 0

    def test_missing_input_file(self, temp_hermes_home):
        """Missing input file returns empty result with message."""
        promote_all = promote_research.promote_all
        result = promote_all(input_path="/nonexistent/path.jsonl")
        assert result["promoted"] == 0
        assert "not found" in result.get("message", "").lower()


# =========================================================================
# Lane mapping integration
# =========================================================================


class TestLaneMappingIntegration:
    def test_commander_items_in_correct_lane(self, action_items_file):
        """Commander items end up in commander lane."""
        promote_all = promote_research.promote_all
        import tools.action_queue as aq

        promote_all(input_path=str(action_items_file))

        cmd_items = aq.list_items(lane="commander")
        # check-disk-space is commander (default)
        # update-config has kind=helm_proposal but no lane field → helm_proposal via determine_lane
        # So commander should have: check-disk-space
        assert len(cmd_items) == 1
        assert any("disk" in i["title"].lower() for i in cmd_items)

    def test_helm_proposal_items_in_correct_lane(self, action_items_file):
        """HELM proposal items end up in helm_proposal lane."""
        promote_all = promote_research.promote_all
        import tools.action_queue as aq

        promote_all(input_path=str(action_items_file))

        helm_items = aq.list_items(lane="helm_proposal")
        # add-watcher (explicit lane=helm_proposal) + update-config (kind=helm_proposal)
        assert len(helm_items) == 2
        titles = {i["title"] for i in helm_items}
        assert "Add storage watcher script" in titles
        assert "Update default config values" in titles

    def test_helm_proposal_not_in_commander(self, action_items_file):
        """HELM proposal items never leak into commander lane."""
        promote_all = promote_research.promote_all
        import tools.action_queue as aq

        promote_all(input_path=str(action_items_file))

        cmd_items = aq.list_items(lane="commander")
        for item in cmd_items:
            assert item["lane"] == "commander"
            assert "helm" not in item.get("title", "").lower()


# =========================================================================
# Report formatting
# =========================================================================


class TestReportFormatting:
    def test_json_output(self, action_items_file):
        """JSON output is parseable and contains expected keys."""
        promote_all = promote_research.promote_all
        print_report = promote_research.print_report
        result = promote_all(input_path=str(action_items_file))
        report = print_report(result, json_output=True)
        parsed = json.loads(report)
        assert "promoted" in parsed
        assert "existing" in parsed
        assert "items" in parsed
        assert parsed["promoted"] == 3

    def test_text_output(self, action_items_file):
        """Text output contains summary line."""
        promote_all = promote_research.promote_all
        print_report = promote_research.print_report
        result = promote_all(input_path=str(action_items_file))
        report = print_report(result, json_output=False)
        assert "Promoted:" in report
        assert "Existing:" in report
        assert "created" in report.lower()

    def test_empty_result(self, temp_hermes_home):
        """Empty result produces valid output."""
        promote_all = promote_research.promote_all
        print_report = promote_research.print_report
        result = promote_all(input_path="/nonexistent")
        report = print_report(result)
        assert "Promoted:" in report


# =========================================================================
# CLI interface
# =========================================================================


class TestCLI:
    def test_main_help(self):
        """--help prints usage and returns 0."""
        main = promote_research.main
        code = main(["--help"])
        assert code == 0

    def test_main_dry_run(self, action_items_file):
        """--dry-run flag is accepted."""
        main = promote_research.main
        code = main(["--dry-run", "--input", str(action_items_file)])
        assert code == 0

    def test_main_json(self, action_items_file):
        """--json flag produces JSON output."""
        main = promote_research.main
        import io
        old_stdout = sys.stdout
        sys.stdout = io.StringIO()
        try:
            code = main(["--json", "--input", str(action_items_file)])
            output = sys.stdout.getvalue()
            assert code == 0
            parsed = json.loads(output)
            assert "promoted" in parsed
        finally:
            sys.stdout = old_stdout

    def test_main_default_path(self, temp_hermes_home):
        """Main with no args uses default path."""
        main = promote_research.main
        code = main([])
        assert code == 0


# =========================================================================
# Edge cases
# =========================================================================


class TestEdgeCases:
    def test_empty_file(self, temp_hermes_home):
        """Empty action-items file produces empty results."""
        path = temp_hermes_home / "research" / "action-items.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
        promote_all = promote_research.promote_all
        result = promote_all(input_path=str(path))
        assert result["promoted"] == 0
        assert result["skipped"] == 0  # no lines

    def test_only_completed_items(self, temp_hermes_home):
        """Only non-open items produces 0 promotions."""
        path = temp_hermes_home / "research" / "action-items.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "entity": "done-deal", "action": "Was done",
            "status": "completed",
        }))
        promote_all = promote_research.promote_all
        result = promote_all(input_path=str(path))
        assert result["promoted"] == 0
        assert result["skipped"] >= 1  # the line is parsed but skipped due to status

    def test_missing_entity_or_action(self, temp_hermes_home):
        """Missing entity or action produces skipped items."""
        path = temp_hermes_home / "research" / "action-items.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "status": "open"
        }))
        promote_all = promote_research.promote_all
        result = promote_all(input_path=str(path))
        # entity is missing → prompted as skipped
        assert result["promoted"] == 0

    def test_all_malformed(self, temp_hermes_home):
        """All malformed lines produces errors."""
        path = temp_hermes_home / "research" / "action-items.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{bad\n{also bad\n")
        promote_all = promote_research.promote_all
        result = promote_all(input_path=str(path))
        assert result["promoted"] == 0
        # Both lines are malformed, parsed as None → skipped
        # They are not "errors" because parse_action_item returns None gracefully
        assert result["errors"] == 0
        assert result["skipped"] == 2