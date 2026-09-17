# Evolution p1b (w1b) — `ar corrections harvest-implicit`

Branch: `evolution-p0-p4` (verified at start). Scope honored: `packages/core`, `packages/cli`, tests (+ one required registry-manifest fix in `packages/mcp-server/test/fence-manifest.mjs`, see below).

## What shipped

1. **`packages/core/src/tools-logic/implicit-harvest.ts`** (new) — `runImplicitHarvest()`. High-precision, low-recall miner over USER turns for three conservative signals:
   - **(a) negation opener** — `/^(no[,.\s]|不对|不是|错了|not that|that's (wrong|not)|我说的是|i said|停|别这样)/i` at the start of a turn, remainder ≥4 words **and** carrying a minimal verb (see precision fix below) → rule = remainder.
   - **(b) again-marker** — `/(again|还是|仍然|第二次|怎么又)/i` anywhere in the turn **and** a minimal imperative-ish verb also present → rule = the sentence carrying the verb.
   - **(c) repeat-instruction** — two ≥6-word turns in one session, token-Jaccard ≥0.6 → rule = the **second** occurrence.
   - Per-turn signal priority (negation > again > repeat) so one turn never mints two overlapping candidates.
   - Cap 5 candidates/session (over-cap ones reported `"capped"`, never gate-checked or written).
   - Candidates pass through `dropHardNoise` only (see CHALLENGE below), rejects logged to `_rejected.jsonl` reason `"implicit-gate"`.
   - Storage exclusively via the canonical `writeCorrection()` path — zero hand-rolled file writes — so on-write consolidation, atomic write, and index regen are shared with every other producer.
   - Every written record: `severity:"p1"` (hard-floored, literally never derived — `writeCorrection` only calls `detectSeverity` when `correction.severity` is omitted), `kind:"correction"`, `weight:0.3`, `confidence:"low"`, `provenance:{source:"transcript-implicit", mode:"observed"}`, `tags:["implicit"]`.

2. **`packages/core/src/storage/corrections.ts`** — minimal additive seam: `writeCorrection(project, correction, opts?: { skipActionableGate?: boolean })`. See CHALLENGE section — this was necessary, not optional.

3. **`packages/core/src/tools-logic/transcript-audit.ts`** — exported `scanTranscripts`, `ScannedTranscript`, `resolveDayRange` (previously module-private) so p1b reuses p1a's day-bucketed/project-resolved walker verbatim. Zero logic changes to p1a.

4. **`packages/core/src/index.ts`** — re-exports the above + `runImplicitHarvest` and its types + `WriteCorrectionOptions`.

5. **`packages/cli/src/index.ts`** — new `case "harvest-implicit":` inside the existing `case "corrections":` switch, following the `ar outcomes audit` idiom exactly (same flag validation ladder, same `--json`/text dual-mode, same fenced-vs-unfenced split).

6. **`packages/mcp-server/test/fence-manifest.mjs`** — added the required `{channel:"cli_subaction", id:"corrections.harvest-implicit", status:"fenced", ...}` entry. This is the P1-fence completeness registry (TOW2-388) that the full `npm test` enforces across the whole repo — any new CLI subaction with no entry is a hard build failure; not optional, not something I could skip to stay "in scope."

## Phase 1a machinery reused (not forked)

`scanTranscripts` (day-bucketed line scan + F1 `resolveSessionProject` per file + mtime-fallback ambiguity) and `resolveDayRange` (`--date` XOR `--backfill --since/--until`) are used **unmodified**. The only new extraction code is `extractUserTurnsWithContext()`, which is a *different shape* over the same day-bucketed lines (ordered user/assistant turn pairing instead of one concatenated blob) — required because signal (a)/(b) need the immediately-preceding assistant sentence and signal (c) needs discrete, ordered messages to pair; `extractDayText`'s single flattened string can supply neither. It reuses the exact same exported per-record filters (`isBoilerplateRecord`/`isSystemText`/`textFromContent`) `extractDayText` itself uses internally — same filtering semantics, different aggregation.

No coupling to p1a's outcomes-specific assumptions was found — `scanTranscripts` was already generic (it doesn't know what corrections/outcomes are); no generalization was needed beyond adding `export`.

## CHALLENGE fired: the write-path gate had no seam

Per the brief: *"Candidates MUST pass the existing hard noise gates ... but SKIP the imperative-shape requirement."* `writeCorrection()`'s only gate was `isLikelyRealCorrection` — hard-noise gates **fused** with the actionable-imperative-shape scan **and** the soft-acknowledgment gate, with no way to run just the hard-noise floor.

