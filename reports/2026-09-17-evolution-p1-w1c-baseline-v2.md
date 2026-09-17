# Evolution p1c — evolution-baseline.mjs v2 (worker w1c-baseline-v2)

Branch: `evolution-p0-p4` (confirmed via `git branch --show-current` before any edit).
Scope: `scripts/eval/evolution-baseline.mjs`, `scripts/eval/evolution-baseline.test.mjs`,
new fixture dir `scripts/eval/fixtures/evolution-baseline-store-v2/`. No `git commit`/`push`,
no writes to `~/.agent-recall`.

## CHALLENGE — the brief's "Phase 1b already merged" premise

The brief's CONTEXT states: *"Phase 1b added corrections with
provenance.source='transcript-implicit'. Read those implementations first."*

At task start, `git log --all` on `evolution-p0-p4` and a repo-wide grep for
`transcript-implicit` found **zero** occurrences — only Phase 0 (`7ff7af4`)
and Phase 1a (`c59f04d`) are merged. I built and tested the whole v2 design
on that basis (see "Design decisions" below), treating the claim as false and
flagging it in schema_notes rather than hardcoding the literal string.

**Mid-task discovery**: `git status` (run only once I'd finished, as a
pre-report sanity check) showed unstaged, uncommitted edits to
`packages/core/src/tools-logic/implicit-harvest.ts` (new, untracked),
`packages/core/src/storage/corrections.ts`, `packages/core/src/index.ts`,
`packages/core/src/tools-logic/transcript-audit.ts`, and
`packages/cli/src/index.ts` — none of which I touched. File mtimes
(14:26–14:33) fall entirely inside my own working session. Reading the diffs
(read-only) confirms this **is** Phase 1b, mid-flight: a new `ar corrections
harvest-implicit` CLI command, a `WriteCorrectionOptions.skipActionableGate`
seam on `writeCorrection`, and `implicit-harvest.ts` writing exactly
`provenance: { source: "transcript-implicit", mode: "observed" }`.

So the brief's premise wasn't false — it's **real, but was still uncommitted
and being written concurrently by an apparent sibling worker in this exact
same checkout** (`/Users/tongwu/Projects/AgentRecall`, no worktree
separation) while I worked. Two things follow:

1. **My design is validated, not invalidated.** (h)'s definition —
   "implicit" = `provenance.mode === "observed"`, grouped by the raw
   `provenance.source` string (class, not instance; no hardcoded literal) —
   is an *exact* semantic match for what `implicit-harvest.ts` actually
   writes. Once that work is committed, `evolution-baseline.mjs` will bucket
   it correctly with **zero further changes**. Had I hardcoded
   `"transcript-implicit"` as a special-cased filter (matching the brief's
   literal wording) instead of the generic mode-based rule, it would have
   worked too, in this one instance — but would silently miss any other
   future implicit-producer's source tag, which is exactly the
   class-not-instance failure mode to avoid.
2. **ESCALATION (process, not code)**: multiple evolution workers appear to
   share one un-worktreed checkout. I never touched the files the other
   worker was editing (scope was `scripts/eval/` only, per brief constraint
   5), so no collision occurred here — but the setup itself has no isolation
   against two workers editing the same file simultaneously. Worth flagging
   to the orchestrator: per-worker git worktrees (or serialized file-scope
   assignment, which this batch of briefs already does by directory) would
   remove the risk rather than relying on scope discipline alone.

## What was implemented (schema `evolution-baseline/v2`, additive only)

Read first: `scripts/eval/evolution-baseline.mjs` (Phase 0/v1),
`scripts/eval/evolution-baseline.test.mjs`, `packages/core/src/tools-logic/transcript-audit.ts`
(Phase 1a), `packages/core/src/storage/corrections.ts`'s `CorrectionOutcome`/`CorrectionProvenance`.

- **(f) `metrics.transcript_audit_events_per_week`** — cited/ignored/`audit_recurred`
  ("recurred" events whose `evidence` starts with `"transcript-audit:"`, the
  single-producer gate `recordOutcome()` enforces) per the same last-4-full-ISO-weeks
  window as v1's (a)/(b). Ordinary recurred stays in (b)'s existing `recurred`
  bucket, untouched.
- **(g) `metrics.injection_precision`** — `cited/(cited+ignored)`, aggregated over
  the *same* 4-week window as (f) (there's no broader population to draw from
  since (f) is the only source of cited/ignored counts this script computes).
  `null` when denominator is 0, never 0.
- **(h) `metrics.implicit_corrections`** — "implicit" = `provenance.mode === "observed"`.
  `total_by_source` is **all-time** (every observed-mode correction ever,
  any date); `per_week` is windowed to the same 4 weeks as (a). Grouped by
  the raw `provenance.source` string (class, not instance — see CHALLENGE above).
