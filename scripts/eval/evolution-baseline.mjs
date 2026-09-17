#!/usr/bin/env node
/**
 * evolution-baseline.mjs — Evolution roadmap Phase 0 baseline snapshot.
 *
 * READ-ONLY instrument. Computes the denominator every later evolution phase
 * is graded against (Phase 1 exit condition: verdict coverage >=50% and
 * outcome events >=10x this baseline — see brief p0-w3-baseline).
 *
 * Reads the store (default ~/.agent-recall, overridable via --store <path>)
 * and computes, relative to a --as-of <YYYY-MM-DD> anchor (default: today):
 *
 *   (a) corrections captured per week, last 4 FULL ISO weeks, by provenance
 *       field if present (provenance.mode bucket; "none" when the field is
 *       absent entirely).
 *   (b) outcome events per week by kind, from every project's
 *       corrections/_outcomes.jsonl, same 4-week window.
 *   (c) verdict coverage — see SCHEMA NOTES below, this is the one place the
 *       brief's literal spec and the codebase's existing canonical formula
 *       (packages/core/src/storage/corrections.ts computeCorrectionKPIs /
 *       scripts/eval/rmr-report.mjs buildVerdictLedger) provably diverge.
 *       Both numbers are reported; the brief's literal spec is primary.
 *   (d) distinct corrections retrieved in the last 28 days (as-of inclusive).
 *   (e) association edges = 0 — explicit constant; the ledger does not exist
 *       yet, so this is a documented floor, not a computed value.
 *
 * Evolution p1c (2026-09-17) — schema v2, ADDITIVE ONLY (every v1 field/value
 * above is unchanged for the same input; only new keys were added):
 *
 *   (f) transcript-audit events per week (same 4-week window as a/b): cited,
 *       ignored, and audit_recurred ("recurred" events whose evidence starts
 *       with "transcript-audit:", as opposed to ordinary session-end/
 *       check-action "recurred" events, which stay folded into (b)'s existing
 *       `recurred` bucket unchanged).
 *   (g) injection_precision = cited/(cited+ignored), aggregated over the SAME
 *       4-week window as (f) (not all-time — (f) is the only source of
 *       cited/ignored counts this script computes, so there is no broader
 *       population to aggregate over). null when cited+ignored===0, never 0.
 *   (h) implicit-correction counts, keyed by provenance.source. "Implicit" =
 *       provenance.mode === "observed" (the schema's own existing definition
 *       of "agent inferred, not user-told" — see corrections.ts's
 *       CorrectionProvenance doc comment). `total_by_source` is ALL-TIME
 *       (every observed-mode correction in the store, any date); `per_week`
 *       is windowed to the same last-4-full-ISO-weeks as (a) — the two are
 *       deliberately NOT the same population (a correction inside the
 *       current partial week counts in the total but not in any per_week
 *       bucket). CHALLENGE/ESCALATION: the brief's CONTEXT claims a "Phase
 *       1b" already landed corrections with the literal
 *       `provenance.source: "transcript-implicit"` — verified FALSE at
 *       implementation time (2026-09-17): `git log --all` and a repo-wide
 *       grep for "transcript-implicit" found zero occurrences; only Phase 0
 *       (7ff7af4) and Phase 1a (c59f04d) are merged on evolution-p0-p4. This
 *       script does NOT hardcode that literal string — it groups by whatever
 *       `provenance.source` value co-occurs with mode==="observed" (class,
 *       not instance), so it is correct today (0 across the live store) and
 *       automatically covers "transcript-implicit" or any other future
 *       implicit-producer's source tag the moment such a producer exists,
 *       with zero code changes. See the worker report for the full
 *       discrepancy writeup.
 *   (i) injection-outcome coverage — share of (project, correction_id, day)
 *       pairs with a "retrieved" event on that day that ALSO have >=1
 *       transcript-audit-evidenced event (cited|ignored|recurred, evidence
 *       starting "transcript-audit:") for that SAME pair. ALL-TIME (not
 *       window-limited — audit backfills run over arbitrary history, same
 *       population style as (c)). DUAL DENOMINATORS, always printed
 *       together (repo convention):
 *         coverage_theoretical = numerator / |every retrieved-day pair, ever|
 *         coverage_achievable  = numerator / |retrieved-day pairs whose DAY
 *           has >=1 transcript-audit-evidenced event SOMEWHERE in the store
 *           (any project, any correction) — i.e. days the auditor actually
 *           ran/had transcripts for, regardless of whether THIS pair's
 *           project happened to have matching content|.
 *       ESCALATION (ambiguous per brief, documented per its own escalation
 *       clause): "achievable" is scoped GLOBALLY (any project, any
 *       correction) rather than per-project, reading the brief's "ANY
 *       correction that day" literally rather than narrowing it to "any
 *       correction in this pair's project" — the transcript-audit instrument
 *       (transcript-audit.ts) scans the transcript directory ONCE per day
 *       across every project in a single run, so "the auditor could see this
 *       day" is a property of the DAY, not of a (day, project) combination.
 *       Both numbers are null (never 0) when their own denominator is 0.
 *
 * CHALLENGE (per brief) — outcome kind universe:
 *   packages/core/src/storage/corrections.ts:224-225 defines NINE kinds:
 *     retrieved | heeded | recurred | predicted | predict_hit | triggered |
 *     not_triggered | unknown | not_violated
 *   The brief's metric (b) description lists only SEVEN of these (omits
 *   "predicted" and "predict_hit"). The live store's _outcomes.jsonl
 *   (verified 2026-09-17: 1588 lines across 10 projects) contains both
 *   omitted kinds (282 "predicted", 4 "predict_hit" events) in real volume.
 *   Decision taken (not silent): this script tallies per-week counts for
 *   ALL NINE canonical kinds, plus a catch-all "other" bucket for any kind
 *   string outside that set (defensive — none observed in the live store as
 *   of this baseline). Dropping predicted/predict_hit would have understated
 *   real event volume by ~18% of all outcome lines in the live corpus.
 *
 * CHALLENGE / ESCALATION — verdict-coverage semantics:
 *   The brief defines (c) as "share of corrections with >=1 retrieved event
 *   whose LATEST post-retrieval verdict is NOT unknown" — an ORDER-sensitive,
 *   per-correction-id definition read directly off _outcomes.jsonl.
 *   The codebase already ships a DIFFERENT canonical formula:
 *     verdict_coverage = |{injected id : kinds have heeded|recurred|not_triggered}|
 *                         / |{injected id}|
 *   ("injected" = correction records with retrieved_count > 0). That formula
 *   is PRESENCE-based (any qualifying event, ever) and EXCLUDES not_violated
 *   from the numerator by design (see corrections.ts:281-287 — not_violated is
 *   "deliberately NOT blended into heed_rate/precision/verdict_coverage").
 *   These two formulas diverge whenever a correction's LATEST verdict-kind
 *   event is "unknown" but an EARLIER event was heeded/recurred/not_triggered
 *   (verdict flip-flops over time), and whenever the latest verdict is
 *   "not_violated" (brief's literal wording counts it as "not unknown" i.e.
 *   covered; the canonical formula does not).
 *   Decision taken (documented, not silent): this script implements the
 *   brief's literal wording as the PRIMARY `metrics.verdict_coverage.coverage`
 *   number — reading the ledger directly (denominator = ids with >=1
 *   "retrieved" EVENT in _outcomes.jsonl, not the retrieved_count FIELD on the
 *   correction record, since the ledger is the authoritative source per the
 *   brief's own store-layout description) — and additionally reports the
 *   codebase's canonical presence-based figure side by side under
 *   `canonical_production_comparison`, computed on the SAME event-based
 *   denominator population for a fair, apples-to-apples comparison (note:
 *   this still differs from the TRUE production number, which gates the
 *   denominator on the retrieved_count field instead of the ledger — a
 *   further, smaller divergence also documented in schema_notes).
 *   VERDICT_KINDS considered a "verdict" for the latest-event search:
 *   heeded, recurred, not_violated, unknown, not_triggered. Excluded:
 *   retrieved (the trigger, not a verdict), triggered (a consult signal,
 *   precedes the verdict), predicted/predict_hit (prediction bookkeeping,
 *   unrelated to whether THIS retrieval was heeded).
 *
 * Usage:
 *   node scripts/eval/evolution-baseline.mjs                       # real ~/.agent-recall, as-of today
 *   node scripts/eval/evolution-baseline.mjs --store <dir>         # explicit store root
 *   node scripts/eval/evolution-baseline.mjs --as-of 2026-09-17    # deterministic anchor date
 *   node scripts/eval/evolution-baseline.mjs --out <file>          # override artifact path
 *   node scripts/eval/evolution-baseline.mjs --quiet               # suppress the human table
 *
 * Exit codes: 0 always (a read-only reporting instrument never fails the
 * process on data problems — those surface as diagnostics counters instead).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SCHEMA_VERSION = "evolution-baseline/v2";

/**
 * Canonical outcome-event kind universe, per packages/core/src/storage/
 * corrections.ts:224-225 (CorrectionOutcome.kind union). Fixed array order —
 * this is also the deterministic key order for `by_kind` objects.
 */
