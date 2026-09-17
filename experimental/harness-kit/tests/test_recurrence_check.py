"""
RED->GREEN tests for ar-recurrence-check.py defects:

Defect 1: cmd_scan's member id = "<slug>/<filename_stem>" only — every record
in a multi-record corrections .json file collides on the same id, so the
known_ids dedup silently drops every record after the first.

Defect 2 (documentation half): is_phantom() must never fabricate a phantom
when rule_date is missing/None — this test locks that "safe default" behavior
in place so the visibility fix in ar-scoreboard.py can't regress it back into
fabricating True.
"""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from _loader import load_module

mod = load_module("ar_recurrence_check", "ar-recurrence-check.py")


def make_ar_root(tmp_path: Path) -> Path:
    ar_root = tmp_path / "ar-root"
    (ar_root / "projects").mkdir(parents=True)
    return ar_root


def write_taxonomy(ar_root: Path, classes: list, unclassified: list | None = None) -> None:
    taxonomy = {
        "version": 1,
        "updated": "2026-01-01",
        "classes": classes,
        "unclassified": unclassified or [],
    }
    with open(ar_root / "taxonomy.json", "w", encoding="utf-8") as f:
        json.dump(taxonomy, f)


def write_corrections(ar_root: Path, slug: str, filename_stem: str, payload) -> None:
    corr_dir = ar_root / "projects" / slug / "corrections"
    corr_dir.mkdir(parents=True, exist_ok=True)
    with open(corr_dir / f"{filename_stem}.json", "w", encoding="utf-8") as f:
        json.dump(payload, f)


class MultiRecordFileDropTest(unittest.TestCase):
    """Defect 1: second+ record in a multi-record file must not be dropped."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.ar_root = make_ar_root(Path(self.tmp))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_second_record_in_multi_record_file_is_classified(self):
        # One class whose keyword hits both records unambiguously.
        write_taxonomy(
            self.ar_root,
            classes=[
                {
                    "id": "C1",
                    "name": "test-class",
                    "description": "d",
                    "keywords": ["widget"],
                    "rule_ref": "ref",
                    "rule_date": "2026-01-01",
                    "rule_date_confidence": "exact",
                    "members": [],
                    "related": [],
                    "status": "open",
                    "history": [],
                }
            ],
        )
        write_corrections(
            self.ar_root,
            "proj1",
            "multi",
            [
                {"rule": "widget rule one", "date": "2026-01-02", "tags": []},
                {"rule": "widget rule two", "date": "2026-01-03", "tags": []},
            ],
        )

        mod.cmd_scan(self.ar_root)

        taxonomy = mod.load_json(mod.taxonomy_path(self.ar_root))
        member_ids = [m["id"] for cls in taxonomy["classes"] for m in cls["members"]]

        self.assertIn("proj1/multi", member_ids, "record 0 must keep the backward-compat id")
        self.assertIn(
            "proj1/multi#1",
            member_ids,
            "record 1 of a multi-record file must be classified under a distinct id, "
            "not silently dropped by the known_ids dedup",
        )
        self.assertEqual(
            2,
            len(member_ids),
            f"expected exactly 2 classified members, got {member_ids}",
        )

    def test_single_record_file_keeps_backward_compatible_id(self):
        write_taxonomy(
            self.ar_root,
            classes=[
                {
                    "id": "C1",
                    "name": "test-class",
                    "description": "d",
                    "keywords": ["widget"],
                    "rule_ref": "ref",
                    "rule_date": "2026-01-01",
                    "rule_date_confidence": "exact",
                    "members": [],
                    "related": [],
                    "status": "open",
                    "history": [],
                }
            ],
        )
        # Single dict record (the common, live-data shape).
        write_corrections(
            self.ar_root,
            "proj1",
            "single",
            {"rule": "widget rule", "date": "2026-01-02", "tags": []},
        )

        mod.cmd_scan(self.ar_root)

        taxonomy = mod.load_json(mod.taxonomy_path(self.ar_root))
        member_ids = [m["id"] for cls in taxonomy["classes"] for m in cls["members"]]
        self.assertEqual(["proj1/single"], member_ids)


class IsPhantomNoFabricationTest(unittest.TestCase):
    """Defect 2 (invariant): missing rule_date must never fabricate phantom=True."""

    def test_missing_rule_date_returns_false_not_true(self):
        self.assertFalse(mod.is_phantom("2026-05-01", None))
        self.assertFalse(mod.is_phantom("2026-05-01", ""))

    def test_missing_correction_date_returns_false(self):
        self.assertFalse(mod.is_phantom(None, "2026-01-01"))

    def test_genuine_phantom_still_detected(self):
        self.assertTrue(mod.is_phantom("2026-05-02", "2026-01-01"))

    def test_same_day_is_genesis_not_phantom(self):
        self.assertFalse(mod.is_phantom("2026-01-01", "2026-01-01"))


if __name__ == "__main__":
    unittest.main()
