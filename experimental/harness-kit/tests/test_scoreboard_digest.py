"""
RED->GREEN tests for ar-scoreboard.py's format_digest():

Defect 2: is_phantom() safely returns False for a class with rule_date=None,
but that "safe default" is invisible downstream — such a class can NEVER
alarm and nothing in the digest says so. Fix: format_digest must surface a
distinct "unmeasurable (no rule_date)" count.

Also covers the backward-compat constraint: the live taxonomy.json shape
(copied into a tmp fixture, never the live file itself) must still load and
digest without raising, and the additive change must not alter any existing
digest field.
"""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from _loader import load_module

mod = load_module("ar_scoreboard", "ar-scoreboard.py")

LIVE_TAXONOMY = Path("~/.agent-recall/taxonomy.json").expanduser()


def base_snapshot() -> dict:
    return {
        "ts": "2026-01-01T00:00:00",
        "global": {
            "corrections_7d": 0,
            "corrections_30d": 0,
            "insights_total": None,
            "insights_confirmed_2plus": None,
            "promotion_rate_pct": None,
            "recall_events_30d": None,
            "dreams_last_success": None,
            "dreams_stale_days": None,
            "sync_errors_7d": 0,
            "ghost_project_dirs": 0,
            "sessions_since_reflection": 0,
        },
        "projects": [],
    }


class UnmeasurableClassVisibilityTest(unittest.TestCase):
    """Defect 2: a rule_date=None class must show up as 'unmeasurable' in the digest."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.ar_root = Path(self.tmp)
        # Point the module's globals at our tmp fixture dir.
        self._orig_ar_root = mod.AR_ROOT
        self._orig_scoreboard = mod.SCOREBOARD
        self._orig_reflect_state = mod.REFLECT_STATE
        mod.AR_ROOT = self.ar_root
        mod.SCOREBOARD = self.ar_root / "scoreboard.json"
        mod.REFLECT_STATE = self.ar_root / "reflection-state.json"

    def tearDown(self):
        mod.AR_ROOT = self._orig_ar_root
        mod.SCOREBOARD = self._orig_scoreboard
        mod.REFLECT_STATE = self._orig_reflect_state
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_taxonomy(self, classes):
        with open(self.ar_root / "taxonomy.json", "w", encoding="utf-8") as f:
            json.dump({"version": 1, "updated": "2026-01-01", "classes": classes, "unclassified": []}, f)

    def test_class_with_none_rule_date_counted_as_unmeasurable(self):
        self._write_taxonomy(
            [
                {
                    "id": "C1",
                    "name": "measurable",
                    "rule_date": "2026-01-01",
                    "members": [],
                },
                {
                    "id": "C2",
                    "name": "no-anchor",
                    "rule_date": None,
                    "members": [],
                },
            ]
        )
        digest = mod.format_digest(base_snapshot())
        self.assertIn(
            "unmeasurable",
            digest,
            f"digest must surface the no-rule_date blind spot; got:\n{digest}",
        )
        self.assertIn(
            "1 unmeasurable (no rule_date)",
            digest,
            f"expected exactly 1 unmeasurable class; got:\n{digest}",
        )

    def test_class_with_missing_rule_date_key_also_counted(self):
        self._write_taxonomy(
            [
                {"id": "C1", "name": "no-key-at-all", "members": []},
            ]
        )
        digest = mod.format_digest(base_snapshot())
        self.assertIn("1 unmeasurable (no rule_date)", digest)

    def test_no_unmeasurable_classes_reports_zero(self):
        self._write_taxonomy(
            [
                {"id": "C1", "name": "measurable", "rule_date": "2026-01-01", "members": []},
            ]
        )
        digest = mod.format_digest(base_snapshot())
        self.assertIn("0 unmeasurable (no rule_date)", digest)

    def test_existing_fields_unchanged_format(self):
        """Additive-only constraint: existing 'N classes'/'N phantom'/etc still present verbatim."""
        self._write_taxonomy(
            [
                {"id": "C1", "name": "measurable", "rule_date": "2026-01-01", "members": []},
            ]
        )
        digest = mod.format_digest(base_snapshot())
        self.assertIn("1 classes", digest)
        self.assertIn("0 phantom", digest)
        self.assertIn("0 provisional", digest)
        self.assertIn("0 unclassified", digest)


class LiveTaxonomyShapeCompatibilityTest(unittest.TestCase):
    """Constraint: existing taxonomy.json files must LOAD unchanged.

    Uses a COPY of the live file (never touches ~/.agent-recall directly).
    Skips if no live file is present (e.g. CI without a seeded store).
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.ar_root = Path(self.tmp)
        self._orig_ar_root = mod.AR_ROOT
        self._orig_scoreboard = mod.SCOREBOARD
        self._orig_reflect_state = mod.REFLECT_STATE
        mod.AR_ROOT = self.ar_root
        mod.SCOREBOARD = self.ar_root / "scoreboard.json"
        mod.REFLECT_STATE = self.ar_root / "reflection-state.json"

    def tearDown(self):
        mod.AR_ROOT = self._orig_ar_root
        mod.SCOREBOARD = self._orig_scoreboard
        mod.REFLECT_STATE = self._orig_reflect_state
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_live_taxonomy_copy_loads_and_digests_without_raising(self):
        if not LIVE_TAXONOMY.exists():
            self.skipTest("no live ~/.agent-recall/taxonomy.json present")

        shutil.copy(LIVE_TAXONOMY, self.ar_root / "taxonomy.json")

        with open(LIVE_TAXONOMY, encoding="utf-8") as f:
            live_data = json.load(f)
        expected_classes = len(live_data.get("classes", []))
        expected_members = sum(len(c.get("members", [])) for c in live_data.get("classes", []))
        expected_unmeasurable = sum(
            1 for c in live_data.get("classes", []) if not (c.get("rule_date") or "").strip()
        )

        digest = mod.format_digest(base_snapshot())

        self.assertIn(f"{expected_classes} classes", digest)
        self.assertIn(
            f"{expected_unmeasurable} unmeasurable (no rule_date)",
            digest,
            f"live fixture has {expected_classes} classes / {expected_members} members; "
            f"digest:\n{digest}",
        )


if __name__ == "__main__":
    unittest.main()