Worse than "no seam" — running the **full** gate on implicit candidates would have actively broken the miner's core use case. Verified by fixture: `"No, that's wrong. Use the blue button instead of the red one."` matches the ack pattern's own `no[,.]?\s*(that's\s+wrong[.!]?)?[\s\S]{0,80}$` when the re-instruction is short, because the actionable-scan rescue that normally saves it is exactly what "skip the imperative-shape requirement" disables. This is the Loop-7 failure, replayed from the opposite side.

Two options considered and rejected:
- **Fork a parallel write path** — rejected: violates "storage via the canonical write path," loses on-write consolidation/atomic-write/index-regen for free.
- **Refactor `isLikelyRealCorrection`'s internals** — rejected: it's a precision-tuned, heavily regression-tested (Loop 7/8/14, S-M2/S-M3) unit; splitting it risks those regressions for a one-off caller.

**Minimal seam applied**: `WriteCorrectionOptions.skipActionableGate?: boolean` (3rd, optional parameter). When true, the gate run is `dropHardNoise` alone — same exported, unchanged function every other producer's hard floor uses. Every existing call site (~150 across the test suite + `check.ts`) omits the option and gets byte-identical behavior; verified by the full green suite below.

## Own bugs found and fixed before shipping (real RED→GREEN, not hypothetical)

1. **Ack false-positive** (found via manual fixture probing before the persisted test suite was written): `"no, that's not what I meant"` — corrections.ts's own canonical soft-ack fixture (`rejected-log.test.mjs`) — was captured by signal (a) because "≥4 more words" alone doesn't require the remainder to carry any actual instruction. Fixed by requiring the remainder to also match the minimal-verb list signal (b) already uses ("re-instruction" implies an instruction). Regression test: `implicit-harvest.test.mjs` → *"RED→GREEN regression: pure acknowledgment ... does NOT fire"*.

2. **Id-collision data-integrity bug**: initial `buildId()` hashed the rule text, so two independent candidates that normalized to the same rule on the same day computed the *same* id. `writeCorrection`'s consolidation loop explicitly skips `existing.id === record.id` ("never merge into self"), so the second write fell through to the brand-new-record branch, collided on filename, and got hash-disambiguated into a **second file sharing the first file's id** — verified directly (2 files, both `written:true,merged:false`, identical `id` on disk). Fixed: id is now `crypto.randomBytes(6)`-derived (unique per write attempt); rule-text consolidation (id-independent) is the only dedup mechanism relied on. Covered by the "on-write consolidation" test.

## Watch-tier isolation (hard contract, item 6) — verified, not assumed

One test (`implicit-harvest.test.mjs` → *"watch-tier isolation (hard contract)"*) plants an implicit record whose mined text ("You must always use the staging environment first") is exactly the kind of language `detectSeverity` would classify p0, then asserts:
- `readP0Corrections(project)` — the literal function `session_start` uses for its P0 section — returns `[]`.
- `getCorrectionKPIs(project)`'s `retrieved`/`heeded`/`recurred`/`precision` are byte-identical before vs. after the write (seeded against a pre-existing ordinary correction with real KPI history).
- `_outcomes.jsonl` (the ledger `heed-tiers.ts` reads) does not exist after the write — `harvest-implicit` never calls `recordOutcome`.

This holds **by construction**, not luck: `rankCorrections`/`getCorrectionKPIs`/`heed-tiers.ts` read only `severity`/`weight`/`proof_confidence`/recency/`proof_count`/outcome-ledger events — never `provenance.source` — confirmed by reading their implementations, not inferred.

## Evidence — RED before / GREEN after, full suites, lint

```
$ node --test packages/core/test/implicit-harvest.test.mjs
ℹ tests 22   ℹ pass 22   ℹ fail 0

$ node --test packages/cli/test/harvest-implicit.test.mjs
ℹ tests 9    ℹ pass 9    ℹ fail 0

$ npm run lint   # tsc --noEmit across core/mcp-server/sdk/cli
(clean, no output)

$ npm test       # full monorepo — core, mcp-server, sdk, cli
core:       1742 tests, 1742 pass, 0 fail
mcp-server:   73 tests,   73 pass, 0 fail   (fence-completeness — required the manifest entry above)
sdk:          40 tests,   39 pass, 0 fail, 1 pre-existing documented TODO (unrelated SDK global-root leak, dated before this task)
cli:         274 tests,  274 pass, 0 fail
```

Manual fixture RED→GREEN (before the persisted suite existed): the ack false-positive above was caught by running `runImplicitHarvest` against a hand-built fixture claude-dir, observing the wrong candidate, then fixing the negation-opener condition and re-running to confirm it disappeared while the intended positive fixtures still fired. The id-collision bug was caught the same way (two-session same-rule fixture → 2 files instead of 1 → fixed → 1 file).