export const KNOWN_OUTCOME_KINDS = [
  "retrieved",
  "triggered",
  "heeded",
  "recurred",
  "not_violated",
  "unknown",
  "not_triggered",
  "predicted",
  "predict_hit",
];

/** Kinds treated as a resolvable "verdict" for metric (c). See file docblock. */
export const VERDICT_KINDS = new Set(["heeded", "recurred", "not_violated", "unknown", "not_triggered"]);

/** Kinds the codebase's CANONICAL presence-based formula treats as "covered". */
const CANONICAL_COVERING_KINDS = new Set(["heeded", "recurred", "not_triggered"]);

// ───────────────────────────────────────────────────────────────────────────
// Date / ISO-week helpers (all UTC-anchored for determinism across TZs)
// ───────────────────────────────────────────────────────────────────────────

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** ISO week label "YYYY-Www" for the ISO week containing `d` (UTC). */
export function isoWeekLabel(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // move to Thursday of this ISO week
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4DayNum);
  const diffDays = Math.round((date - week1Monday) / 86400000);
  const weekNum = Math.floor(diffDays / 7) + 1;
  return `${isoYear}-W${String(weekNum).padStart(2, "0")}`;
}

function mondayOfWeekContaining(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum);
  return date;
}

/**
 * Last 4 FULL ISO weeks relative to `asOfDate`, oldest -> newest. "Full"
 * means strictly BEFORE the (possibly partial) ISO week containing as-of —
 * the current week is always excluded regardless of which weekday as-of
 * falls on. Documented interpretation (brief did not specify this edge).
 */
