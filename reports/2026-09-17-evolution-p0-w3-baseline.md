# Evolution P0 W3 — Baseline Snapshot Instrument

Worker: w3-baseline. Branch: `evolution-p0-p4`. Scope: `scripts/eval/` only (new files + fixtures).

New files:
- `scripts/eval/evolution-baseline.mjs` — the instrument (read-only, deterministic).
- `scripts/eval/evolution-baseline.test.mjs` — `node --test` fixture regression suite (8 tests, all pass).
- `scripts/eval/fixtures/evolution-baseline-store/` — hand-built fixture store (4 fake projects) with known counts.
- `scripts/eval/baselines/evolution-baseline-2026-09-17.json` — the dated live baseline artifact.

No existing bench script was modified. (`git status` shows unrelated modifications to `scripts/eval/bench-artifact.mjs`, `scripts/eval/run-bench.mjs`, `experimental/harness-kit/*` and a pile of untracked `reports/*.md` — these are other evolution workers' concurrent output on the same shared branch, not touched by this worker; confirmed by `git diff --stat` and the fact I never opened those files with an edit tool.)

## Metric definitions as implemented

Store layout read: `<store>/projects/<slug>/corrections/*.json` (correction records, `_`-prefixed files excluded) + `<store>/projects/<slug>/corrections/_outcomes.jsonl` (append-only outcome-event ledger). Default store `~/.agent-recall`, override `--store <path>`. Anchor date `--as-of <YYYY-MM-DD>` (default: today).

**Window definitions** (both documented in the artifact's `schema_notes`):
- *Last 4 full ISO weeks* = the 4 consecutive Mon–Sun ISO weeks strictly before the ISO week containing `--as-of`. The as-of week itself is **always** excluded, whatever weekday as-of falls on. For `--as-of 2026-09-17` (Thu, ISO week 2026-W38) that's **2026-W34 .. 2026-W37** (2026-08-17 .. 2026-09-13).
- *Last 28 days* = the UTC calendar-date window `[as_of − 27, as_of]` inclusive (28 distinct days), compared against the UTC calendar date of each event's `at` timestamp.

**(a) corrections captured per week, by provenance** — for every correction JSON record whose `date` field falls inside the 4-week window, bucket by ISO week, sub-bucket by `provenance.mode` (`"none"` when the `provenance` field is absent entirely, `"unspecified"` when present but malformed). Live store: only 8/108 correction records carry `provenance` at all (all `mode:"told"`).

**(b) outcome events per week, by kind** — every event in every project's `_outcomes.jsonl`, same 4-week window, tallied by `kind`.

**(c) verdict coverage** — implemented per the brief's **literal** wording: share of `(project, correction_id)` pairs with ≥1 `"retrieved"` event (read from the ledger directly, all-time, not window-limited) whose **latest** verdict-kind event at/after the first retrieval is **not** `"unknown"`. `VERDICT_KINDS = {heeded, recurred, not_violated, unknown, not_triggered}`.

**(d) distinct corrections retrieved in the last 28 days** — distinct `(project, correction_id)` pairs with ≥1 `"retrieved"` event whose day falls in the 28-day window.

**(e) association edges = 0** — explicit constant; the ledger doesn't exist yet. Not computed, recorded as a documented floor.

## CHALLENGE — resolved, not silently picked

**Outcome-kind universe is bigger than the brief's list.** The brief's metric (b) names 7 kinds (retrieved/triggered/heeded/recurred/not_violated/unknown/not_triggered). `packages/core/src/storage/corrections.ts:224-225` defines **9**: it also includes `predicted` and `predict_hit` (Wave-5 prediction bookkeeping). Verified against the live ledger before writing any code:

```
$ python3 -c "... Counter kinds across all _outcomes.jsonl ..."
kind counts: Counter({'retrieved': 718, 'not_triggered': 317, 'predicted': 282, 'unknown': 181,
                       'heeded': 73, 'recurred': 11, 'predict_hit': 4, 'not_violated': 2})
total lines: 1588  bad: 0
```

`predicted` alone is 282/1588 = 18% of all outcome lines. Dropping it (by following the brief's list literally) would have silently discarded a large, real slice of event volume from metric (b). **Decision**: tally all 9 canonical kinds plus a catch-all `"other"` bucket (exercised in the fixture via an injected `bogus_future_kind` event — proves the safety net actually fires, not just exists in code).

**Verdict-coverage semantics diverge from the codebase's existing canonical formula — and it matters a lot on real data.** `computeCorrectionKPIs()` (`corrections.ts:2618-2646`) and `buildVerdictLedger()` (`scripts/eval/rmr-report.mjs:294-380`, cross-tested against each other) already define:

```
verdict_coverage = |{injected id : kinds ∋ heeded|recurred|not_triggered}| / |{injected id}|
```

— PRESENCE-based (any qualifying event, ever), denominator gated on the correction record's `retrieved_count` FIELD, and deliberately **excludes** `not_violated` from the numerator (explicit design comment: "must NEVER be read by the north-star heed_rate/precision/verdict_coverage").

The brief's own wording is **order-based** ("LATEST post-retrieval verdict") and, read literally, would count `not_violated` as "not unknown" (i.e. covered) — the opposite of the canonical formula's explicit exclusion. The two formulas provably disagree whenever a correction's verdict flip-flops over time (an earlier `heeded`/`recurred` followed by a later `unknown`).

I implemented the brief's literal spec as the **primary** number and report the canonical presence-based figure alongside (same event-based denominator population, for a fair comparison — documented as still differing from the *true* production number, which gates on the `retrieved_count` field rather than a ledger event). **On the live store this is not a rounding difference — it changes the answer by ~2.8x:**

```
(c) verdict coverage (literal brief spec, all-time):
  10 / 34 = 0.2941
  canonical-production comparison (presence-based): 28 / 34 = 0.8235
```

Since Phase 1's exit condition is framed as "verdict coverage ≥50%", **which of these two numbers is "verdict coverage" is a load-bearing decision for the rest of the roadmap**, not a cosmetic interpretation footnote. I flag this explicitly for the orchestrator/owner rather than picking silently — both numbers are in the artifact under `metrics.verdict_coverage.coverage` (literal) and `metrics.verdict_coverage.canonical_production_comparison.coverage` (canonical), fully documented in `schema_notes.verdict_coverage_interpretation` and the script's docblock.

## Fixture test evidence

Fixture store: `scripts/eval/fixtures/evolution-baseline-store/` — 4 project dirs designed to exercise every resilience path (corrupt JSON file, corrupt `_outcomes.jsonl` lines, missing `_outcomes.jsonl`, project dir with no `corrections/` at all, a mega-slug-style junk project name treated uniformly, an unrecognized outcome kind, and a deliberate literal-vs-canonical verdict divergence case).

```
$ node --test scripts/eval/evolution-baseline.test.mjs
✔ isoWeekLabel: 2026-09-17 (Thursday) falls in ISO week 2026-W38 (0.32ms)
✔ computeLast4FullIsoWeeks: excludes the as-of (partial) week, oldest->newest (1.19ms)
✔ computeLast28DayWindow: inclusive [as_of-27, as_of] (0.08ms)
✔ computeBaseline on fixture store matches hand-computed values for all 5 metric families (2.74ms)
✔ computeBaseline never throws on a missing store root (0.32ms)
✔ computeBaseline rejects a malformed --as-of instead of silently misbehaving (0.08ms)
✔ CLI: two consecutive runs against the fixture store are byte-identical (49.05ms)
✔ computeBaseline output has stable key order across repeated calls (1.03ms)
ℹ tests 8  ℹ pass 8  ℹ fail 0
```

Hand-computed values asserted (excerpt — full derivation is in the test file's comments):
- (a) per-week totals `[1, 2, 0, 1]` across W34-W37; W35 by_provenance `{none:1, observed:0, told:1}`.
- (b) per-week totals `[2, 4, 7, 3]`; W36 exercises `triggered/not_violated/not_triggered/predicted/predict_hit/other` all firing at once.
- (c) denominator=5, literal numerator=3 (0.6), canonical numerator=4 (0.8) — the divergence is exactly correction `c3` (retrieved→heeded→unknown: literal says "latest is unknown, not covered"; canonical says "heeded was ever present, covered").
- (d) = 4 (one retrieved-event id, `c1`, falls outside the 28-day window and is correctly excluded).
- Diagnostics: 7 correction files found / 6 parsed / 1 corrupt; 20 outcome lines / 18 parsed / 2 corrupt; 1 project missing `_outcomes.jsonl` despite having a `corrections/` dir.

Fixture run against the CLI directly (matches the test assertions):
```
$ node scripts/eval/evolution-baseline.mjs --store scripts/eval/fixtures/evolution-baseline-store --as-of 2026-09-17 --out /tmp/evolution-baseline-fixture-test.json
(a) ... W34 total=1 (none=1...) W35 total=2 (none=1 told=1) W36 total=0 W37 total=1 (observed=1)
(b) ... W34 total=2 W35 total=4 W36 total=7 W37 total=3
(c) verdict coverage: 3 / 5 = 0.6   canonical: 4 / 5 = 0.8
(d) distinct corrections retrieved in last 28 days: 4
(e) association edges: 0
diagnostics: projects_scanned=4 ... correction_json_files_corrupt_skipped=1 ... outcomes_lines_corrupt_skipped=2
```
All match the test's hand-computed expected values exactly.

## Live baseline table (real `~/.agent-recall`, `--as-of 2026-09-17`)

```
=== evolution-baseline (Phase 0 denominator) ===
schema        : evolution-baseline/v1
as_of         : 2026-09-17
store_root    : /Users/tongwu/.agent-recall

(a) corrections captured per week (last 4 full ISO weeks):
  2026-W34 [2026-08-17..2026-08-23]  total=1  (none=1 told=0)
  2026-W35 [2026-08-24..2026-08-30]  total=0  (none=0 told=0)
  2026-W36 [2026-08-31..2026-09-06]  total=0  (none=0 told=0)
  2026-W37 [2026-09-07..2026-09-13]  total=1  (none=0 told=1)

(b) outcome events per week by kind:
  2026-W34 [2026-08-17..2026-08-23]  total=86   (retrieved=45 unknown=9 not_triggered=27 predicted=5)
  2026-W35 [2026-08-24..2026-08-30]  total=140  (retrieved=73 heeded=1 unknown=19 not_triggered=45 predicted=2)
  2026-W36 [2026-08-31..2026-09-06]  total=90   (retrieved=63 heeded=3 recurred=2 not_triggered=22)
  2026-W37 [2026-09-07..2026-09-13]  total=103  (retrieved=47 heeded=3 not_violated=2 unknown=16 not_triggered=34 predicted=1)

(c) verdict coverage (literal brief spec, all-time):
  10 / 34 = 0.2941
  canonical-production comparison (presence-based): 28 / 34 = 0.8235

(d) distinct corrections retrieved in last 28 days [2026-08-21..2026-09-17]: 21

(e) association edges: 0

diagnostics:
  store_projects_dir_exists: true
  projects_scanned: 85
  projects_with_corrections_dir: 27
  projects_without_corrections_dir: 58
  correction_json_files_found: 108
  correction_json_files_parsed_ok: 107
  correction_json_files_corrupt_skipped: 0
  correction_json_files_missing_date_skipped: 1
  outcomes_files_found: 10
  outcomes_files_missing: 17
  outcomes_lines_total: 1588
  outcomes_lines_parsed_ok: 1588
  outcomes_lines_corrupt_skipped: 0
  outcomes_lines_invalid_timestamp_skipped: 0
```

Note on `correction_json_files_missing_date_skipped: 1` — traced to `~/.agent-recall/projects/probe-proj/corrections/undefined--don-t-stripped-injection-attempt-from-the-user.json`, a synthetic test/probe artifact with no `date` field (filename literally contains `undefined`), not a real correction. Skipped and counted per constraint 4, never crashed the reader.

Junk mega-slugs were **not** special-cased — e.g. `agentrecall-auto-tchin-talk-novada-mcp-novada-test-engineering-pareto-loop-plywood-prismma-vault` (83 total project dirs live, 85 counted by this run including 2 that appeared between the fixture design and the live run — see `projects_scanned`) is walked identically to every other project dir.

Artifact written to `scripts/eval/baselines/evolution-baseline-2026-09-17.json` (top-level keys: `schema, generated_at, as_of, store_root, window, metrics, diagnostics, schema_notes`).

## Read-only verification evidence

Marker-file probe around two consecutive live runs against the real store:

```
$ touch $MARKER; sleep 1
$ find ~/.agent-recall -newer $MARKER | wc -l
       0
$ node scripts/eval/evolution-baseline.mjs --as-of 2026-09-17 --out /tmp/run1.json --quiet
$ node scripts/eval/evolution-baseline.mjs --as-of 2026-09-17 --out /tmp/run2.json --quiet
$ find ~/.agent-recall -newer $MARKER | wc -l
       0
$ diff /tmp/run1.json /tmp/run2.json && echo IDENTICAL
IDENTICAL
$ md5 /tmp/run1.json /tmp/run2.json
MD5 (/tmp/run1.json) = 6edefec6496d6b43f1eec3a2be76e9dd
MD5 (/tmp/run2.json) = 6edefec6496d6b43f1eec3a2be76e9dd
```

Zero new/modified files under `~/.agent-recall` across two live runs; the two runs' JSON artifacts are byte-identical (same `--as-of`). The script also opens no file under `~/.agent-recall` in write mode anywhere in its source (only `fs.existsSync`/`fs.readFileSync`/`fs.readdirSync` are ever called against `storeRoot`; `fs.writeFileSync`/`fs.mkdirSync` are only ever called against the caller-supplied `--out` artifact path, which defaults into the repo's own `scripts/eval/baselines/`, never into the store).

Re-running against the **real artifact path** twice (`--out` defaulted) also produced identical MD5s (`6edefec6...`), confirming determinism constraint 2 end-to-end on the actual deliverable file, not just a throwaway `/tmp` copy.

## SUCCESS_WHEN checklist

- [x] Fixture tests pass with hand-computed expected values (8/8, `node --test`).
- [x] Two consecutive live runs byte-match (`diff` clean, identical MD5).
- [x] Read-only probe shows zero mutations (`find -newer` = 0 before and after).
- [x] Dated baseline JSON exists (`scripts/eval/baselines/evolution-baseline-2026-09-17.json`) with all five metric families populated.
- [x] Live baseline table appears above.

## Feedback epilogue (Plywood)
SOP_ID: d5b9da36
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth challenge_fired=true kept=data-engineer-boring-exact,read-only-probe-discipline,mirror-canonical-formula-before-diverging replaced=none

## Fix round (2026-09-17, verifier-confirmed blocking bug)

**Bug**: this worker's default artifact path (`scripts/eval/baselines/evolution-baseline-2026-09-17.json`) landed inside the exact directory `run-bench.mjs`'s `verifyAllBaselines()` sweeps unconditionally. That sweep only understands `bench-result/v1` and `rmr-baseline/v1|v2` schemas; this artifact's `evolution-baseline/v1` schema is neither, so `verifyBaseline()` threw `unknown schema_version "undefined"` (the artifact's top-level key is `schema`, not `schema_version` — a second, independent naming mismatch that would have surfaced even under a schema-aware sweep) and took down `TZ=UTC node scripts/eval/run-bench.mjs --corpus fixture` (exit 1) and `scripts/eval/bench-artifact.test.mjs`'s e2e test identically.

**Fix (1) — relocate, don't rely on sweep internals.** `verifyAllBaselines()` uses plain `fs.readdirSync(BASELINES_DIR)` (no `{recursive:true}`), so a subdirectory of `baselines/` (e.g. `baselines/evolution/`) would technically be invisible to it today — but that's an implementation detail, not a contract, so I did not use it. Moved the artifact to a true sibling directory instead: `scripts/eval/evolution-baselines/` (outside `scripts/eval/baselines/` entirely). Changed `defaultArtifactPath()` in `evolution-baseline.mjs` accordingly and documented why inline. Regenerated the artifact with the script itself (not hand-moved): `node scripts/eval/evolution-baseline.mjs --as-of 2026-09-17` against the real `~/.agent-recall` store (read-only, per the script's existing `fs.*` write-scope guarantee — only ever writes to the caller/`--out`-resolved artifact path). MD5 of the regenerated artifact (`6edefec6496d6b43f1eec3a2be76e9dd`) is byte-identical to the original run's MD5 recorded above, confirming the relocation + separator fix (below) changed nothing about the real-data numbers. Regenerated a second time to a scratch path and `diff`'d against the new canonical location — byte-identical. Deleted the stray original copy from `scripts/eval/baselines/evolution-baseline-2026-09-17.json`.

**Fix (2) — MINOR, collision-safe outcome key.** `outcomesByKey` grouped outcome events by `` `${project} ${evt.correction_id}` `` (space-joined). A project slug or correction_id containing a literal space could collide with a different (project, id) pair and silently merge their event timelines into metric (c)/(d). Changed the separator to `\u0000` (NUL) — a byte that cannot appear in either a project directory name or a JSON-string correction_id in practice, and it self-documents as "never occurs in real text" rather than "we haven't seen a collision yet." `node --test scripts/eval/evolution-baseline.test.mjs` stays 8/8 green unchanged (the fixture has no space-containing slugs/ids, so no test assertion needed updating).

**Proof, real outputs**:

```
$ TZ=UTC node scripts/eval/run-bench.mjs --corpus fixture
...
  verifyBaseline: OK correction-transfer-fixture-baseline.json
  verifyBaseline: OK correction-transfer-real-2026-07-03.json
  verifyBaseline: PARSE-ONLY (schema has no recomputable metrics) rmr-baseline-2026-07-02.json
  verifyBaseline: PARSE-ONLY (schema has no recomputable metrics) rmr-baseline-2026-07-03.json
...
EXIT=0

$ node --test scripts/eval/bench-artifact.test.mjs
ℹ tests 3  ℹ pass 3  ℹ fail 0

$ node --test scripts/eval/evolution-baseline.test.mjs
ℹ tests 8  ℹ pass 8  ℹ fail 0

$ node scripts/eval/evolution-baseline.mjs --as-of 2026-09-17 --quiet
$ md5 scripts/eval/evolution-baselines/evolution-baseline-2026-09-17.json
MD5 (scripts/eval/evolution-baselines/evolution-baseline-2026-09-17.json) = 6edefec6496d6b43f1eec3a2be76e9dd
$ node scripts/eval/evolution-baseline.mjs --as-of 2026-09-17 --out /tmp/regen2.json --quiet
$ diff scripts/eval/evolution-baselines/evolution-baseline-2026-09-17.json /tmp/regen2.json && echo BYTE_IDENTICAL
BYTE_IDENTICAL

$ ls scripts/eval/baselines/ | grep evolution   # stray copy gone
(no output)
```

Read-only probe re-run after the fix (same discipline as the original W3 report): `find ~/.agent-recall -newer $MARKER` = 0 both before and after every command above, across the full fix-and-verify sequence.