SUCCESS_WHEN check: `ar corrections harvest-implicit --date <day> --dry-run` — CLI test *"dry-run is the DEFAULT ... and prints a correct candidate table, writing nothing"* runs exactly this against a fixture claude-dir and asserts the table row, the fenced candidate list, and zero disk writes.

## Environment note (not my scope, flagging for the orchestrator)

`scripts/eval/evolution-baseline.mjs` and `.test.mjs` show as modified in `git status` with an mtime *before* my own first file write — this repo is a shared, non-worktree checkout, so it's very likely another concurrent evolution worker's uncommitted changes coexisting in the same tree, not mine. I did not touch, read into, or rely on those files (out of my stated scope). Flagging so the orchestrator's commit step stages paths explicitly rather than `git add -A`.

## Files changed

- `packages/core/src/tools-logic/implicit-harvest.ts` (new)
- `packages/core/test/implicit-harvest.test.mjs` (new, 22 tests)
- `packages/cli/test/harvest-implicit.test.mjs` (new, 9 tests)
- `packages/core/src/storage/corrections.ts` (writeCorrection seam)
- `packages/core/src/tools-logic/transcript-audit.ts` (export 3 already-existing helpers)
- `packages/core/src/index.ts` (new exports)
- `packages/cli/src/index.ts` (new `harvest-implicit` subcommand)
- `packages/mcp-server/test/fence-manifest.mjs` (required registry entry)

## Fix round

Blocking review issues fixed against the real 14-day precision sample (2 CRITICAL, 1 HIGH, 1 MEDIUM). All four scoped to `packages/core/src/tools-logic/implicit-harvest.ts`; no changes to shared p1a modules (`transcript-project.ts`, `transcript-audit.ts`) — the fixes are local to this module's own turn-extraction/signal-detection code, not a reopening of already-merged p1a scope.

1. **CRITICAL — image-attachment placeholder noise (69.2% of all real would_write candidates).** Claude Code auto-injects a caption-only text block for every pasted/attached image (`"[Image: source: /Users/.../image-cache/<sid>/<n>.png]"`, `"[Image: original WxH, displayed at WxH...]"`). Two of these differing only by filename/number cleared signal (c)'s Jaccard≥0.6 gate on boilerplate alone. Fix: `stripImageAttachmentNoise()` strips both placeholder shapes (and the distinct `"[Image #N]"` reference-marker decoration that can prefix real typed text) from every user turn AND every assistant context-piece *before* any signal test runs; a turn that becomes empty after stripping is never pushed into `turns` at all — it can no longer contribute a single character to any candidate.

2. **CRITICAL — compaction/continuation summary mined as a live user turn.** Claude Code injects `"This session is being continued from a previous conversation..."` recap text as a `role:"user"` record whenever a session compacts — assistant-authored recap, not something the human typed, but a magnet for all three signal types because a good summary restates prior corrections in rule-like phrasing. Verified the record carries a structural, zero-false-positive flag: `isCompactSummary: true` (confirmed directly against real transcripts on this machine). Fix: `extractUserTurnsWithContext` now skips any record with `isCompactSummary === true` before type-branching, so it can never become a `UserTurn` or contribute to `precedingAssistant` context.

3. **HIGH — negation-opener / again-marker verb match had no proximity requirement to the trigger.** Both signal (a) (`MINIMAL_VERB` tested against the whole up-to-200-char remainder) and signal (b) (`AGAIN_MARKER`/`MINIMAL_VERB` tested independently anywhere in the whole turn) let a coincidental verb in an unrelated later clause qualify. Reproduced the review's exact example: `"No need to revoke. This is not a dangerous action because it's useless for the people who use these npm access tokens..."` fired purely because "use" appears in an unrelated clause about *other people*.
   - Fix (a): added `stripChainedAckOpeners()` — `that's (wrong|not)` etc. are themselves acknowledgment-only alternatives of `NEGATION_OPENER`; when chained right after the primary match (`"No, that's wrong. <instruction>"`) they're stripped before the verb test. The verb must then be present in the *first sentence* of what remains, not scanned across arbitrary later sentences. The existing `"No, that's wrong. Use the blue button..."` fixture still fires (regression-pinned); the npm-token false positive no longer does.
   - Fix (b): the again-marker sentence and the verb must now co-occur in the **same** `splitSentences()`-delimited sentence (`sentences.find(s => MINIMAL_VERB.test(s) && AGAIN_MARKER.test(s))`), not merely appear anywhere in the same turn.