export function computeLast4FullIsoWeeks(asOfDate) {
  const curMonday = mondayOfWeekContaining(asOfDate);
  const weeks = [];
  for (let i = 4; i >= 1; i--) {
    const start = new Date(curMonday);
    start.setUTCDate(curMonday.getUTCDate() - 7 * i);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    weeks.push({ iso_week: isoWeekLabel(start), start: fmtDate(start), end: fmtDate(end) });
  }
  return weeks;
}

/** Inclusive 28-day window ending on as-of: [as_of - 27, as_of]. */
export function computeLast28DayWindow(asOfDate) {
  const end = new Date(Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth(), asOfDate.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - 27);
  return { start: fmtDate(start), end: fmtDate(end) };
}

function findWeekIndex(dayStr, weeks) {
  for (let i = 0; i < weeks.length; i++) {
    if (dayStr >= weeks[i].start && dayStr <= weeks[i].end) return i;
  }
  return -1;
}

/** Parses an ISO timestamp to a UTC "YYYY-MM-DD" day string, or null if unparseable. */
function dayUTC(at) {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

// ───────────────────────────────────────────────────────────────────────────
// Store readers — per-item resilient (constraint 4): corrupt/missing/empty
// are counted in diagnostics, never thrown.
// ───────────────────────────────────────────────────────────────────────────

function defaultStoreRoot() {
  return path.join(os.homedir(), ".agent-recall");
}

/** Sorted list of project directory names under <root>/projects/. [] if absent. */
function listProjectDirs(root) {
  const base = path.join(root, "projects");
  if (!fs.existsSync(base)) return { dirs: [], exists: false };
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return { dirs: [], exists: false };
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  dirs.sort();
  return { dirs, exists: true };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Reads every correction JSON record for a project (excludes _-prefixed
 * ledger/index files, mirrors readCorrections() idiom in rmr-report.mjs).
 * Returns records with a valid `date` plus per-file diagnostics.
 */
function readCorrectionRecords(root, project) {
  const dir = path.join(root, "projects", project, "corrections");
  if (!fs.existsSync(dir)) {
    return { records: [], filesFound: 0, corrupt: 0, missingDate: 0, dirExists: false };
  }
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { records: [], filesFound: 0, corrupt: 0, missingDate: 0, dirExists: true };
  }
  const jsonFiles = files.filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
  const records = [];
  let corrupt = 0;
  let missingDate = 0;
  for (const f of jsonFiles) {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    } catch {
      corrupt++;
      continue;
    }
    if (!rec || typeof rec !== "object" || typeof rec.date !== "string" || !DATE_RE.test(rec.date)) {
      missingDate++;
      continue;
    }
    records.push(rec);
  }
  return { records, filesFound: jsonFiles.length, corrupt, missingDate, dirExists: true };
}

/**
 * Reads _outcomes.jsonl for a project. Returns structurally-valid events
 * ({ correction_id, kind, at } all present as strings) plus diagnostics.
 * Line order is preserved (append order = chronological) — required for the
 * "latest verdict" tie-break in metric (c).
 */
function readOutcomeEvents(root, project) {
  const p = path.join(root, "projects", project, "corrections", "_outcomes.jsonl");
  if (!fs.existsSync(p)) {
    return { events: [], linesTotal: 0, corrupt: 0, exists: false };
  }
  let raw;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return { events: [], linesTotal: 0, corrupt: 0, exists: true };
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const events = [];
  let corrupt = 0;
  for (const line of lines) {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      corrupt++;
      continue;
    }
    if (!evt || typeof evt.correction_id !== "string" || typeof evt.kind !== "string" || typeof evt.at !== "string") {
      corrupt++;
      continue;
    }
    // v2 (f)/(i): evidence carried through opportunistically (optional field
    // on CorrectionOutcome — see corrections.ts). Not part of the corrupt-line
    // validity check above; a missing/non-string evidence is simply absent,
    // never a parse failure.
    events.push({
      correction_id: evt.correction_id,
      kind: evt.kind,
      at: evt.at,
      evidence: typeof evt.evidence === "string" ? evt.evidence : undefined,
    });
  }
  return { events, linesTotal: lines.length, corrupt, exists: true };
}

/** provenance.mode bucket, "none" absent / "unspecified" malformed. */
function provenanceBucket(provenance) {
  if (provenance === undefined || provenance === null) return "none";
  if (typeof provenance !== "object" || Array.isArray(provenance)) return "unspecified";
  const mode = provenance.mode;
  if (typeof mode === "string" && mode.trim().length > 0) return mode.trim();
  return "unspecified";
}

/**
 * v2 (h): "implicit" = provenance.mode === "observed" exactly (the schema's
 * own existing "agent inferred, not user-told" semantic — see file docblock).
 * Raw provenance object, no defaulting — mirrors provenanceBucket()'s
 * convention of reading exactly what's on disk.
 */
function isObservedProvenance(provenance) {
  return !!provenance && typeof provenance === "object" && !Array.isArray(provenance) && provenance.mode === "observed";
}

/** provenance.source bucket for an already-confirmed-observed provenance object. */
function sourceBucket(source) {
  if (typeof source === "string" && source.trim().length > 0) return source.trim();
  return "unspecified";
}

