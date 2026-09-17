# Evolution P0 W1 — bench verifier honesty fix

Worker: w1-bench-honesty. Branch: `evolution-p0-p4`. Repo: `/Users/tongwu/Projects/AgentRecall`.

## What changed

The bench-artifact verifier `verifyBaseline()` (`scripts/eval/bench-artifact.mjs`)
handles two schema families:

- `bench-result/v1` (correction-transfer) — **recomputes** `corpus_hash` from the
  manifest and every headline metric (`recall_theoretical`, `recall_achievable`,
  `precision`, `ffr`) from `per_item`, throwing on any drift.
- `rmr-baseline/v1` / `rmr-baseline/v2` — has no `per_item` to recompute
  metrics from; the function only confirms the JSON **parses**. The comment at
  line ~424 already said "Nothing to recompute for these schemas" — this was
  documented, but not surfaced to the reader.

`run-bench.mjs`'s `verifyAllBaselines()` printed `verifyBaseline: OK <file>`
for both cases identically, so a reader of the bench output could not tell a
genuine corpus_hash + metric recomputation apart from a bare JSON.parse
check. Confirmed the repo has both kinds of files committed under
`scripts/eval/baselines/` (`rmr-baseline-2026-07-02.json`,
`rmr-baseline-2026-07-03.json` are parse-only; `correction-transfer-*.json`
are recomputed), so this was not a hypothetical — every real `--verify-baselines`
run exhibited it.

### Fix

1. `verifyBaseline()` now returns `mode: "parse-only"` for `rmr-baseline/v1|v2`
   and `mode: "recomputed"` for the genuinely-recomputed path. JSDoc updated
   to document the contract and instruct callers to render the two modes
   distinctly.
2. `run-bench.mjs`:
   - `verifyAllBaselines()` (used by both `--verify-baselines` standalone mode
     and the normal fixture-run baseline sweep) now prints
     `verifyBaseline: PARSE-ONLY (schema has no recomputable metrics) <file>`
     for `mode === "parse-only"`, and keeps `verifyBaseline: OK <file>` only
     for `mode === "recomputed"`.
   - The `--update-baselines` fresh-fixture-baseline self-verify line was
     updated the same way (defensive/future-proofing — in practice this path
     is always `bench-result/v1`, so it always prints `OK`, but it no longer
     hardcodes the label past the point where `verifyBaseline()` tells it
     otherwise).