- **(i) `metrics.injection_outcome_coverage`** — share of `(project, correction_id, day)`
  "retrieved" pairs that also have a transcript-audit-evidenced event
  (cited|ignored|recurred, `transcript-audit:` prefix) for that same pair.
  **All-time** (not window-limited, same population style as v1's (c)/(d)).
  Dual denominators, always printed together:
  - `theoretical` = numerator / every retrieved-day pair, ever.
  - `achievable` = numerator / retrieved-day pairs whose **day** (not
    project-scoped — see ESCALATION below) had ≥1 transcript-audit event
    anywhere in the store.

### ESCALATION — dual-denominator scope for (i)

The brief's wording ("≥1 transcript-audit event exists for ANY correction
that day") is ambiguous between "any correction in the same project" and
"any correction anywhere in the store." I chose the **global** (store-wide)
reading and documented it in `schema_notes.injection_outcome_coverage_v2`:
`transcript-audit.ts`'s `runTranscriptAudit()` scans the transcript directory
**once per day for every project in a single run** — "a day the auditor
could see" is a property of the day, not of a `(day, project)` pair, so the
achievable ceiling should not be artificially narrowed to one project.

### ESCALATION — (g)'s window and (h)'s two populations

Documented in `schema_notes`: (g) is windowed (not all-time) because its only
inputs are (f)'s windowed counts. (h) deliberately has two different
populations (`total_by_source` all-time vs `per_week` windowed) — the fixture
test proves this isn't a bug: `imp4` (2026-09-16, current partial week)
counts in `total_by_source["transcript-implicit"]` (3) but not in any
`per_week` bucket (windowed sum = 2).

## Additive proof — v1 untouched

```
$ git diff --stat scripts/eval/fixtures/evolution-baseline-store/
   (empty — zero bytes changed)
$ git status --short scripts/eval/fixtures/
?? scripts/eval/fixtures/evolution-baseline-store-v2/
```

The v1 fixture directory was never opened for writing. All v2 fixture data
(cited/ignored/audit-recurred events, observed-mode corrections, the
theoretical-vs-achievable coverage gap cases) lives in a brand-new sibling
fixture, `evolution-baseline-store-v2/` — extending the v1 fixture in place
would have silently perturbed its own hand-computed diagnostics counts
(`projects_scanned`, `outcomes_lines_total`, …) and the `other` bucket in
`outcome_events_per_week` (cited/ignored aren't in v1's `KNOWN_OUTCOME_KINDS`,
so any new such line landing in the v1 fixture's existing 4-week window would
have changed a number the *existing, un-edited* test already asserts exactly).

I did not need the CHALLENGE clause's refactor-allowance at all — no existing
v1 code path was rewritten, only new computation added alongside it (new
counters accumulated in the same loops, new keys appended to the return
object). The existing test file's lines 1–216 are **byte-identical** to
before my change (confirmed via `git diff`) except for one new constant
(`FIXTURE_STORE_V2`) inserted above them; every pre-existing assertion is
untouched and still passes.

## RED → GREEN

RED (new v2 assertions added first, against the not-yet-extended script):

```
✖ schema bumps to evolution-baseline/v2
  actual: 'evolution-baseline/v1'  expected: 'evolution-baseline/v2'
✖ v2 fields on the v1 (no v2 signals) fixture: all-zero / null, never crash
  TypeError: result.metrics.transcript_audit_events_per_week is not iterable
✖ computeBaseline on the v2-signal fixture matches hand-computed values for (f)/(g)/(h)/(i)
  TypeError: Cannot read properties of undefined (reading 'map')
ℹ tests 12  ℹ pass 9  ℹ fail 3
```

GREEN (after implementation):

```
$ node --test scripts/eval/evolution-baseline.test.mjs
✔ isoWeekLabel: 2026-09-17 (Thursday) falls in ISO week 2026-W38
✔ computeLast4FullIsoWeeks: excludes the as-of (partial) week, oldest->newest
✔ computeLast28DayWindow: inclusive [as_of-27, as_of]
✔ computeBaseline on fixture store matches hand-computed values for all 5 metric families
✔ computeBaseline never throws on a missing store root
✔ computeBaseline rejects a malformed --as-of instead of silently misbehaving
✔ CLI: two consecutive runs against the fixture store are byte-identical
✔ computeBaseline output has stable key order across repeated calls
✔ schema bumps to evolution-baseline/v2
✔ v2 fields on the v1 (no v2 signals) fixture: all-zero / null, never crash
✔ computeBaseline on the v2-signal fixture matches hand-computed values for (f)/(g)/(h)/(i)
✔ CLI: two consecutive runs against the v2-signal fixture store are byte-identical
ℹ tests 12  ℹ pass 12  ℹ fail 0
```

(One test-expectation bug of my own was caught and fixed along the way, not
a code bug: I initially asserted the v1 fixture has zero observed-mode
corrections for the "v1 fixture ⇒ v2 fields all-zero" test, forgetting that
v1's own `c3` fixture record already carries `provenance: {source:
"session-id-xyz", mode: "observed"}`. Corrected the assertion to
`{ "session-id-xyz": 1 }` — this is real (h) signal that predates v2 and a
useful proof that (h) isn't accidentally gated on v2-only fixture data.)

## Determinism

Both via the test suite's CLI-diff tests and a manual double-run outside the
test harness:

```
$ node scripts/eval/evolution-baseline.mjs --store fixtures/evolution-baseline-store    --as-of 2026-09-17 --out /tmp/v1-run1.json --quiet
$ node scripts/eval/evolution-baseline.mjs --store fixtures/evolution-baseline-store    --as-of 2026-09-17 --out /tmp/v1-run2.json --quiet
$ diff /tmp/v1-run1.json /tmp/v1-run2.json && echo "V1-STORE: two runs byte-identical"
V1-STORE: two runs byte-identical
$ node scripts/eval/evolution-baseline.mjs --store fixtures/evolution-baseline-store-v2 --as-of 2026-09-17 --out /tmp/v2-run1.json --quiet
$ node scripts/eval/evolution-baseline.mjs --store fixtures/evolution-baseline-store-v2 --as-of 2026-09-17 --out /tmp/v2-run2.json --quiet
$ diff /tmp/v2-run1.json /tmp/v2-run2.json && echo "V2-STORE: two runs byte-identical"
V2-STORE: two runs byte-identical
```

## v2-signal fixture hand-computation (walked, not re-derived from the script)

Store: `scripts/eval/fixtures/evolution-baseline-store-v2/projects/proj-v2/`.
`_outcomes.jsonl` events: `cA` retrieved+cited 2026-08-18 (W34), `cB`
retrieved+audit-recurred 2026-08-19 (W34), `cC` retrieved only 2026-08-25
(W35, no audit anywhere that day), `cA` retrieved+ignored again 2026-08-26
(W35), `cD` retrieved 2026-08-26 (same day as cA's ignored, but gets nothing
itself), `cA` PLAIN (non-audit) recurred 2026-09-05 (W36). Correction records:
`imp1`/`imp2`/`imp4` (`transcript-implicit`, observed) in W34/W35/current-partial,
`imp3` (`dream-implicit-audit`, observed) in W37, `told1` (told) and
`c-no-prov` (no provenance) as negative cases.

- (f): W34 `cited=1 ignored=0 audit_recurred=1`, W35 `cited=0 ignored=1 audit_recurred=0`,
  W36/W37 all zero (the W36 event is plain, correctly excluded from `audit_recurred`).
- (g): `cited=1, ignored=1 → precision=0.5`.
- (h): `total_by_source = {"dream-implicit-audit":1,"transcript-implicit":3}`;
  windowed per-week sum for `transcript-implicit` is only 2 (`imp4` excluded,
  current partial week) — proves total ≠ Σ(per_week).
- (i): 5 retrieved pairs total. `cC`'s day (2026-08-25) has zero audit
  evidence anywhere → excluded from `achievable` denominator only.
  `theoretical = 3/5 = 0.6`, `achievable = 3/4 = 0.75` (numerator unchanged,
  since every covered pair's day is trivially globally-audited by
  construction — verified this invariant holds, not just asserted it).

Actual script output for this store matches every one of the above numbers
exactly (see `node scripts/eval/evolution-baseline.mjs --store
fixtures/evolution-baseline-store-v2 --as-of 2026-09-17` table output,
reproduced in full in the session transcript).

## Files changed

- `scripts/eval/evolution-baseline.mjs` — schema bump to `evolution-baseline/v2`;
  additive (f)/(g)/(h)/(i) computation, schema_notes, renderTable additions.
- `scripts/eval/evolution-baseline.test.mjs` — appended new test blocks only
  (one new constant `FIXTURE_STORE_V2` added above the existing tests;
  every pre-existing line/assertion below it is untouched).
- `scripts/eval/fixtures/evolution-baseline-store-v2/` — new fixture store
  (10 correction records + 1 `_outcomes.jsonl`, single project `proj-v2`).

Not touched (confirmed via `git diff --stat`): `scripts/eval/fixtures/evolution-baseline-store/`.

Also present in the working tree but **not authored by me** and **not part
of this brief's scope**: uncommitted edits to `packages/core/src/storage/corrections.ts`,
`packages/core/src/tools-logic/transcript-audit.ts`, `packages/core/src/index.ts`,
`packages/cli/src/index.ts`, and a new `packages/core/src/tools-logic/implicit-harvest.ts` —
this is the in-flight Phase 1b work discussed in the CHALLENGE section above.

SOP_ID: 26252a5e
FEEDBACK_HINTS: outcome=success edited=clean escalated=escalated challenge_fired=true kept=additive-schema-bump,separate-v2-fixture,class-not-instance-provenance-grouping,nested-map-not-string-key replaced=none