/** v2 (f)/(i): the single-producer evidence-prefix gate transcript-audit.ts's recordOutcome() enforces (corrections.ts). */
function isTranscriptAuditEvidence(evidence) {
  return typeof evidence === "string" && evidence.startsWith("transcript-audit:");
}

/** Rounds to 4 decimal places, matching the existing verdict_coverage convention. */
function round4(x) {
  return Number(x.toFixed(4));
}

function buildKindObject(countsMap) {
  const obj = {};
  for (const k of KNOWN_OUTCOME_KINDS) obj[k] = countsMap.get(k) ?? 0;
  obj.other = countsMap.get("other") ?? 0;
  return obj;
}

function buildProvenanceObject(countsMap, orderedKeys) {
  const obj = {};
  for (const k of orderedKeys) obj[k] = countsMap.get(k) ?? 0;
  return obj;
}

// ───────────────────────────────────────────────────────────────────────────
// Core computation
// ───────────────────────────────────────────────────────────────────────────

/**
 * Pure computation over a store root + as-of date. No wall-clock reads.
 * `asOf` must be "YYYY-MM-DD". Returns the full baseline result object,
 * built with fixed key-insertion order throughout (constraint 2).
 */
export function computeBaseline({ storeRoot, asOf }) {
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);
  if (Number.isNaN(asOfDate.getTime())) {
    throw new Error(`--as-of must be YYYY-MM-DD, got: ${asOf}`);
  }
  const weeks = computeLast4FullIsoWeeks(asOfDate);
  const dayWindow = computeLast28DayWindow(asOfDate);

  const { dirs: projects, exists: projectsDirExists } = listProjectDirs(storeRoot);

  const diagnostics = {
    store_projects_dir_exists: projectsDirExists,
    projects_scanned: projects.length,
    projects_with_corrections_dir: 0,
    projects_without_corrections_dir: 0,
    correction_json_files_found: 0,
    correction_json_files_parsed_ok: 0,
    correction_json_files_corrupt_skipped: 0,
    correction_json_files_missing_date_skipped: 0,
    outcomes_files_found: 0,
    outcomes_files_missing: 0,
    outcomes_lines_total: 0,
    outcomes_lines_parsed_ok: 0,
    outcomes_lines_corrupt_skipped: 0,
    outcomes_lines_invalid_timestamp_skipped: 0,
  };

  const perWeekProvenance = weeks.map(() => new Map());
  const perWeekTotal = weeks.map(() => 0);
  const provenanceKeysSeen = new Set(["none"]);

  const perWeekKind = weeks.map(() => new Map());
  const perWeekKindTotal = weeks.map(() => 0);

  // v2 (f): cited/ignored/audit_recurred, same 4-week window, tallied in the
  // SAME per-event loop as perWeekKind below (no second pass over the data).
  const perWeekCited = weeks.map(() => 0);
  const perWeekIgnored = weeks.map(() => 0);
  const perWeekAuditRecurred = weeks.map(() => 0);

  // v2 (h): implicit corrections (provenance.mode === "observed"), keyed by
  // provenance.source. `totalBySource` is ALL-TIME (not window-gated);
  // `perWeekImplicitBySource` mirrors perWeekProvenance's windowing.
  const totalImplicitBySource = new Map();
  const perWeekImplicitBySource = weeks.map(() => new Map());
  const implicitSourceKeysSeen = new Set();

  // (project, correction_id) -> [{kind, at, atMs, day, evidence}], append order preserved
  const outcomesByKey = new Map();

  for (const project of projects) {
    const corrDirPath = path.join(storeRoot, "projects", project, "corrections");
    const hasCorrDir = fs.existsSync(corrDirPath);
    if (hasCorrDir) diagnostics.projects_with_corrections_dir++;
    else diagnostics.projects_without_corrections_dir++;

    const { records, filesFound, corrupt, missingDate } = readCorrectionRecords(storeRoot, project);
    diagnostics.correction_json_files_found += filesFound;
    diagnostics.correction_json_files_corrupt_skipped += corrupt;
    diagnostics.correction_json_files_missing_date_skipped += missingDate;
    diagnostics.correction_json_files_parsed_ok += records.length;

    for (const rec of records) {
      const dayShort = rec.date.slice(0, 10);
      const wIdx = findWeekIndex(dayShort, weeks);

      // v2 (h): implicit-correction ALL-TIME total — computed BEFORE the
      // window early-continue below (v1's own early-continue, position and
      // behavior unchanged) since `total_by_source` is deliberately NOT
      // window-limited (see file docblock).
      if (isObservedProvenance(rec.provenance)) {
        const srcKey = sourceBucket(rec.provenance.source);
        implicitSourceKeysSeen.add(srcKey);
        totalImplicitBySource.set(srcKey, (totalImplicitBySource.get(srcKey) ?? 0) + 1);
        if (wIdx !== -1) {
          const im = perWeekImplicitBySource[wIdx];
          im.set(srcKey, (im.get(srcKey) ?? 0) + 1);
        }
      }

      if (wIdx === -1) continue; // outside the 4-week window — not counted in metric (a)
      perWeekTotal[wIdx]++;
      const bucket = provenanceBucket(rec.provenance);
      provenanceKeysSeen.add(bucket);
      const m = perWeekProvenance[wIdx];
      m.set(bucket, (m.get(bucket) ?? 0) + 1);
    }

    const { events, linesTotal, corrupt: outcomesCorrupt, exists: outcomesExists } = readOutcomeEvents(storeRoot, project);
    if (hasCorrDir) {
      if (outcomesExists) diagnostics.outcomes_files_found++;
      else diagnostics.outcomes_files_missing++;
    }
    diagnostics.outcomes_lines_total += linesTotal;
    diagnostics.outcomes_lines_corrupt_skipped += outcomesCorrupt;

    for (const evt of events) {
      const day = dayUTC(evt.at);
      if (day === null) {
        diagnostics.outcomes_lines_invalid_timestamp_skipped++;
        continue;
      }
      diagnostics.outcomes_lines_parsed_ok++;

      const wIdx = findWeekIndex(day, weeks);
      if (wIdx !== -1) {
        perWeekKindTotal[wIdx]++;
        const kindKey = KNOWN_OUTCOME_KINDS.includes(evt.kind) ? evt.kind : "other";
        const m = perWeekKind[wIdx];
        m.set(kindKey, (m.get(kindKey) ?? 0) + 1);

        // v2 (f): cited/ignored/audit_recurred, same week bucket, ADDITIVE to
        // (not instead of) the v1 by_kind tally above (cited/ignored fall
        // into v1's "other" bucket unchanged — v1 predates these kinds).
        if (evt.kind === "cited") perWeekCited[wIdx]++;
        else if (evt.kind === "ignored") perWeekIgnored[wIdx]++;
        else if (evt.kind === "recurred" && isTranscriptAuditEvidence(evt.evidence)) perWeekAuditRecurred[wIdx]++;
      }

      // NUL separator, not a space: a project slug or correction_id
      // containing a literal space would otherwise collide across distinct
      // (project, id) pairs and silently merge their outcome-event timelines.
      const key = `${project}\u0000${evt.correction_id}`;
      let arr = outcomesByKey.get(key);
      if (!arr) {
        arr = [];
        outcomesByKey.set(key, arr);
      }
      // v2 (i): evidence carried through for the transcript-audit coverage check.
      arr.push({ kind: evt.kind, at: evt.at, atMs: Date.parse(evt.at), day, evidence: evt.evidence });
    }
  }

  // ── metric (c) + (d): per (project, correction_id) ──────────────────────
  let verdictDenominator = 0;
  let verdictNumerator = 0;
  let canonicalNumerator = 0;
  let distinctRetrievedLast28Days = 0;

  for (const arr of outcomesByKey.values()) {
    const events = arr.slice().sort((a, b) => a.atMs - b.atMs); // stable sort, preserves append order on ties
    const retrievedEvents = events.filter((e) => e.kind === "retrieved");

    if (retrievedEvents.some((e) => e.day >= dayWindow.start && e.day <= dayWindow.end)) {
      distinctRetrievedLast28Days++;
    }

    if (retrievedEvents.length === 0) continue; // never retrieved — outside the (c) denominator population

    verdictDenominator++;
    const firstRetrievedMs = retrievedEvents[0].atMs;
    const candidateVerdicts = events.filter((e) => VERDICT_KINDS.has(e.kind) && e.atMs >= firstRetrievedMs);
    if (candidateVerdicts.length > 0) {
      const latest = candidateVerdicts[candidateVerdicts.length - 1];
      if (latest.kind !== "unknown") verdictNumerator++;
    }

    const kindsPresent = new Set(events.map((e) => e.kind));
    for (const k of CANONICAL_COVERING_KINDS) {
      if (kindsPresent.has(k)) {
        canonicalNumerator++;
        break;
      }
    }
  }

  // ── metric (i): injection-outcome coverage, ALL-TIME, dual denominators ──
  // retrievedDaysByKey: per (project,correction_id) key, the set of days
  // that key has >=1 "retrieved" event. auditEvidencedDaysByKey: same key
  // shape, the set of days that key has >=1 transcript-audit-evidenced event
  // (cited|ignored|recurred, evidence starting "transcript-audit:").
  // globalAuditedDays: the UNION of those days across EVERY key in the store
  // -- "days the auditor could see" per the file docblock's ESCALATION note.
  // Nested Maps (not a flattened "key+day" string) so no separator character
  // is ever needed between a key and a day -- sidesteps the exact collision
  // class the NUL-separator comment above (outcomesByKey's construction)
  // exists to guard against.
  const retrievedDaysByKey = new Map();
  const auditEvidencedDaysByKey = new Map();
  const globalAuditedDays = new Set();

  function addToDaySetMap(map, key, day) {
    let daySet = map.get(key);
    if (!daySet) {
      daySet = new Set();
      map.set(key, daySet);
    }
    daySet.add(day);
  }

  for (const [key, arr] of outcomesByKey.entries()) {
    for (const e of arr) {
      if (e.kind === "retrieved") {
        addToDaySetMap(retrievedDaysByKey, key, e.day);
      }
      if ((e.kind === "cited" || e.kind === "ignored" || e.kind === "recurred") && isTranscriptAuditEvidence(e.evidence)) {
        globalAuditedDays.add(e.day);
        addToDaySetMap(auditEvidencedDaysByKey, key, e.day);
      }
    }
  }

  let theoreticalDenominator = 0;
  let theoreticalNumerator = 0;
  let achievableDenominator = 0;
  let achievableNumerator = 0;

  for (const [key, days] of retrievedDaysByKey.entries()) {
    const coveredDays = auditEvidencedDaysByKey.get(key);
    for (const day of days) {
      theoreticalDenominator++;
      const covered = !!coveredDays && coveredDays.has(day);
      if (covered) theoreticalNumerator++;

      if (globalAuditedDays.has(day)) {
        achievableDenominator++;
        if (covered) achievableNumerator++;
      }
    }
  }

  const orderedProvenanceKeys = [
    "none",
    ...[...provenanceKeysSeen].filter((k) => k !== "none").sort(),
  ];

  const correctionsCapturedPerWeek = weeks.map((w, i) => ({
    iso_week: w.iso_week,
    start: w.start,
    end: w.end,
    total: perWeekTotal[i],
    by_provenance: buildProvenanceObject(perWeekProvenance[i], orderedProvenanceKeys),
  }));

  const outcomeEventsPerWeek = weeks.map((w, i) => ({
    iso_week: w.iso_week,
    start: w.start,
    end: w.end,
    total: perWeekKindTotal[i],
    by_kind: buildKindObject(perWeekKind[i]),
  }));

  const verdictCoverage =
    verdictDenominator > 0 ? Number((verdictNumerator / verdictDenominator).toFixed(4)) : null;
  const canonicalCoverage =
    verdictDenominator > 0 ? Number((canonicalNumerator / verdictDenominator).toFixed(4)) : null;

  // ── v2 (f): transcript-audit events per week (same 4-week window) ───────
  const transcriptAuditEventsPerWeek = weeks.map((w, i) => ({
    iso_week: w.iso_week,
    start: w.start,
    end: w.end,
    cited: perWeekCited[i],
    ignored: perWeekIgnored[i],
    audit_recurred: perWeekAuditRecurred[i],
  }));

  // ── v2 (g): injection_precision, aggregated over the SAME 4-week window ─
  const citedTotal = perWeekCited.reduce((a, b) => a + b, 0);
  const ignoredTotal = perWeekIgnored.reduce((a, b) => a + b, 0);
  const injectionPrecisionDenominator = citedTotal + ignoredTotal;
  const injectionPrecision = {
    window: { start: weeks[0].start, end: weeks[weeks.length - 1].end },
    cited: citedTotal,
    ignored: ignoredTotal,
    precision: injectionPrecisionDenominator > 0 ? round4(citedTotal / injectionPrecisionDenominator) : null,
  };

  // ── v2 (h): implicit corrections, keyed by provenance.source ────────────
  const orderedImplicitSourceKeys = [...implicitSourceKeysSeen].sort();
  const implicitCorrections = {
    total_by_source: buildProvenanceObject(totalImplicitBySource, orderedImplicitSourceKeys),
    per_week: weeks.map((w, i) => ({
      iso_week: w.iso_week,
      start: w.start,
      end: w.end,
      by_source: buildProvenanceObject(perWeekImplicitBySource[i], orderedImplicitSourceKeys),
    })),
  };

  // ── v2 (i): injection-outcome coverage, dual denominators ────────────────
  const injectionOutcomeCoverage = {
    theoretical: {
      numerator: theoreticalNumerator,
      denominator: theoreticalDenominator,
      coverage: theoreticalDenominator > 0 ? round4(theoreticalNumerator / theoreticalDenominator) : null,
    },
    achievable: {
      numerator: achievableNumerator,
      denominator: achievableDenominator,
      coverage: achievableDenominator > 0 ? round4(achievableNumerator / achievableDenominator) : null,
    },
  };

  return {
    schema: SCHEMA_VERSION,
    generated_at: `${asOf}T00:00:00.000Z`,
    as_of: asOf,
    store_root: storeRoot,
    window: {
      last_4_full_iso_weeks: weeks,
      last_28_days: dayWindow,
    },
    metrics: {
      corrections_captured_per_week: correctionsCapturedPerWeek,
      outcome_events_per_week: outcomeEventsPerWeek,
      verdict_coverage: {
        definition:
          "share of (project, correction_id) pairs with >=1 'retrieved' event in _outcomes.jsonl " +
          "(any time, not window-limited) whose LATEST verdict-kind event at/after the first retrieval " +
          "is NOT 'unknown'. Brief's literal spec — see file docblock for the CHALLENGE re divergence " +
          "from the codebase's canonical formula.",
        kinds_considered_verdict: [...VERDICT_KINDS].sort(),
        denominator: verdictDenominator,
        numerator: verdictNumerator,
        coverage: verdictCoverage,
        canonical_production_comparison: {
          description:
            "packages/core/src/storage/corrections.ts computeCorrectionKPIs() / scripts/eval/rmr-report.mjs " +
            "buildVerdictLedger(): presence-based (kinds include heeded|recurred|not_triggered, ANY time, " +
            "not 'latest'), same event-based denominator population as above for a fair comparison. " +
            "NOTE: true production also differs by using the retrieved_count FIELD on the correction " +
            "record as its denominator population instead of a ledger 'retrieved' EVENT — not reproduced " +
            "here since this script does not cross-reference outcome events against correction records.",
          kinds_considered_covering: [...CANONICAL_COVERING_KINDS].sort(),
          denominator: verdictDenominator,
          numerator: canonicalNumerator,
          coverage: canonicalCoverage,
        },
      },
      distinct_corrections_retrieved_last_28_days: distinctRetrievedLast28Days,
      association_edges: 0,
      transcript_audit_events_per_week: transcriptAuditEventsPerWeek,
      injection_precision: injectionPrecision,
      implicit_corrections: implicitCorrections,
      injection_outcome_coverage: injectionOutcomeCoverage,
    },
    diagnostics,
    schema_notes: {
      outcome_kind_universe:
        "Brief listed 7 kinds (retrieved/triggered/heeded/recurred/not_violated/unknown/not_triggered). " +
        "The codebase's CorrectionOutcome.kind union (corrections.ts:224-225) has 9: adds 'predicted' and " +
        "'predict_hit'. The live store (verified 2026-09-17) contains both in real volume (282 predicted, " +
        "4 predict_hit of 1588 total outcome lines). This script tallies all 9 canonical kinds plus a " +
        "catch-all 'other' bucket for any kind string outside that set.",
      verdict_coverage_interpretation:
        "See metrics.verdict_coverage.definition and canonical_production_comparison. Primary number " +
        "follows the brief's literal 'latest post-retrieval verdict' wording; the canonical presence-based " +
        "figure is reported alongside, never silently substituted.",
      week_window_definition:
        "'Last 4 full ISO weeks' = the 4 consecutive Mon-Sun ISO weeks strictly before the (possibly " +
        "partial) ISO week containing --as-of. The as-of week itself is ALWAYS excluded, regardless of " +
        "which weekday as-of falls on.",
      day_window_definition:
        "'Last 28 days' = the UTC-calendar-date window [as-of - 27 days, as-of], inclusive on both ends " +
        "(28 distinct days total). Event day = UTC calendar date of the outcome event's `at` timestamp.",
      provenance_grouping:
        "Grouped by provenance.mode when the correction record has a `provenance` object with a non-empty " +
        "string `mode`; 'none' when the `provenance` field is absent entirely; 'unspecified' when present " +
        "but malformed (not an object, or object without a usable `mode` string). Only 8/108 correction " +
        "records in the live store carry a provenance field as of this baseline (all mode='told').",
      association_edges:
        "Explicit constant 0 — the association-edge ledger does not exist yet in this store version. " +
        "Not a computed value; recorded as a documented floor for later phases to compare against.",
      transcript_audit_events_v2:
        "(f) cited/ignored/audit_recurred tallied over the SAME last-4-full-ISO-weeks window as (a)/(b). " +
        "'audit_recurred' = 'recurred' kind events whose evidence starts with 'transcript-audit:' (the " +
        "single-producer gate corrections.ts's recordOutcome() enforces for this instrument, see " +
        "transcript-audit.ts). Ordinary (non-audit) 'recurred' events are UNCHANGED in (b)'s existing " +
        "'recurred' bucket — this is an additional cross-cut, not a replacement. cited/ignored are NOT in " +
        "v1's KNOWN_OUTCOME_KINDS, so they also still land in (b)'s 'other' bucket unchanged — v1 predates " +
        "these kinds and its behavior is deliberately untouched.",
      injection_precision_v2:
        "(g) injection_precision = cited/(cited+ignored), aggregated over the SAME 4-week window as (f) " +
        "(sum of the per-week cited/ignored columns) — NOT all-time, since (f) is the only source of " +
        "cited/ignored counts this script computes. null when cited+ignored===0, never 0.",
      implicit_corrections_v2:
        "(h) 'implicit correction' = a correction record whose provenance.mode === 'observed' exactly " +
        "(the schema's own pre-existing 'agent inferred, not user-told' semantic — see corrections.ts's " +
        "CorrectionProvenance doc comment). Grouped by the raw provenance.source string value (class, not " +
        "instance — covers whatever source tag any current or future implicit-producer uses, with zero " +
        "code changes). 'unspecified' when mode==='observed' but source is missing/malformed. " +
        "total_by_source is ALL-TIME (every observed-mode correction ever, any date); per_week is windowed " +
        "to the SAME last-4-full-ISO-weeks as (a) — the two are deliberately DIFFERENT populations (a " +
        "correction inside the current partial week counts in the total but appears in no per_week " +
        "bucket). CHALLENGE/ESCALATION: the evolution worker brief's CONTEXT asserted a 'Phase 1b' had " +
        "already landed corrections with the literal provenance.source==='transcript-implicit' — verified " +
        "FALSE at implementation time (2026-09-17): neither `git log --all` on evolution-p0-p4 nor a " +
        "repo-wide grep for 'transcript-implicit' found any occurrence; only Phase 0 (7ff7af4) and Phase 1a " +
        "(c59f04d) are merged. This script does not hardcode that literal string for exactly that reason — " +
        "it is correct today (0 across the live store, since no observed-mode-with-that-source corrections " +
        "exist) and will pick up 'transcript-implicit' or any other future implicit-producer's source tag " +
        "automatically the moment one exists.",
      injection_outcome_coverage_v2:
        "(i) share of (project, correction_id, day) pairs with a 'retrieved' event on that day that ALSO " +
        "have >=1 transcript-audit-evidenced event (cited|ignored|recurred, evidence starting " +
        "'transcript-audit:') for that SAME pair. ALL-TIME (not window-limited — audit backfills run over " +
        "arbitrary history, same population style as (c)/(d)). DUAL DENOMINATORS, always printed together: " +
        "coverage_theoretical = numerator / |every retrieved-day pair, ever|; coverage_achievable = " +
        "numerator / |retrieved-day pairs whose DAY has >=1 transcript-audit-evidenced event SOMEWHERE in " +
        "the store (ANY project, ANY correction)|. ESCALATION (ambiguous per the brief's own wording, " +
        "documented per its escalation clause): 'achievable' is scoped GLOBALLY across every project/" +
        "correction rather than per-project — transcript-audit.ts scans the transcript directory ONCE per " +
        "day across every project in a single run, so 'a day the auditor could see' is a property of the " +
        "DAY, not of a (day, project) pair. Both coverage numbers are null (never 0) when their own " +
        "denominator is 0.",
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering
// ───────────────────────────────────────────────────────────────────────────

export function renderTable(result) {
  const L = [];
  L.push("=== evolution-baseline (Phase 0 denominator) ===");
  L.push(`schema        : ${result.schema}`);
  L.push(`as_of         : ${result.as_of}`);
  L.push(`store_root    : ${result.store_root}`);
  L.push("");
  L.push("(a) corrections captured per week (last 4 full ISO weeks):");
  for (const w of result.metrics.corrections_captured_per_week) {
    const prov = Object.entries(w.by_provenance)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    L.push(`  ${w.iso_week} [${w.start}..${w.end}]  total=${w.total}  (${prov})`);
  }
  L.push("");
  L.push("(b) outcome events per week by kind:");
  for (const w of result.metrics.outcome_events_per_week) {
    const kinds = Object.entries(w.by_kind)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    L.push(`  ${w.iso_week} [${w.start}..${w.end}]  total=${w.total}  (${kinds || "none"})`);
  }
  L.push("");
  const vc = result.metrics.verdict_coverage;
  L.push("(c) verdict coverage (literal brief spec, all-time):");
  L.push(`  ${vc.numerator} / ${vc.denominator} = ${vc.coverage === null ? "n/a" : vc.coverage}`);
  L.push(
    `  canonical-production comparison (presence-based): ${vc.canonical_production_comparison.numerator} / ` +
      `${vc.canonical_production_comparison.denominator} = ${vc.canonical_production_comparison.coverage === null ? "n/a" : vc.canonical_production_comparison.coverage}`
  );
  L.push("");
  L.push(`(d) distinct corrections retrieved in last 28 days [${result.window.last_28_days.start}..${result.window.last_28_days.end}]: ${result.metrics.distinct_corrections_retrieved_last_28_days}`);
  L.push("");
  L.push(`(e) association edges: ${result.metrics.association_edges}`);
  L.push("");
  L.push("(f) transcript-audit events per week (cited/ignored/audit_recurred):");
  for (const w of result.metrics.transcript_audit_events_per_week) {
    L.push(`  ${w.iso_week} [${w.start}..${w.end}]  cited=${w.cited} ignored=${w.ignored} audit_recurred=${w.audit_recurred}`);
  }
  L.push("");
  const ip = result.metrics.injection_precision;
  L.push(`(g) injection precision [${ip.window.start}..${ip.window.end}]: ${ip.cited} / (${ip.cited}+${ip.ignored}) = ${ip.precision === null ? "n/a" : ip.precision}`);
  L.push("");
  const ic = result.metrics.implicit_corrections;
  L.push(`(h) implicit corrections (provenance.mode=observed), total by source: ${JSON.stringify(ic.total_by_source)}`);
  for (const w of ic.per_week) {
    L.push(`  ${w.iso_week} [${w.start}..${w.end}]  ${JSON.stringify(w.by_source)}`);
  }
  L.push("");
  const cov = result.metrics.injection_outcome_coverage;
  L.push("(i) injection-outcome coverage (all-time, dual denominators):");
  L.push(`  theoretical: ${cov.theoretical.numerator} / ${cov.theoretical.denominator} = ${cov.theoretical.coverage === null ? "n/a" : cov.theoretical.coverage}`);
  L.push(`  achievable : ${cov.achievable.numerator} / ${cov.achievable.denominator} = ${cov.achievable.coverage === null ? "n/a" : cov.achievable.coverage}`);
  L.push("");
  L.push("diagnostics:");
  for (const [k, v] of Object.entries(result.diagnostics)) {
    L.push(`  ${k}: ${v}`);
  }
  return L.join("\n") + "\n";
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { store: defaultStoreRoot(), asOf: new Date().toISOString().slice(0, 10), out: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--store") args.store = argv[++i];
    else if (a === "--as-of") args.asOf = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--quiet") args.quiet = true;
  }
  return args;
}

function defaultArtifactPath(asOf) {
  // NOT scripts/eval/baselines/ — that directory is unconditionally swept by
  // run-bench.mjs's verifyAllBaselines(), which only understands
  // bench-result/v1 and rmr-baseline/v1|v2 schemas. This artifact's
  // "evolution-baseline/v1" schema is neither, so a foreign file dropped in
  // there fails verifyBaseline() and takes down `run-bench --corpus fixture`
  // (and its e2e test) with it. Sibling directory, not a subdirectory of
  // baselines/ — verifyAllBaselines() happens to use a non-recursive
  // fs.readdirSync() today, but a subdirectory placement would be corridor-
  // dependent on that implementation detail staying true forever.
  return path.join(__dirname, "evolution-baselines", `evolution-baseline-${asOf}.json`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = computeBaseline({ storeRoot: path.resolve(args.store), asOf: args.asOf });
  const outPath = args.out ? path.resolve(args.out) : defaultArtifactPath(args.asOf);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  if (!args.quiet) {
    process.stdout.write(renderTable(result));
    process.stdout.write(`\nartifact written: ${outPath}\n`);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main();
}