4. **MEDIUM — signal (c) had no content-shape gate at all.** Fired on any two similar ≥6-word turns regardless of whether the content was a correction, question, or discussion restatement — reproduced the review's example (the same open-ended design question, "what would be success for cross-project long-term memory...", asked twice). Fix: a repeat candidate whose (second-occurrence) text ends in `?`/`？` is never captured — a repeated *correction* is essentially never phrased as a question; a repeated open question almost always is. Conservative, precision-first, per the brief's own "when in doubt, drop." The existing non-question "make sure the dashboard loads..." repeat fixture still fires (regression-pinned).

### Evidence — RED before / GREEN after each finding, then full suites + lint

Reproduced each of the 4 findings as a standalone fixture against the pre-fix build first (RED — all 4 produced the exact false-positive candidate class described), then re-ran the identical fixtures post-fix (GREEN — zero candidates in all 4 cases):

```
# RED (pre-fix build) — image placeholder + negation unrelated-clause + repeat-question all fire:
[
  { "session": "s-image",    "signal": "repeat",   "rule": "[Image: source: .../4.png]",                 "outcome": "would_write" },
  { "session": "s-negation", "signal": "negation",  "rule": "need to revoke. ... people who use these npm access tokens...", "outcome": "would_write" },
  { "session": "s-repeatq",  "signal": "repeat",   "rule": "What would be considered success for cross-project...",          "outcome": "would_write" }
]
# RED (pre-fix build) — compaction-summary fires as "again":
{ "signal": "again", "rule": "Use strict natural calendar months again, always use them consistently.", "outcome": "would_write" }

# GREEN (post-fix build) — same 4 fixtures:
[]                          # image + negation + repeat-question fixtures combined
{ "candidates": [] }        # compaction-summary fixture
```

Persisted regression tests added to `packages/core/test/implicit-harvest.test.mjs` (14 new tests across 5 new `describe` blocks: image-placeholder noise ×3, compaction-summary exclusion ×2, negation-opener proximity ×2, again-marker same-sentence ×2, repeat-question exclusion ×2 — each paired with a "regression pin" test proving the original positive fixtures from the shipped suite still fire).

```
$ node --test packages/core/test/implicit-harvest.test.mjs
ℹ tests 33   ℹ pass 33   ℹ fail 0   (19 original + 14 new)

$ npm test -w packages/core
ℹ tests 1753  ℹ pass 1753  ℹ fail 0

$ npm test -w packages/cli
ℹ tests 274   ℹ pass 274   ℹ fail 0

$ npm run lint   # tsc --noEmit across core/mcp-server/sdk/cli
(clean, no output)
```

No writes to `~/.agent-recall` (fixtures only, via `AGENT_RECALL_ROOT` override, same as the shipped suite). No git commit/push. Files touched: `packages/core/src/tools-logic/implicit-harvest.ts`, `packages/core/test/implicit-harvest.test.mjs` — both already new/untracked from the original worker pass, no other file touched.

SOP_ID: 2f01eb10
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth challenge_fired=true kept=reuse-p1a-walker,canonical-write-path,hard-floor-severity replaced=none

## Fix round 2

Precision-fix round 2, against the SAME real 14-day window (`--backfill --since 2026-09-03 --until 2026-09-17`, dry-run only, `~/.claude/projects/-Users-tongwu`). Fix round 1's shipped config measured **28% precision** on this window — below the 60% floor. Four confirmed residual junk families, all fixed in `packages/core/src/tools-logic/implicit-harvest.ts`; no changes to shared p1a modules. Zero writes to `~/.agent-recall` at any point (marker-probed: correction-file count — 155 — and total `_rejected.jsonl` line count — 82 — verified byte-identical before vs. after every harvest run in this round, including the two final precision-measurement runs).

### 1. Injected-block records mined as human speech (52% of round-1 candidates)

Read-only grep of every `~/.claude/projects/*/*.jsonl` on this machine (real transcripts, not fixtures) enumerated every leading-tag family a `role:"user"` record actually carries here:

| Tag | Occurrences (all projects) | Already excluded pre-round-2? |
|---|---|---|
| `<task-notification` | 707 | **No — the gap** |
| `<local-command-caveat` | 45 | Yes (`SYSTEM_PREFIXES` `/^<local-command/`) |
| `<command-name` | 45 | Yes |
| `<local-command-stdout` | 43 | Yes (same `/^<local-command/` prefix) |
| `<command-message` | 21 | Yes |
| `<system-reminder` | 6 | Yes |
| `<script` (1), `<instructions` (1) | 2 | N/A — verified these are real HUMAN-PASTED content (a PostHog snippet, a user-authored prompt template), not Claude-Code injection; correctly left eligible |

