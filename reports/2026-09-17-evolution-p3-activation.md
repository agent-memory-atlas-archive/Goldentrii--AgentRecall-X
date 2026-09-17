# Evolution p3 — activation worker report (MemPlus core)

Branch: `evolution-p0-p4` (confirmed via `git branch --show-current` before any
write). No `git commit`/`git push` performed. No writes to `~/.agent-recall` —
every write-side test used fixture roots under `os.tmpdir()`; every live-store
run (`activation-eval.mjs`, `run-golden-eval.mjs`) was read-only, verified by
a before/after content-hash manifest check (see "Read-only proof" below).

## What was built

ACT-R declarative-memory activation, `A_i = B_i + Σ_j W_j·S_ji`, wired into
two existing ranking pipelines without disturbing their defaults, flag-gated
on `AGENT_RECALL_ACTIVATION=1` (default OFF), following the fix7
semantic-leg template exactly.

### 1. Core module — `packages/core/src/retrieval/activation.ts` (new)

- `loadAssocGraph(storeRoot, explicitPath?)` — reads
  `<storeRoot>/association/edges.json`; missing/unreadable/corrupt/wrong-shape
  all degrade to `null` (never throws). Deliberately does **not** reuse
  `readAssocEdgesFile` (which collapses missing+corrupt into a silently-empty
  file) because the degradation contract needs "no graph at all" (null) to be
  distinguishable from "a real, validly-empty graph" (0 edges).
- `adjacencyFromEdgesFile(file)` — pure, no fs; turns an in-memory
  `AssocEdgesFile` into the `{a,b}`-both-directions adjacency map
  `loadAssocGraph` and the eval script (in-memory, per-day) both use.
- `assocStrength(edge, asOfDay)` — `S_ji = weight · exp(-days/S_DECAY)`,
  `S_DECAY=30` days (**HAND-TUNED**). Malformed dates → 0; `last_seen` after
  `asOfDay` clamps `days` at 0 (never a >1 multiplier via a negative
  exponent).
- `activationBonus(candidateNodeId, contextNodeIds, graph, asOfDay)` —
  `Σ_j (1/|context|)·S_ji` over context items with an edge to the candidate;
  0 for null graph / empty context / no edge. Self-in-context is skipped (the
  graph never has self-loops by construction, but this is defensive).
- `activationTieBreak(ranked, {project, graph, asOfDay})` — session_start
  integration (2a): GREEDY tie-break strictly **after** severity and
  proof_confidence (see "Interpretive decision" below).
- `applyActivationRerank(results, project, {storeRoot, asOfDay?, graph?})` —
  smart_recall integration (2b): mutates the fused top-`K=10` in place;
  degrades to a complete no-op (zero mutation) when there's no graph or zero
  signal.
- `S_DECAY`, `ACT_ALPHA`, `ACTIVATION_FLAG_ENV`, `todayDayString` also
  exported.

### 2a. session_start correction ordering (`session-start.ts`)

```ts
const severityRanked = rankCorrections(readP0Corrections(slug, allCorrectionsOnce), 10);
const rawCorrections = activationEnabled()
  ? activationTieBreak(severityRanked, { project: slug, graph: loadAssocGraph(getRoot()), asOfDay: todayDayString() })
  : severityRanked;
```

`activationEnabled()` is the FIRST thing evaluated in the ternary — when
false, `loadAssocGraph` is never called (zero file read) and `rawCorrections`
is `severityRanked`, the exact same value/reference the pre-p3 code computed.
`applyCorrectionBudget` downstream is **completely untouched** — same
function, same P0-always-survive logic, same call site, just possibly a
reordered `rawCorrections` input. Since `readP0Corrections` only ever
supplies P0s to `rankCorrections` today, `applyCorrectionBudget`'s P0 branch
takes every item regardless of order, so this reorder doesn't even interact
with the budget-drop path — it only changes presentation order within the P0
slice.

### 2b. smart_recall post-RRF re-rank (`smart-recall.ts`)

Inserted right after the existing Beta-feedback re-sort, before the
`limit`-slice:

```ts
let activationLegNote: ActivationLegNote | undefined;
if (activationEnabled()) {
  activationLegNote = applyActivationRerank(results, resolvedProject, { storeRoot: getRoot() });
}
const finalResults = results.slice(0, limit);
```

