# Evolution p1a — transcript-audit worker report (w1a)

Branch: `evolution-p0-p4` (confirmed via `git branch --show-current` before any write).
No commit/push performed (orchestrator-owned). No writes to `~/.agent-recall` (all
tests use fixture roots under `os.tmpdir()`, `AGENT_RECALL_ROOT` env var).

## What was built

`ar outcomes audit` — a transcript-grounded injection-outcome adjudicator. For an
audit day D it reads `corrections/_outcomes.jsonl` for corrections *injected* that
day (`kind=retrieved`), scans the Claude Code transcript directory, maps each
transcript to a project via the F1 claim-not-generate namer, and adjudicates each
injected correction with a deterministic lexical ladder — RECURRED > CITED >
IGNORED — writing evidence-prefixed `transcript-audit:` events. Adjudication
independence is structural: the module never reads the agent's own session
summary, only the raw transcript JSONL.

### Files

- `packages/core/src/helpers/transcript-project.ts` (new) — `resolveSessionProject`
  and its dependencies (`isSystemText`, `textFromContent`, `isBoilerplateRecord`,
  `SYSTEM_PREFIXES`), **moved** (not duplicated) out of
  `packages/cli/src/utils/transcript-reader.ts`. `agent-recall-core` has no
  dependency on `agent-recall-cli` (dependency direction is the reverse), so
  `transcript-audit.ts` — which lives in core — could not import the namer from
  the CLI package. `transcript-reader.ts` now re-exports these from
  `agent-recall-core` instead of defining its own copy; every existing call site
  (index.ts's archive hook, `transcript-reader.test.mjs`, `wm-slug-parity.test.mjs`)
  is unchanged and still green.
- `packages/core/src/tools-logic/transcript-audit.ts` (new) — the audit engine:
  day-range resolution, one-pass transcript scan (day-bucketed by per-line
  `timestamp`, mtime-fallback only when a file has zero per-line timestamps,
  never-guess escalation when neither is usable), the adjudication ladder, and
  the idempotent write path. Public entry point `runTranscriptAudit(options)`.
- `packages/core/src/tools-logic/session-end.ts` — exported `RECURRENCE_MARKER`,
  `EVAL_VOCAB_ANCHOR` (were module-private consts) and extracted a new exported
  `ruleContentWords(rule)` helper from the inline word-extraction duplicate in
  `sessionEnd()`'s heeded/recurred/not_violated split — refactored that call site
  to use it (byte-identical behavior, single source of truth now shared with
  `transcript-audit.ts`'s CITED tier).
- `packages/core/src/storage/corrections.ts` — extended `CorrectionOutcome["kind"]`
  with `"cited" | "ignored"`; extended the single-producer gate (mirrors the
  existing `not_triggered`/`dream-audit:` gate) so `cited`/`ignored` throw unless
  evidence starts with `"transcript-audit:"`; extended the ledger-only early-return
  branch so both new kinds append to `_outcomes.jsonl` and mutate **zero**
  materialized counters. `recurred` from this instrument reuses the existing kind
  (intentionally counter-mutating, not gated — other legitimate producers exist).
- `packages/core/src/index.ts` — barrel exports for both new modules.
- `packages/cli/src/index.ts` — new `audit` sub-verb under the existing
  `case "outcomes":` group (`--date` / `--backfill --since [--until]`,
  `--project`, `--claude-dir`, `--dry-run`, `--json`), following the existing
  `getFlag`/`hasFlag`/`missingArgs`/`process.exitCode`/`agent_instruction` idiom.
  Human-table output goes through `outputFenced()`; `--json` stays unfenced by
  the same established precedent as `awareness read --json` / `mirror --json`
  (a documented machine-consumption contract, never fenced by design).
- `packages/mcp-server/test/fence-manifest.mjs` — added the `outcomes.audit`
  manifest entry (classified `"fenced"`, matching `outcomes.audit-candidates`);
  the pre-existing `fence-completeness.test.mjs` guard fails the build on any
  new, unclassified CLI sub-action, and correctly caught this new verb.

### Tests (TDD)

- `packages/core/test/transcript-audit.test.mjs` (11 tests) — gate, ladder
  (RECURRED/CITED/IGNORED + the CHALLENGE fallback fix), day-bucketing +
  attachment-filter exclusion, mtime fallback, idempotency, `--dry-run`.
- `packages/cli/test/outcomes-audit-transcript.test.mjs` (9 tests) — flag
  validation (missing/mutually-exclusive/malformed), `--help` content,
  `--dry-run` end-to-end against a fixture claude-dir, `--json` shape, and a
  real (non-dry-run) write + idempotent re-run through the actual CLI binary.

## CHALLENGE clause invoked

The brief's own CHALLENGE flagged a real defect and I fixed it: the CITED tier's
"≥2 unique ≥4-char content words" bar is degenerate for a rule with fewer than 2
such words (e.g. `rule: "Ship it"` → `ruleWords = ["ship"]`) — such a correction
could **never** be cited via the content-word path, only via the id-literal path.
Fix applied exactly as the brief specified: `required = ruleWords.length < 2 ?
ruleWords.length : 2` — a <2-word rule requires ALL of its words instead of a
fixed 2. Proven with a dedicated red→green test (see below) plus the general
ladder tests.

One additional recon-mismatch worth flagging (not a CHALLENGE per se, just a
fact-check): the brief's step 8 idempotency idiom pointed at `readOutcomesOnDate`
(used by `ar outcomes record`'s dedup check), but that reader only returns
`Map<correction_id, Set<kind>>` — no `evidence` field, so it cannot support "skip
if an event ... whose evidence contains the same transcript basename." I used the
already-exported `readOutcomeEventsByCorrection(project)` instead (full events,
including `evidence`), which exists precisely for this kind of read and needed no
new core export.

## Evidence: RED → GREEN (per brief's TDD discipline)

Three mechanisms were surgically reverted (one line each), rebuilt, and run to
confirm genuine failure, then restored and re-verified green — full transcripts
below (trimmed to the relevant blocks; full logs were inspected live).

**1. Single-producer gate** (`corrections.ts`, prepended `false &&` to the guard):
```
▶ recordOutcome gate — cited/ignored require transcript-audit: evidence
  ✖ throws on cited without the prefix
  ✖ throws on ignored with NO evidence at all
  ✔ accepts cited/ignored WITH the prefix and never mutates counters
```
Restored → all 3 green.

**2. CHALLENGE fallback fix** (`transcript-audit.ts`, `required = 2` instead of the
length-aware fallback):
```
▶ adjudication ladder
  ✔ RECURRED wins ...
  ✔ CITED fires on ≥2 unique ≥4-char rule content words ...
  ✖ CHALLENGE fix: a <2-content-word rule ('Ship it' → 1 word) is CITED when that ONE word matches
  ✔ IGNORED when the only matching text is on a DIFFERENT day or inside an attachment record
  ✖ day summary counts match the four adjudications
ℹ pass 9 / fail 2
```
Restored → 11/11 green.

**3. Idempotency dedup check** (`transcript-audit.ts`, `alreadyRecorded = false &&
...`):
```
▶ idempotency
  ✖ re-running the same day against the same transcript set writes zero new events
ℹ pass 10 / fail 1
```
Restored → 11/11 green.

Final core-package run after all restores: `packages/core/test/transcript-audit.test.mjs`
→ 11/11 pass.

## Full-suite verification

- `npx tsc --noEmit -p packages/core` — clean.
- `npx tsc --noEmit -p packages/cli` — clean.
- `npm run lint` (root: tsc --noEmit across core, mcp-server, sdk, cli) — clean.
- `npm test` (root, all 4 workspaces in sequence):
  - `agent-recall-core`: **1718/1718** pass, 0 fail.
  - `agent-recall-mcp`: **73/73** pass, 0 fail (after adding the `outcomes.audit`
    fence-manifest entry — the completeness guard correctly caught the new
    unclassified CLI sub-action before the fix).
  - `agent-recall-sdk`: 39 pass, 0 fail, 1 pre-existing documented `# TODO`
    failure (`audit-sdk-contract.test.mjs` Case B — a known, unrelated
    global-root-sharing bug, "EXPECTED TO FAIL today", not touched by this task
    and outside the stated scope of packages/core + packages/cli).
  - `agent-recall-cli`: **265/265** pass, 0 fail (includes the 9 new
    `outcomes-audit-transcript.test.mjs` tests).
  - Root `npm test` exits 0.
- Manual end-to-end smoke test of `ar outcomes audit --date 2026-07-01
  --claude-dir <fixture> --dry-run` against a hand-built fixture claude-dir +
  fixture store — printed a correct one-row table (1 project, 1 injected, 1
  cited, 0 ignored, 0 recurred) and exit 0.

## Design notes / defensible decisions

- **Idempotency key**: each adjudication's evidence embeds a `basenameTag` — the
  winning transcript's basename for RECURRED/CITED, or the full sorted
  `"+"`-joined set of that day's matching transcripts for IGNORED. Re-running
  against the exact same transcript set reproduces the exact same tag, so the
  dedup check (`same kind + same day + evidence.includes(tag)`) is naturally
  idempotent without a separate dedup-key field.
- **Ladder is evaluated across the aggregate, not per-transcript**: tier (a) is
  checked against every matching transcript before falling to tier (b), matching
  "adjudicate each injected correction against that day's project transcripts"
  (plural) rather than short-circuiting per file.
- **mtime fallback is whole-file, per-line timestamps are per-line**: exactly per
  brief item 3. The one branch I could not exercise with a real integration test
  is the "mtime itself unusable" escalation (`ambiguous: true`) — forcing
  `fs.statSync` to fail without mocking requires a delete-between-read-and-stat
  race that isn't practically reproducible in a hermetic test. The code path
  exists and never silently guesses a day for such a file (it's excluded from
  every day's bucket and surfaced in `transcripts_ambiguous`); this is disclosed
  as an untested-by-integration, defensive-only branch.
- **Project resolution uses the WHOLE file's head/tail**, not the day-D-bounded
  slice — a session's project identity is a property of the whole transcript,
  not of one day's lines within it (mirrors how `resolveSessionProject` is used
  elsewhere in this codebase). Content/day extraction for the ladder is
  separately bounded to day D.
- **`--project` filter resolution** does not go through the side-effecting
  `resolveProject()` (which can create session state / register cwd allowlists)
  — it's a pure `resolveProjectDirName` + on-disk existence check, appropriate
  for a read-only forensic tool.

## Fix round

Code review flagged one MEDIUM issue: brief step 7 ("Include session_id when
derivable from the transcript filename (uuid)") was silently dropped — none of
the three `recordOutcome` calls in `auditDay()` passed `session_id`, even
though the transcript basename (the session uuid) was trivially available at
every call site and `CorrectionOutcome.session_id` exists precisely for this
stamping purpose. Confirmed: `grep -n session_id` across `transcript-audit.ts`
and both test files returned zero hits before this round.

**Root cause**: an oversight, not a deliberate scoping call — nothing in the
original report disclosed the omission (unlike the two other documented
deviations), so it wasn't a disclosed trade-off.

**Fix applied** (`packages/core/src/tools-logic/transcript-audit.ts`):
- Added `deriveSessionId(basenameTag: string): string | undefined` — the
  transcript basename IS the session uuid, so it's derivable whenever a
  verdict's evidence anchors to exactly ONE transcript. RECURRED/CITED always
  anchor to a single winning basename. IGNORED anchors to the day's FULL
  project file-set (`"+"`-joined) — derivable only when that set has size 1;
  when it spans multiple transcripts there is no single session to stamp, so
  `session_id` is correctly omitted rather than guessed from an arbitrary
  member of the set (no silent-param-discard traded for a silent-param-guess).
- Wired into the single `recordOutcome({...})` call site in `auditDay()`:
  `session_id: deriveSessionId(ladder.basenameTag)`.

**Tests added** (prove the fix, not just re-assert green):
- `packages/core/test/transcript-audit.test.mjs` — new `describe("session_id
  stamping", …)` block, 2 tests: (1) recurred/cited/ignored all carry
  `session_id === <the fixture's single transcript uuid>` when exactly one
  transcript contributes that day; (2) an IGNORED verdict spanning TWO
  transcripts on the same day omits `session_id` entirely (never guesses),
  while its `evidence` still shows the `"+"`-joined basename pair.
- `packages/cli/test/outcomes-audit-transcript.test.mjs` — added a
  `session_id` assertion to the existing real-write test, confirming the CLI
  path stamps the same fixture transcript's uuid end-to-end.

**RED → GREEN** (real command output):
1. Temporarily commented out the `session_id: deriveSessionId(...)` line,
   rebuilt core, ran `node --test packages/core/test/transcript-audit.test.mjs`:
   ```
   ▶ session_id stamping
     ✖ stamps session_id = the winning transcript's own uuid for recurred/cited/ignored when exactly one transcript contributes
       AssertionError: recurred event must carry the transcript's own uuid as session_id
       + actual - expected
       + undefined
       - 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
     ✔ omits session_id (never guesses) for an ignored verdict spanning MULTIPLE transcripts on the same day
   ✖ session_id stamping (6.591334ms)
   ℹ tests 13 · pass 12 · fail 1
   ```
2. Restored the fix, rebuilt core, re-ran the same file:
   ```
   ▶ session_id stamping
     ✔ stamps session_id = the winning transcript's own uuid for recurred/cited/ignored when exactly one transcript contributes (3.142666ms)
     ✔ omits session_id (never guesses) for an ignored verdict spanning MULTIPLE transcripts on the same day (2.927041ms)
   ✔ session_id stamping (6.109ms)
   ℹ tests 13 · pass 13 · fail 0
   ```

**Full verification after the fix**:
- `node --test packages/core/test/transcript-audit.test.mjs` → 13/13 pass
  (11 pre-existing + 2 new).
- `node --test packages/cli/test/outcomes-audit-transcript.test.mjs` → 9/9
  pass (includes the amended real-write test).
- `npm run lint` (root: `tsc --noEmit` across core, mcp-server, sdk, cli) →
  clean, zero diagnostics.
- `npm test` (root, all 4 workspaces): `agent-recall-core` 1720/1720,
  `agent-recall-mcp` 73/73, `agent-recall-sdk` 39 pass + 1 pre-existing
  documented `# TODO` failure (unrelated, unchanged, out of scope — same one
  disclosed in the original report), `agent-recall-cli` 265/265. Root command
  exits 0.
- Manual end-to-end smoke test: `ar outcomes audit --date 2026-07-01
  --project smoke-proj --claude-dir <fixture> --root <fixture-root>` (no
  `--dry-run`) against a hand-built fixture — the appended `_outcomes.jsonl`
  line now carries `"session_id":"abcdef01-2345-6789-abcd-ef0123456789"`
  matching the fixture transcript's own filename-derived uuid.

No `git commit`/`git push` performed. No writes to `~/.agent-recall` — all
verification used fixture roots under `os.tmpdir()`/`/tmp`.

SOP_ID: d2e8ab39
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth challenge_fired=true kept=all replaced=none