Also found: `isMeta:true` on 401 user records (30 already tag-caught; 371 not) — sampled 15 non-empty, non-image ones directly: all were either `<local-command-caveat>` (belt-and-suspenders, already tag-caught) or genuine skill-injection replay (e.g. a slash command's own markdown body, `"# /arsave — AgentRecall Save\n\n..."`, or the harness's `"[Your previous response had no visible output...]"` continuation nudge) — zero were human-typed.

**Fix**: `INJECTED_BLOCK_TAG_RE = /^(<task-notification\b|<agent-message)/i` skips any user record whose text opens with the tag, checked on raw (pre-strip) text. `<agent-message` was added too — not found in this machine's sample, but this exact codebase (`packages/cli/src/index.ts`'s hook-ambient/hook-correction `HARNESS_PREFIXES`) already treats it as a member of the identical harness-artifact class in a sibling module solving the same problem; core cannot import cli's constant (wrong dependency direction), so the *class* is covered here independently. Separately, `rec.isMeta === true` now skips the record entirely before any text extraction. Both checks land in `extractUserTurnsWithContext`, same altitude as the existing `isCompactSummary`/`isSystemText` skips.

### 2. AGAIN_MARKER — no word boundaries, and 还是 is not a recurrence marker

`/(again|还是|仍然|第二次|怎么又)/i` → `/\bagain\b|仍然|第二次|怎么又/i`. Fixes: (a) `\bagain\b` so "against" (containing "again" as a bare substring) never matches; (b) `还是` (overwhelmingly "still/rather" in real usage, e.g. "我还是觉得...比较好" — a preference restatement, not a recurrence report) dropped entirely, per the brief's explicit instruction. `仍然`/`第二次`/`怎么又` unchanged — they already only ever fire with a `MINIMAL_VERB` co-occurring in the *same sentence* (round 1's own same-sentence fix), so "only with an imperative in the SAME sentence" already held structurally for them.

### 3. `stripImageAttachmentNoise` destroyed newlines, defeating the same-sentence proximity gate

`.replace(/\s+/g, " ")` (last step) flattened every newline to a space — collapsing what were originally separate lines (a normal multi-line turn shape, no terminal punctuation between lines) into one run-on string. `splitSentences()` treats a bare newline as an *unconditional* sentence boundary (its own prior S-M2 fix) — so destroying it here silently let an unrelated verb on line 2 satisfy the "same sentence as the marker on line 1" proximity gate added in round 1. Fixed: collapse only horizontal whitespace (`[^\S\n]+`) per line, `join("\n")` back — newlines are never flattened.

### 4. Question exclusion only checked signal (c), only at the string's literal end

The only question gate was `/[?？]\s*$/.test(second.text.trim())` — signal (c)-only, and defeated by (a) signals (a)/(b) having no question check at all, and (b) any question not the raw turn's own last character (embedded earlier, or followed by trailing decoration like `"? -- just confirming"`). Fixed: shared `containsQuestionSentence(text)` (`splitSentences(text).some(s => /[?？]/.test(s))`) applied to the CANDIDATE RULE TEXT of all three signals — the remainder (a), the verb-bearing sentence (b), the full turn (c) — per the brief's "when in doubt, drop".

### RED→GREEN, every finding, real-shaped fixtures

Each of the 4 fixes was reverted one at a time in the shipped source (not the test file) and re-run to confirm the paired test(s) actually fail without the fix (not vacuously passing) — then restored and confirmed green:

```
Fix 1 (task-notification, real <summary> line, NOT a ^-anchored negation opener — that shape was
       never actually at risk, so the fixture uses the shape that WAS): RED (fired) → GREEN (0 candidates)
Fix 1 (isMeta:true skill-injection replay, same again+verb shape):       RED (fired) → GREEN (0 candidates)
Fix 2 ('against' + 'still/但是我还是觉得' fixtures):                      RED (2 fired) → GREEN (0 candidates)
Fix 3 (marker line 1 / unrelated verb line 2, no terminal punctuation):  RED (fired) → GREEN (0 candidates)
Fix 4 (signal a/b/c question-anywhere fixtures, 3 cases):                RED (3 fired) → GREEN (0 candidates)
```