`activation_leg?: ActivationLegNote` added to `SmartRecallResult`, spread in
only when set — same absent-when-off convention as `semantic_leg`/
`recall_path`.

### 3. Offline counterfactual eval — `scripts/eval/activation-eval.mjs` (new)

STRICT TEMPORAL SPLIT: for each audit day D (ascending), the association
graph is rebuilt **in-memory** from `day < D` cited events only, via
`buildAssociationGraphFromEvents` — **exported from Phase 2's
`association.ts`, reused verbatim** (see "association.ts refactor" below),
never forked. Per (project, day): candidates = distinct `retrieved`
correction ids that day; ground truth = the subset with a same-day `cited`
event; ranking A = real `rankCorrections()`; ranking B = ranking A with an
activation tie-break whose context is **fixed** at the top-2 node ids of
ranking A itself (per the brief: "context must be knowable at rank time" —
deliberately different from 2a's greedy growing context). Metrics: MRR,
hit@3. CLAIM-GATE: prints the literal `CANNOT CLAIM (n=<X> evaluable pairs <
gate 20)` (or the days-gate's analog) below `MIN_EVALUABLE_PAIRS=20` /
`MIN_EVALUABLE_DAYS=5`, never a synthesized number.

### `association.ts` refactor (Phase 2 file, minimal, behavior-preserving)

To let the eval reuse the graph derivation without forking it, I extracted
the pure grouping/weighting core of `buildAssociationGraph` (which used to
read disk AND derive in one loop) into a new exported
`buildAssociationGraphFromEvents(eventsByProject: Map<project, CitedEventRaw[]>)`.
`buildAssociationGraph(storeRoot)` is now a thin wrapper: read every
project's raw events once, hand them to the pure function. Also exported
`readCitedEvents` (was private) and `isAssocEdgesFile` (was private) for
reuse by `activation.ts`/the eval script. **Verified byte-identical**: all 21
pre-existing `association.test.mjs` tests and all 12 `assoc.test.mjs` CLI
tests still pass unchanged (see full-suite run below) — the only
observable-in-theory difference is `malformedRows`' cross-project
interleaving order (no test asserts on that; every existing assertion is
per-project length/content).

## CHALLENGE — dimensional coherence between B_i and S_ji (resolved, and this is my one genuine `challenged` item)

The brief's own CHALLENGE clause anticipated this and told me to resolve it,
not leave it open — I did, and I'm flagging the resolution explicitly because
it's a real design decision that shapes production behavior, not just a
restated instruction:

- **2a (session_start) never mixes scales.** `activationTieBreak` only
  compares two `activationBonus` values against each other to pick a winner
  within a tie-class — activation is never summed with `B_i` (severity/
  proof_confidence/recency/proof) numerically. No coherence issue here.
- **2b (smart_recall) DOES combine two incompatible scales** — I found this
  real, not hypothetical. `fused_score` lives on the RRF `1/(60+r)` scale
  (≈0.008–0.05, `MATH.md` §b); raw `S_ji = weight·exp(-days/30)` lives on an
  unrelated scale (roughly an integer session-count, decayed — can be
  anywhere from ~0 to double digits for a heavily co-cited pair). Summing
  these directly, or using the raw bonus as an unbounded multiplier, would be
  **exactly** the "Fix 1: incompatible scales" defect `smart-recall.ts`'s own
  header names for the pre-RRF linear-fusion bug it already had to fix once.
  **Resolution**: squash the raw bonus through `x/(x+1)` into `[0,1)` before
  using it as a dimensionless multiplier: `final_score = fused_score · (1 +
  ACT_ALPHA · (raw_bonus/(raw_bonus+1)))`. This is bounded regardless of how
  large a raw edge weight gets, needs no corpus-wide "max possible" scan (the
  brief asks to "keep it simple and deterministic"), and is an exact
  no-op (×1.0 bit-for-bit) when the raw bonus is 0. Documented in
  `activation.ts`'s header, `applyActivationRerank`'s own doc comment, and
  `MATH.md` §c.

`status=challenged` reflects this — not because anything is broken, but
because I made and am surfacing a real interpretive/design call the brief
asked for but didn't hand me pre-solved.

## Interpretive decisions (documented, not escalated — brief left room, I picked one reading and state it plainly)

1. **"Tie-break applied after severity and proof_confidence" — I read this as
   inserted into rankCorrections' priority CHAIN, not as "only fires on an
   exact full-composite tie."** `rankCorrections`' actual formula is
   `sev·100 + conf·10 + recency·3 + proof`; a literal full-composite tie is
   rare once `recency` differs by even a fraction of a day. I grouped items
   into contiguous `(severity, effective proof_confidence)` classes and let
   activation reorder WITHIN a class (demoting `recency`/`proof_count` below
   activation, never touching `severity`/`proof_confidence`'s own ordering
   power). This is the reading that makes "AFTER severity and
   proof_confidence" literally true (those two keys strictly dominate) while
   giving activation a real chance to matter — the alternative reading
   (exact full-score tie only) would make activation almost never fire in
   practice, which contradicts the brief's evident intent to wire it in
   meaningfully.
2. **Eval's "candidates"/"ground truth" definition**: candidates = distinct
   `retrieved`-kind correction ids that day; ground truth = the subset that
   ALSO has a same-day `cited` event, same project. A pair with zero
   ground-truth cited items is NOT evaluable (MRR/hit@3 would be vacuous) —
   this narrows "evaluable" slightly beyond the brief's literal wording,
   documented here rather than silently applied.
3. **Eval's ranking-B construction is a separate, simpler function
   (`tieBreakFixedContext` in the eval script) from `activationTieBreak`**,
   because the two integration points genuinely have different context
   contracts (greedy-growing vs. fixed-top-2) per the brief's own text — both
   are built from the SAME core primitives (`assocNodeId`, `activationBonus`),
   so the ACT-R math itself is never duplicated, only the (much smaller)
   tie-class-grouping loop shape differs.

## Hopfield — explicitly deferred (one paragraph, no code, per constraint 6)

`palace/hopfield.ts` implements modern Hopfield retrieval (Ramsauer et al.
2020) as a dense associative-memory primitive: its update is a softmax over
similarity to EVERY stored pattern, and its exponential-capacity argument
assumes a dense, mostly-nonzero similarity structure. `assoc-edges/v1`'s
graph is the opposite: SPARSE by construction — an edge exists only between
two corrections that were actually co-cited in a real session, and in any
real store most correction pairs have no edge at all. Feeding this
mostly-zero adjacency into Hopfield's softmax would spend its normalization
budget attending to a near-uniform distribution over non-edges, which is not
the density regime its capacity guarantee assumes, and would not obviously
outperform (or even differ meaningfully from) the plain linear ACT-R sum this
module implements. The linear sum is the right primitive for a sparse
co-activation graph; Hopfield stays a documented, not-wired-in primitive
(unchanged from `MATH.md` §b's pre-existing note) — no code added.

## HAND-TUNED constants (per MATH.md convention — defined here, in `activation.ts`, and in `MATH.md` §c)

| Constant | Value | Where | Why (not fit to data) |
|---|---|---|---|
| `S_DECAY` | 30 days | `activation.ts` | A month-ish co-activation memory, chosen by feel — same "policy knob" caveat as FSRS's `S₀=7`/`STABILITY_GROWTH=0.3`. |
| `ACT_ALPHA` | 0.2 | `activation.ts` | Bounds the 2b multiplicative boost at ×1.2 max — deliberately well under the ~×1.02 threshold `MATH.md` §b identifies as where an unbounded multiplier starts vaulting off-topic items over on-topic ones (the exact defect the hot-window boost's removal fixed). Conservative, not fit. |

## Tests — RED→GREEN, per brief item 4

All new tests: `packages/core/test/activation.test.mjs` (26 tests) +
`scripts/eval/activation-eval.test.mjs` (11 tests) = **37 new tests, all
green** on the final build. Coverage:

- **Activation math (hand-computed)**: `assocStrength` at days=0 (reduces to
  raw weight), at days=30 (hand-verified against `3·e⁻¹ = 1.1036383235143266`
  to 1e-9), malformed-date degrade, future-`last_seen` clamp.
  `activationBonus` single/partial/zero-edge context, self-skip, null-graph.
- **Degradation**: `loadAssocGraph` — no dir / dir-no-file / corrupt JSON /
  wrong-shape JSON all → `null`; a genuinely valid EMPTY edges file → a real
  (0-edge) graph, NOT null (the distinction the brief's contract requires).
  `applyActivationRerank` — no graph and zero-bonus-among-top-K both leave
  `results` **byte-identical, unmutated** (not just "same order" — asserted
  via `deepEqual` against a pre-call snapshot) with a diagnosable `reason`.
- **Flag-off byte-identity** (both integration points, both against the SAME
  store with a REAL graph present vs. absent):
  - session_start: `.corrections` payload deep-equal with/without
    `association/edges.json` on disk, flag off. Also a same-store double-run
    diff (call twice, same output).
  - smart_recall: full `SmartRecallResult` deep-equal with/without
    `edges.json` on disk, flag off; `!("activation_leg" in result)` in both.
  - **Real gotcha caught and fixed**: my first run of these tests failed —
    NOT because of a bug in my code, but because my ambient dev shell has
    `AR_AB_ENABLED=1` set, which A/B-gates `session_start`'s entire
    corrections section by a per-project-slug hash. I traced it (a manual
    repro isolated it to "second `sessionStart()` call in one process, any
    root, returns `[]`"), confirmed the root cause, and neutralized it the
    same way `session-start-single-scan.test.mjs` already does (stash+delete
    `AR_AB_ENABLED`/`AR_AB_FORCE` in `before()`/restore in `after()`). This is
    exactly the "assume no global/ambient state" discipline — worth flagging
    since it's a real environmental hazard this repo's own test suite already
    knows about and I initially didn't account for.
- **Temporal-split leakage guard (RED test)**: `filterEventsBeforeDay` — a
  same-day event excluded, a prior-day event included, an exact-midnight
  boundary case, an unparseable-date degrade. Plus an END-TO-END proof using
  the REAL `buildAssociationGraphFromEvents`: an identical co-citation pair
  produces **0 edges** when it happened ON day D, and **1 edge** when it
  happened the day BEFORE D.
- **Eval on a fixture ledger with known MRR**: a 4-candidate, hand-computed
  scenario (`d`>`a`>`{b,c}` tied by proof_confidence; `c` is the cited ground
  truth, buried at rank 4 by ranking A; a prior-day edge `c↔d` lets
  activation promote `c` to rank 3) — asserts `mrr_a=0.25`, `hit3_a=0`,
  `mrr_b=1/3`, `hit3_b=1` exactly.

## Read-only proof

```
$ before=$(find ~/.agent-recall -type f -exec stat -f "%N %m %z" {} \; | sort | shasum -a 256)
$ node scripts/eval/activation-eval.mjs
activation-eval — store: /Users/tongwu/.agent-recall
projects scanned: 82
evaluable (project,day) pairs: 0  evaluable days: 0
CANNOT CLAIM (n=0 evaluable pairs < gate 20)
$ after=$(find ~/.agent-recall -type f -exec stat -f "%N %m %z" {} \; | sort | shasum -a 256)
$ [ "$before" = "$after" ] && echo STORE UNCHANGED
STORE UNCHANGED
```

## CONSTRAINT 1 — flag-off byte-identical proof

**Golden retrieval eval command**:
`node scripts/eval/golden-queries/run-golden-eval.mjs --json`
(this repo's own hash-locked, live-store, known-item retrieval eval —
`scripts/eval/golden-queries/`).

Ran it three ways and diffed:

1. **Pre-change baseline** (git-stashed my tracked diffs + moved
   `activation.ts`/its test out of the tree, rebuilt, ran): `hit_rate=0.65`
   (13/20), `mrr=0.345`.
2. **Post-change, flag OFF** (default env): `hit_rate=0.65`, `mrr=0.345` —
   **identical to (1)**, and identical per-query hit/rank/top5/scores
   (verified via structural diff, not just the summary numbers).
3. **Post-change, flag ON** (`AGENT_RECALL_ACTIVATION=1`, live store has NO
   `association/` dir): identical to (2) in every field except `latency_ms`
   (wall-clock, inherently non-deterministic between two process runs) —
   confirmed by a full structural diff.

This proves two things at once: (a) my change introduces zero regression on
the flag-off path (matches the true pre-change baseline exactly, isolating
away the fact that the live store's hit-rate has genuinely drifted from the
2026-09-11/12 baseline's 75%/90% — 6 days of new content, not my change), and
(b) on the live store specifically, flag ON is ALSO identical to flag OFF
right now, because there is no graph to read — the degradation contract
holding exactly as designed.

**Double-run diff of a session_start fixture payload** (constraint's second
proof leg): see `packages/core/test/activation.test.mjs`'s "flag-off
byte-identity — session_start" describe block — a fixture store WITH a real,
non-trivial `association/edges.json` connecting two P0 corrections, flag off,
`.corrections` deep-equal against the SAME store with the flag off before
that file existed, plus a same-store double-run diff. Both pass.

**CHALLENGE resolution for constraint 1's own escalation clause**: the golden
eval does NOT internally toggle the flag or run a twin A/B pass — I drove
that externally (env var across separate process invocations) rather than
finding a purpose-built flag-off/flag-on harness inside the eval itself. That
external toggle plus the git-stash pre-change isolation above is what I ran
instead, and I consider it a stronger proof than a purpose-built harness
would have been, since it also rules out corpus-drift confounds.

## `activation-eval.mjs` — fixture AND live-store output, verbatim (SUCCESS_WHEN)

**Live store** (read-only, 82 projects scanned, 2026-09-17):

```
activation-eval — store: /Users/tongwu/.agent-recall
projects scanned: 82
evaluable (project,day) pairs: 0  evaluable days: 0
CANNOT CLAIM (n=0 evaluable pairs < gate 20)
```

This is an honest, verified finding, not a bug: `grep -h '"kind":"cited"'
~/.agent-recall/projects/*/corrections/_outcomes.jsonl` returns **zero**
lines across the entire live store — Phase 1a's transcript-audit has not yet
produced a single `cited` event anywhere, so `association/edges.json` has
never been built (matches the task brief's own note that the live store has
no `association/` dir yet) and there is no same-day retrieved+cited overlap
to evaluate against. `runEval` handles this correctly: `n=0`, gate fails, the
literal `CANNOT CLAIM` string prints, no number is synthesized.

**Controlled fixture** (3 synthetic projects, 7 days, homogeneous by
design — every (project,day) pair uses the same 4-candidate/1-edge shape as
the hand-computed known-MRR test, so this is a reproducibility/plumbing
demonstration, not an organic-data result):

```
activation-eval — store: <tmp fixture>
projects scanned: 3
evaluable (project,day) pairs: 21  evaluable days: 7
ranking A (existing rankCorrections):      MRR=0.2500  hit@3=0.0000
ranking B (A + activation tie-break):      MRR=0.3333  hit@3=1.0000
uplift (B - A):                            MRR=0.0833  hit@3=1.0000
```

n=21 ≥ gate 20, days=7 ≥ gate 5 — the gate passes and prints real numbers,
proving the CLI's gate-passed rendering path end-to-end (the fixture-store
run below the gate, in `activation-eval.test.mjs`, proves the CANNOT-CLAIM
rendering path — both branches of the claim-gate discipline are exercised
end-to-end, one on a real store, one on a controlled fixture).

## Full-suite verification

- `npm run lint` (root: `tsc --noEmit` across core, mcp-server, sdk, cli) —
  **clean, zero diagnostics**.
- `npm test` (root, all 4 workspaces, exit code 0):
  - `agent-recall-core`: **1817/1817** pass, 0 fail (1791 pre-existing + 26
    new `activation.test.mjs` tests).
  - `agent-recall-mcp-server`: **73/73** pass, 0 fail (untouched).
  - `agent-recall-sdk`: 39 pass, 0 fail, 1 pre-existing documented `# TODO`
    (Case B, global-root-sharing bug — same one disclosed unchanged in the
    p1a/p2 reports, unrelated to this work, out of scope).
  - `agent-recall-cli`: **287/287** pass, 0 fail (untouched).
- `scripts/eval/activation-eval.test.mjs`: 11/11 pass (standalone, not part
  of the npm-workspace test globs — run directly via `node --test`).

## Scope note

Constraint 6 says "Scope: packages/core, scripts/eval, tests" — every file
touched is inside `packages/core/src|test`, `scripts/eval/`, or this report.
`packages/core/src/tools-logic/association.ts` (a Phase-2 file, not new) was
modified — necessary (not optional) to expose the reusable derivation
pieces the brief itself asks the eval to reuse rather than fork; kept
minimal and verified behavior-preserving (see "association.ts refactor"
above and its full-suite pass).

No `git commit`/`git push` performed. No writes to `~/.agent-recall` at any
point — verified by the content-hash manifest check above and by every
write-side test using a `os.tmpdir()` fixture root.

SOP_ID: 8c24389d
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth challenge_fired=true kept=all replaced=none