3. `bench-artifact.mjs`'s own standalone `--verify <file>` CLI entry point
   (same file, same defect, in scope per the brief's file list) updated
   symmetrically: `PARSE-ONLY: <benchmark> baseline parsed (schema has no
   recomputable metrics)` vs `OK: <benchmark> baseline verified`.

No verification *semantics* changed for the recomputed path — `corpus_hash`
and headline-metric recomputation, and the throw-on-drift behavior, are
byte-for-byte the same as before. Only the label attached to the parse-only
branch changed, plus a `mode` field added to the (informal) return contract.

## TDD evidence — RED then GREEN

New test file: `scripts/eval/bench-artifact.test.mjs` (node:test). Three
tests: two unit-level (`verifyBaseline()` on a synthetic `rmr-baseline/v1`
and `/v2` file must report `mode: "parse-only"`; on the real
`correction-transfer-fixture-baseline.json` must report `mode: "recomputed"`)
and one end-to-end (spawns the real `run-bench.mjs --verify-baselines`
against the real committed baseline files and asserts the rendered lines are
visually distinct per category).

**RED — run against pre-fix code:**

```
$ node --test scripts/eval/bench-artifact.test.mjs
✖ verifyBaseline() labels a parse-only rmr-baseline/v1 pass distinctly from a recomputed pass (2.63ms)
  AssertionError: rmr-baseline/v1 has no per_item to recompute from — verifyBaseline must self-report mode='parse-only'
  + actual - expected
  + undefined
  - 'parse-only'
✖ verifyBaseline() also labels rmr-baseline/v2 as parse-only (0.78ms)
  AssertionError: actual undefined, expected 'parse-only'
✖ run-bench.mjs --verify-baselines renders parse-only baselines distinctly from recomputed ones (113.66ms)
  AssertionError: rmr-baseline line must be labeled PARSE-ONLY, got:   verifyBaseline: OK rmr-baseline-2026-07-02.json
ℹ tests 3
ℹ pass 0
ℹ fail 3
```

Also captured the raw pre-fix CLI output directly (the defect as a human
would see it — all four lines byte-identical in their "verifyBaseline:"
prefix):

```
$ node scripts/eval/run-bench.mjs --verify-baselines
  verifyBaseline: OK correction-transfer-fixture-baseline.json
  verifyBaseline: OK correction-transfer-real-2026-07-03.json
  verifyBaseline: OK rmr-baseline-2026-07-02.json
  verifyBaseline: OK rmr-baseline-2026-07-03.json
```

**GREEN — after fix:**

```
$ node --test scripts/eval/bench-artifact.test.mjs
✔ verifyBaseline() labels a parse-only rmr-baseline/v1 pass distinctly from a recomputed pass (2.09ms)
✔ verifyBaseline() also labels rmr-baseline/v2 as parse-only (0.43ms)
✔ run-bench.mjs --verify-baselines renders parse-only baselines distinctly from recomputed ones (73.76ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

Actual CLI output post-fix:

```
$ node scripts/eval/run-bench.mjs --verify-baselines
  verifyBaseline: OK correction-transfer-fixture-baseline.json
  verifyBaseline: OK correction-transfer-real-2026-07-03.json
  verifyBaseline: PARSE-ONLY (schema has no recomputable metrics) rmr-baseline-2026-07-02.json
  verifyBaseline: PARSE-ONLY (schema has no recomputable metrics) rmr-baseline-2026-07-03.json
  all baselines verified
```

(One test-authoring bug of my own surfaced mid-loop and was fixed before
declaring GREEN: my first version of the "visually distinct prefixes"
assertion split on a broken regex and failed even against correct
post-fix output; root cause was in the test's string-splitting, not the
fix. Replaced with a straightforward "strip the trailing filename, compare
what remains" comparison — reran and it passed. Documented here per the
"verifications must demonstrably fire" discipline: the failure was real,
diagnosed, and the corrected assertion still fails against pre-fix code and
passes against post-fix code (re-verified both directions above).)

Existing embedded self-test unaffected:
```
$ node scripts/eval/bench-artifact.mjs --self-test
...
21 passed, 0 failed
```

## Determinism check

Built all packages first (`npm run build` — required only so
`bench-artifact.mjs`'s import of `packages/core/dist/...` resolves; no
tracked files under `packages/` changed — `dist/` is gitignored).

`--check-determinism` gate (existing double full-pipeline-run byte-diff,
strips `generated_utc`/`environment` before comparing):

```
$ TZ=UTC node scripts/eval/run-bench.mjs --corpus fixture --check-determinism
  ── determinism check (double full-pipeline run) ──
  PASS: byte-identical after stripping generated_utc/environment
```

Additionally ran the literal command from the brief's constraint #2 twice
end-to-end and diffed full stdout:

```
$ TZ=UTC node scripts/eval/run-bench.mjs --corpus fixture > /tmp/bench-run1.txt
$ TZ=UTC node scripts/eval/run-bench.mjs --corpus fixture > /tmp/bench-run2.txt
$ diff <(grep -v generated_utc /tmp/bench-run1.txt) <(grep -v generated_utc /tmp/bench-run2.txt)
(no output — identical)
$ diff /tmp/bench-run1.txt /tmp/bench-run2.txt
17c17
<   generated_utc      2026-09-17T11:02:54.552Z
---
>   generated_utc      2026-09-17T11:02:54.639Z
```

Only the wall-clock `generated_utc` line differs, which is pre-existing,
expected volatility already excluded by the repo's own determinism gate
(`stripVolatileFields`) — not something this fix introduced or needs to
suppress. No pinned baseline of *rendered* CLI text exists anywhere in the
repo (searched for snapshot/golden-output files; none found), so there was
nothing to regenerate via `--update-baselines`. I did not run
`--update-baselines` — the underlying JSON baseline artifact and its
`corpus_hash`/metrics are unchanged by this fix (only console labeling
changed), so regenerating it would have been a no-op mutation of a tracked
file for no reason; `git status --short scripts/eval/baselines/` confirms
it is untouched.

## CI-lane steps (`.github/workflows/bench-fixture.yml`), run locally

```
$ node scripts/eval/fixtures/validate-fixture.mjs        → ALL ASSERTIONS PASSED, exit 0
$ grep -rnE 'Math\.random\s*\(\s*\)' scripts/eval          → no match (gate passed)
$ node scripts/eval/run-bench.mjs --corpus fixture         → exact-match gate: PASS; exit 0
$ node scripts/eval/run-bench.mjs --corpus fixture --check-determinism → PASS
$ node scripts/eval/run-bench.mjs --verify-baselines       → all baselines verified, exit 0
```

All five CI-lane steps pass locally after the fix.

## Scope discipline

Changed: `scripts/eval/bench-artifact.mjs`, `scripts/eval/run-bench.mjs`
(both existing files, minimal diffs), plus new
`scripts/eval/bench-artifact.test.mjs`. No `packages/` files touched (dist/
is gitignored build output, not tracked). No files under `~/.agent-recall`
touched. No `git commit`/`git push` run — left for the orchestrator.

`git diff --stat` for the two edited files: 21 insertions/6 deletions in
`bench-artifact.mjs`, 12 insertions/5 deletions in `run-bench.mjs`.

## Escalation / challenge check

Per the brief's ESCALATION clause, checked whether the literal `"OK"` string
is load-bearing for any CI gate (i.e., some step greps stdout for `"OK"` and
would break if the rmr-baseline lines no longer say `OK`). Read
`.github/workflows/bench-fixture.yml` in full: the "Gate — verify all
baselines" step only checks the process exit code of
`node scripts/eval/run-bench.mjs --verify-baselines` (via shell `if`/`ls`),
never greps stdout content. No other workflow step or script in the repo
greps for the string `"verifyBaseline: OK"` (searched `.github/workflows/`,
`*.md`, `*.json`, `*.txt` — no hits besides this report and the source
files themselves). **No dependency found — nothing to escalate.**

Also checked the brief's premise that the named comment/line exists as
described: confirmed — `scripts/eval/bench-artifact.mjs` line 425 (pre-fix)
was exactly `// Nothing to recompute for these schemas; just confirm they
parse`, and `run-bench.mjs` rendered it as `verifyBaseline: OK` in two call
sites (line 496, the baseline sweep; line 603, the fresh-fixture self-verify
after `--update-baselines`). Brief's factual claims held; no challenge
needed.

SOP_ID: 9f7865ba
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth challenge_fired=false kept=labels replaced=labels