14 new regression tests added to `packages/core/test/implicit-harvest.test.mjs` (each paired with a regression-pin test proving the original positive fixtures — including round 1's own — still fire).

```
$ node --test packages/core/test/implicit-harvest.test.mjs
ℹ tests 48   ℹ pass 48   ℹ fail 0   (33 pre-round-2 + 15 new; see note below on the -1/+16 net from the family drop)

$ npm test -w packages/core
ℹ tests 1768  ℹ pass 1768  ℹ fail 0

$ npm test -w packages/cli
ℹ tests 275   ℹ pass 275   ℹ fail 0

$ npm test        # full monorepo
core: 1768 pass 0 fail · mcp-server: 73 pass 0 fail · sdk: 40 tests, 39 pass 0 fail (1 pre-existing documented TODO, unrelated) · cli: 275 pass 0 fail

$ npm run lint
(clean, no output)
```

### Own precision measurement on the real window — and the family drop it triggered

Ran `runImplicitHarvest({ since: "2026-09-03", until: "2026-09-17", write: false })` (equivalent to `ar corrections harvest-implicit --backfill --since 2026-09-03 --until 2026-09-17`, dry-run — never `--write`), against the real `~/.claude/projects/-Users-tongwu`. With fixes 1–4 applied but signal (c) still active (`experimentalSignals: true`), the raw universe collapsed from round 1's volume to **4 total candidates, 0 gated, 0 capped** — the injected-block fix alone eliminated the dominant junk family. Pulled every candidate's full source turns from the transcript (not just the truncated `rule`/`context` fields) and judged each myself:

| # | Date | Signal | Rule (truncated) | My judgment | Why |
|---|---|---|---|---|---|
| 1 | 2026-09-03 | repeat | "[REDACTED — colleague-addressed weekly-report dictation, zh]" | **FALSE POSITIVE** | Verified against full source: this is the user *dictating Notion weekly-report prose* (addressed to a colleague, not the assistant) — the same paragraph reappears because they're iteratively building up a report turn-by-turn, not because a correction was ignored. Jaccard≥0.6 can't tell "resent correction" apart from "redrafted document paragraph". |
| 2 | 2026-09-11 | repeat | "[REDACTED — domain revenue-formula correction, zh, opens with an emphatic doubled 'wrong' negation]" | TRUE POSITIVE (borderline — a domain-fact correction, not a behavioral rule, but the exact-duplicate-resend-3-minutes-apart shape is precisely what signal (c) was designed to catch) | Verified: the identical ~500-char message appears twice, 3 minutes apart, opening with an emphatic doubled "wrong" negation — a genuine correction to a revenue-formula the assistant had gotten wrong. |
| 3 | 2026-09-11 | repeat | "[REDACTED — duplicated pasted terminal fragment containing colleague names]" | **FALSE POSITIVE** | Verified: opens with `❯`, a shell-prompt glyph, preceded by a horizontal-rule line in the source — a duplicated pasted/echoed terminal fragment, not coherent correction speech. |
| 4 | 2026-09-17 | negation | "[REDACTED — explicit business-scope negation correction, en]" | TRUE POSITIVE | Verified against the preceding assistant turn: the assistant had just delivered an analysis that included an out-of-scope revenue stream; this is an explicit, unambiguous scope correction. |

**+experimental (a+b+c): 2/4 = 50%** — below the 60% floor. Own-judgment root cause: 2 of 3 signal-(c) hits are false positives from two *structural* mechanisms (iterative document dictation; pasted-terminal-artifact duplication) that are properties of the signal's own design (pure Jaccard similarity over raw turns, with no notion of "is this addressed to the assistant" or "is this coherent human prose"), not artifacts of this one sample.

Per the brief's pre-authorized policy, **dropped signal (c) repeat-instruction from the shipped default**, behind an explicit `experimentalSignals` option (core) / `--experimental-signals` flag (CLI) — trivial to keep, not deleted, because candidate 2 shows the mechanism does have a real, narrower use case (an exact-duplicate resend genuinely can be an ignored correction).

**DEFAULT (a+b only), re-measured after the drop: 1/1 = 100%** (candidate 4, the business-scope correction — clears the 70% target, well above the 60% floor). Honesty check on this number: **n=1** — this is a genuinely thin sample, a property of the fixes' own success (round 1's junk families accounted for the overwhelming majority of prior volume, and this user's default-`claudeDir` window happens to be light on `negation`/`again` shapes). I'm not overstating confidence from a single data point; I'm reporting what the real window actually contained, and defending the *default* decision on the structural grounds above (signal (a)'s remaining hit is unambiguous; signal (b) had zero hits in-window either before or after the fixes, so its precision is separately unmeasured here but structurally tightened by fixes 2–4 and not implicated by anything found in this sample — no reason to drop it).

Zero-write marker-probe (both the `experimentalSignals:true` and default runs): correction-file count under `~/.agent-recall` (155) and total `_rejected.jsonl` line count (82) identical before and after every run in this round.

### Shipped default config

