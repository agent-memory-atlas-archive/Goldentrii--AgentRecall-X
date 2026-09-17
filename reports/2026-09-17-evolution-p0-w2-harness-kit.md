# Evolution P0 — Worker w2-harness-kit report

**Brief:** p0-w2-harness-kit.md · **Repo:** /Users/tongwu/Projects/AgentRecall · **Branch:** evolution-p0-p4
**Scope:** `experimental/harness-kit/` only. No commit/push performed (orchestrator commits). `~/.agent-recall` never written — verified untouched (see Verification section).

## Summary

Fixed two silent-flattering-direction defects in the harness-kit recurrence instrument:

1. **`ar-recurrence-check.py` / `cmd_scan`** — member id collapsed to `<slug>/<filename_stem>` regardless of record position, so the 2nd+ record in any multi-record corrections `.json` file was silently dropped by the `known_ids` dedup. Fixed with stable per-record ids: record 0 keeps `<slug>/<stem>` (backward compat), record `idx>=1` gets `<slug>/<stem>#<idx>`, where `idx` is the record's position in the file's **raw** list (stable even if an earlier record in the same file is later retracted).

2. **`ar-scoreboard.py` / `format_digest`** — `is_phantom()` correctly returns `False` (not a fabricated `True`) when a class has no `rule_date`, but that safe default was invisible: such classes read identically to "checked, 0 phantoms found." Fixed by adding a distinct `N unmeasurable (no rule_date)` count to the `reflect` digest line, computed independently from `cls.get("rule_date")` — additive only, all existing digest text preserved verbatim.

Both fixes are minimal and localized; `is_phantom()` itself was **not** changed (its `False` return for missing dates was already correct — the defect was invisibility downstream, not fabrication). Added a clarifying docstring there pointing at where the blind spot is surfaced.

## Challenge check (per brief's CHALLENGE clause)

Brief's own escape hatch: *"e.g. multi-record files are NOT actually possible, or the digest is parsed in a way that additive change breaks."* Checked both, neither holds:

- **Multi-record files ARE a supported, documented feature.** `load_all_corrections()` explicitly normalizes `dict` → `[dict]` and passes through `list[dict]` unchanged; `TAXONOMY-SCHEMA.md` line 85 (pre-fix) already stated "A file may contain a single record or a list of records." Live corpus currently has 0 such files (checked `~/.agent-recall/projects/*/corrections/*.json`, read-only), so the defect was latent, not yet triggered live — but the capability and the drop-on-trigger were both real. No challenge warranted; executed as specified.
- **Digest is not parsed elsewhere.** `format_digest`'s stdout is injected raw into session context by the SessionStart hook (per `ar-scoreboard.py` module docstring and `README.md` wiring); `ar-nudge.py` reads `reflection-state.json` directly, not the digest text. No regex/parser elsewhere depends on the `reflect` line's exact token count. Additive change confirmed safe.

No escalation triggered: the member-id fix is backward-compatible by construction (record-0 id format is unchanged) and a live-copy `--scan` run (see Verification) found zero existing ids lost or altered.

## Fix 1 — RED before, fix, GREEN after

**RED (pre-fix):**
```
test_second_record_in_multi_record_file_is_classified ... FAIL
AssertionError: 'proj1/multi#1' not found in ['proj1/multi'] : record 1 of a
multi-record file must be classified under a distinct id, not silently
dropped by the known_ids dedup
```

**Fix (`experimental/harness-kit/scripts/ar-recurrence-check.py`):**
- `correction_member_id(slug, filename_stem, idx=0)` — `idx==0` → `"<slug>/<stem>"` (unchanged); `idx>=1` → `"<slug>/<stem>#<idx>"`.
- `load_all_corrections()` now yields `(slug, filename_stem, idx, record)` — `idx` = position in the file's raw record list (`enumerate(records)`), computed **before** the empty-rule/`retracted_at` filters, so a record's id never shifts if an earlier record in the same file is later filtered out.
- `cmd_scan()` updated to pass `idx` through to `correction_member_id`.

**GREEN (post-fix):**
```
test_second_record_in_multi_record_file_is_classified ... ok
test_single_record_file_keeps_backward_compatible_id ... ok
```

## Fix 2 — RED before, fix, GREEN after

**RED (pre-fix, 4 failures):**
```
test_class_with_none_rule_date_counted_as_unmeasurable ... FAIL
AssertionError: 'unmeasurable' not found in '...reflect  2 classes · 0 phantom ·
0 provisional · 0 unclassified · due in 10 sessions...'

test_class_with_missing_rule_date_key_also_counted ... FAIL
test_no_unmeasurable_classes_reports_zero ... FAIL
test_live_taxonomy_copy_loads_and_digests_without_raising ... FAIL
  AssertionError: '2 unmeasurable (no rule_date)' not found in
  '...reflect  14 classes · 22 phantom · 0 provisional · 1 unclassified ·
  due in 10 sessions...'
```
(That last failure is against a **copy** of the real live `taxonomy.json` — confirms C13/C14 in the live corpus already have no `rule_date`, i.e. the blind spot is real, not hypothetical.)

**Fix (`experimental/harness-kit/scripts/ar-scoreboard.py`, `format_digest`):**
```python
n_unmeasurable = sum(
    1 for cls in classes
    if not (cls.get("rule_date") or "").strip()
)
lines.append(
    f" reflect  {n_classes} classes · {n_phantom} phantom · "
    f"{n_provisional} provisional · {n_unclassified} unclassified · "
    f"{n_unmeasurable} unmeasurable (no rule_date) · {due_str}"
)
```