- Signals: **(a) negation-opener, (b) again-marker+verb** — ON by default.
- Signal **(c) repeat-instruction — OFF by default**, opt-in via `experimentalSignals: true` (core) / `ar corrections harvest-implicit ... --experimental-signals` (CLI).
- All round-1 fixes retained (image-noise strip, compaction-summary exclusion, negation/again proximity, per-turn signal priority, 5/session cap, hard-noise-only gate, hard-floored p1/weight-0.3/low-confidence/`transcript-implicit` provenance).
- New in round 2: `<task-notification>`/`<agent-message` tag skip + `isMeta:true` skip (turn extraction); `\bagain\b` + 还是-dropped `AGAIN_MARKER`; newline-preserving `stripImageAttachmentNoise`; shared per-sentence `containsQuestionSentence` applied to all three signals' own candidate-rule text (only (a)/(b) reachable by default).

### Files changed (round 2)

- `packages/core/src/tools-logic/implicit-harvest.ts` — the 4 fixes + `experimentalSignals` option + signal (c) gating.
- `packages/core/test/implicit-harvest.test.mjs` — 15 new tests (4 junk-family fixes ×2–3 each + the signal-(c)-off-by-default test), 4 pre-existing signal-(c) tests updated to pass `experimentalSignals: true` so they keep testing their own mechanism instead of passing vacuously.
- `packages/cli/src/index.ts` — `--experimental-signals` flag wired through (usage strings updated in both the sub-command usage and the unknown-subcommand help).
- `packages/cli/test/harvest-implicit.test.mjs` — 1 new test (`--experimental-signals` recovers signal (c)); 1 existing test's expected table row updated (2 sessions now fixture-seeded, not 1) plus a fixture session added.
- This report.

No commit, no push, no `--write` against `~/.agent-recall` at any point in this round.

FEEDBACK_HINTS: outcome=success edited=clean escalated=none challenge_fired=false kept=canonical-gate-reuse,hard-floor-severity dropped=repeat-instruction-from-default(experimental-signals-flag)

## Fix round 3

Orchestrator decision, data-driven, judge-confirmed — over a SEPARATE, longer real window (**48 days**), signal (b) again-marker (kept ON by default since round 2) contributed **0 true positives and 2 false positives**. Both false positives trace to ONE structural mechanism, not sample noise: **voice-dictation run-on monologues** where "again" is an ordinary temporal adverb ("we talked about this again last week...") rather than a recurrence-of-mistake report, co-occurring in the same turn with an unrelated `MINIMAL_VERB` match elsewhere in the monologue. The owner is a heavy voice-dictation user, so this input shape is structural to their usage, not incidental to this one window. The only genuine true positive across the SAME window came from signal (a) negation-opener (the round-2 business-scope-correction hit's own family, reconfirmed).

**Why round 1's "same sentence" proximity fix does not rescue this**: `splitSentences()` treats `.`/`!`/`?` (followed by whitespace) and newlines/CJK terminators as the only boundaries — a genuine dictation run-on with none of those IS, by that contract, exactly ONE sentence for the whole turn. "Marker and verb co-occur in the same sentence" therefore degrades to "marker and verb co-occur anywhere in the turn" for precisely the population that broke this signal — the same failure shape round 2 already fixed for signal (c) (iterative-dictation false positives), now confirmed for signal (b) too. No further regex tightening can distinguish "again" (recurrence-of-mistake) from "again" (temporal adverb) lexically — this is a sense-ambiguity, not a pattern-coverage gap.

**Decision** (per the same "drop the family, don't re-patch the regex a fourth time" policy already applied to signal (c) in round 2): DEFAULT is now **signal (a) negation-opener ONLY**. Signal (b) again-marker moves behind the SAME `experimentalSignals` opt-in as signal (c) — not deleted, not regex-patched again. `AGAIN_MARKER`/`MINIMAL_VERB` and the same-sentence proximity check are all unchanged; only the default-reachability gate moved (`packages/core/src/tools-logic/implicit-harvest.ts`'s `detectSignalsInSession`, signal (b) loop now wrapped in `if (experimentalSignals)`, mirroring signal (c)'s existing `eligible` gate immediately below it).

### Shipped default config (round 3)

- Signal **(a) negation-opener — ON by default.** The only signal reachable without `--experimental-signals`.
- Signal **(b) again-marker+verb — OFF by default** (moved this round; 0 TP / 2 FP over the 48-day window, voice-dictation temporal-adverb mechanism).
- Signal **(c) repeat-instruction — OFF by default** (unchanged from round 2).
- `--experimental-signals` (CLI) / `experimentalSignals: true` (core) now opts into BOTH (b) and (c) together — one flag, same name, no new flag surface.
- All round 1/round 2 fixes retained unmodified: image-noise strip (newline-preserving), compaction-summary exclusion, `<task-notification>`/`<agent-message`/`isMeta` skip, negation/again same-sentence proximity, `\bagain\b` + 还是-dropped `AGAIN_MARKER`, per-sentence `containsQuestionSentence` on all three signals, per-turn signal priority (negation > again > repeat), 5/session cap, hard-noise-only gate, hard-floored p1/weight-0.3/low-confidence/`transcript-implicit` provenance.

### Tests updated

`packages/core/test/implicit-harvest.test.mjs` — every signal-(b) fixture across the file's existing describe blocks (`signal (b): again-marker + verb`, `fix round: again-marker and verb must co-occur in the SAME sentence`, `fix round 2: <task-notification>...`, `fix round 2: isMeta:true...`, `fix round 2: AGAIN_MARKER word boundaries + 还是 dropped`, `fix round 2: image-noise stripping...`, `fix round 2: per-sentence question exclusion...`) now passes `experimentalSignals: true` explicitly, so each keeps testing its OWN mechanism (tag-skip, same-sentence proximity, word-boundary/还是-drop, newline-preservation, question-exclusion) rather than passing vacuously off the new default-off gate. The `signal (b)` describe block gained an explicit "is OFF by default" test (mirrors signal (c)'s own round-2 pattern) plus a new regression test, crafted from the judge's real 48-day-window false-positive shape:

> a single unpunctuated run-on turn — `"...we talked about this again last week when I was going through the onboarding flow and separately I think we should use a different color for the button on the settings page..."` — asserts (1) **zero** candidates by default (no `experimentalSignals`), and (2) exactly one `again`-signal candidate WITH `experimentalSignals: true` (non-vacuous proof that the default-off result is the fix-round-3 gate firing, not an unrelated miss on word count / hard-noise / marker-verb matching).

`packages/cli/src/index.ts` — usage/help text updated (sub-command usage line + unknown-subcommand help) to state the default is signal (a) only and that `--experimental-signals` now recovers BOTH (b) and (c). No CLI test changes were needed: `packages/cli/test/harvest-implicit.test.mjs`'s fixtures only ever exercised signals (a)/(c), never (b).

### Evidence — full suites, lint, zero-write marker-probe

```
$ node --test packages/core/test/implicit-harvest.test.mjs
ℹ tests 50   ℹ pass 50   ℹ fail 0   (48 pre-round-3 + 2 new: default-off + dictation-monologue regression)

$ node --test packages/cli/test/harvest-implicit.test.mjs
ℹ tests 10   ℹ pass 10   ℹ fail 0

$ npm test -w packages/core
ℹ tests 1770  ℹ pass 1770  ℹ fail 0

$ npm test -w packages/cli
ℹ tests 275   ℹ pass 275   ℹ fail 0

$ npm test        # full monorepo
core: 1770 pass 0 fail · mcp-server: 73 pass 0 fail · sdk: 40 tests, 39 pass 0 fail (1 pre-existing documented TODO, unrelated) · cli: 275 pass 0 fail

$ npm run lint
(clean, no output)
```

Zero-write marker-probe against the REAL `~/.agent-recall` (never `--write`, never touched by any test — all tests use `AGENT_RECALL_ROOT`/tmpdir overrides): correction-file count (542) and total `_rejected.jsonl` line count across all projects (82) verified byte-identical before this round's first edit vs. after the full monorepo test run above.

### Files changed (round 3)

- `packages/core/src/tools-logic/implicit-harvest.ts` — signal (b) gated behind `experimentalSignals` (mirrors signal (c)'s existing gate); header doc, `ImplicitHarvestOptions.experimentalSignals` doc comment, and `AGAIN_MARKER`'s own doc comment updated with the 48-day-window data and the "same sentence degrades to same turn for unpunctuated dictation" root cause.
- `packages/core/test/implicit-harvest.test.mjs` — 1 new test (dictation-monologue regression, default-off + experimental-on non-vacuous pair) + 1 new default-off test for the existing signal-(b) fixture; 16 existing signal-(b) tests across 7 describe blocks updated to pass `experimentalSignals: true` so they test their own mechanism, not the new default gate.
- `packages/cli/src/index.ts` — usage/help text updated (signal (a) is the default; `--experimental-signals` now covers (b) and (c)). No flag/behavior change — `experimentalSignals` was already passed through unchanged from CLI to core.
- This report.

No commit, no push, no `--write` against `~/.agent-recall` at any point in this round.

FEEDBACK_HINTS: outcome=success edited=clean escalated=none challenge_fired=false kept=canonical-gate-reuse,hard-floor-severity,experimental-signals-flag-name dropped=again-marker-from-default(experimental-signals-flag)