**GREEN (post-fix):** all 4 tests pass (see full run below).

## Digest before/after sample (live taxonomy copy, real CLI invocation)

```
=== BEFORE (git HEAD ar-scoreboard.py), live taxonomy copy ===
── Pareto Scoreboard ──────────────────────────────
 signal   0 corrections/7d · 0/30d
 promote  n/a (insights unavailable)
 loops    dreams n/a · sync-errors 0/7d · recall n/a/30d
 reflect  14 classes · 22 phantom · 0 provisional · 1 unclassified · due in 9 sessions
 → /arstart board · /arsave · /arrecall · /arreflect

=== AFTER (fixed), same live taxonomy copy ===
── Pareto Scoreboard ──────────────────────────────
 signal   0 corrections/7d · 0/30d
 promote  n/a (insights unavailable)
 loops    dreams n/a · sync-errors 0/7d · recall n/a/30d
 reflect  14 classes · 22 phantom · 0 provisional · 1 unclassified · 2 unmeasurable (no rule_date) · due in 9 sessions
 → /arstart board · /arsave · /arrecall · /arreflect
```
All pre-existing fields (`14 classes`, `22 phantom`, `0 provisional`, `1 unclassified`, `due in 9 sessions`) unchanged verbatim — additive-only confirmed. The 2 unmeasurable classes are `C13` (`authoritative-fact-fidelity`) and `C14` (`recipient-actionability`), confirmed by direct inspection of the live file (read-only).

## Backward-compatibility verification (live-shaped data, never live file)

Ran the **actual** `--scan` CLI (not just unit tests) against a tmp copy of `~/.agent-recall/projects` + `taxonomy.json`, with `AR_ROOT` overridden — the live directory itself was never opened for write:

```
$ AR_ROOT=$TMP python3 experimental/harness-kit/scripts/ar-recurrence-check.py --scan
...
Total phantom count (all classes): 22

before member count: 66
after member count: 68
ids only in before (lost/changed): set()
ids only in after (new): {'novada-mcp/2026-07-05-let-me-answer-you-1by1',
                           'novada-mcp/2026-05-20-code-issue-wrong-query-param-keyword-ins'}
before classes: 14 after classes: 14
live file md5 after test run: 7c603232413b636a6b4146672870defa (== baseline)
```
Zero existing ids lost/changed (`set()`); the 2 new ids are genuinely-unscanned single-record corrections already in the live corrections store (unrelated to the multi-record fix — confirms no spurious drift from the id-scheme change). Live `taxonomy.json` md5 identical before/after → confirmed never touched.

## Full test suite (GREEN)

```
$ python3 -m unittest discover experimental/harness-kit/tests -v
test_genuine_phantom_still_detected ... ok
test_missing_correction_date_returns_false ... ok
test_missing_rule_date_returns_false_not_true ... ok
test_same_day_is_genesis_not_phantom ... ok
test_second_record_in_multi_record_file_is_classified ... ok
test_single_record_file_keeps_backward_compatible_id ... ok
test_live_taxonomy_copy_loads_and_digests_without_raising ... ok
test_class_with_missing_rule_date_key_also_counted ... ok
test_class_with_none_rule_date_counted_as_unmeasurable ... ok
test_existing_fields_unchanged_format ... ok
test_no_unmeasurable_classes_reports_zero ... ok

Ran 11 tests in 0.005s
OK
```

## Files changed

- `experimental/harness-kit/scripts/ar-recurrence-check.py` — `correction_member_id`, `load_all_corrections`, `cmd_scan` (Fix 1); docstring-only clarification on `is_phantom` (Fix 2 traceability, no behavior change).
- `experimental/harness-kit/scripts/ar-scoreboard.py` — `format_digest` (Fix 2).
- `experimental/harness-kit/TAXONOMY-SCHEMA.md` — updated `members[].id` row, `rule_date` row, and scan-semantics step 1 to document the new id scheme and the unmeasurable count (consistency: same claims existed in this doc, now kept in sync per Consistency rule).
- `experimental/harness-kit/tests/_loader.py`, `test_recurrence_check.py`, `test_scoreboard_digest.py` — new, per constraint 5 (kit had no test runner). Runnable via:
  ```
  python3 -m unittest discover experimental/harness-kit/tests
  ```

## SUCCESS_WHEN checklist

- [x] Both red tests demonstrably failed pre-fix (shown above) and pass post-fix.
- [x] Multi-record fixture's 2nd record now classified with id `stem#1` (`proj1/multi#1`, test `test_second_record_in_multi_record_file_is_classified`).
- [x] A `rule_date=None` class shows up in the digest as unmeasurable (`test_class_with_none_rule_date_counted_as_unmeasurable`; live-copy sample above shows `2 unmeasurable (no rule_date)` for real C13/C14).
- [x] Live taxonomy loads unchanged — verified both via a fixture replicating its shape (`LiveTaxonomyShapeCompatibilityTest`, using a copy) and a real `--scan` CLI run against a full copy of the live store (zero ids lost/changed, live file md5 unchanged).

## Escalation / Challenge status

Neither triggered. Challenge clause investigated and found not applicable (see "Challenge check" above); escalation clause (retroactive id collision) investigated and found not applicable (see "Backward-compatibility verification" above — `set()` lost/changed ids).

---
SOP_ID: 52b1a846
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth challenge_fired=false kept=all replaced=none
