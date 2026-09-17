// scripts/eval/evolution-baseline.test.mjs
//
// Fixture-based regression test for evolution-baseline.mjs (evolution P0 W3).
//
// Fixture store: scripts/eval/fixtures/evolution-baseline-store/
// Fixed --as-of: 2026-09-17 (Thursday, ISO week 2026-W38). Last 4 FULL ISO
// weeks are therefore 2026-W34..2026-W37 (2026-08-17 .. 2026-09-13); the
// as-of week (2026-W38) is always excluded.
//
// Every expected number below is hand-computed from the fixture's raw JSON /
// _outcomes.jsonl content (see brief p0-w3-baseline "hand-computed expected
// values" requirement) — walked through in the PR/report, not re-derived
// from the script under test.
//
// Run: node --test scripts/eval/evolution-baseline.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  computeBaseline,
  computeLast4FullIsoWeeks,
  computeLast28DayWindow,
  isoWeekLabel,
  KNOWN_OUTCOME_KINDS,
  VERDICT_KINDS,
  SCHEMA_VERSION,
} from "./evolution-baseline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "evolution-baseline.mjs");
const FIXTURE_STORE = path.join(HERE, "fixtures", "evolution-baseline-store");
// evolution p1c (v2): a SEPARATE fixture store, deliberately not merged into
// FIXTURE_STORE above — extending the v1 fixture's existing files/lines would
// perturb its own hand-computed diagnostics counts (projects_scanned,
// outcomes_lines_total, etc.) and the "other" bucket in outcome_events_per_week
// (cited/ignored/audit-recurred are NOT in v1's KNOWN_OUTCOME_KINDS, so any new
// such line landing in the v1 fixture's existing 4-week window would silently
// change the "other" tally the v1 test already asserts exact numbers for).
// Keeping v2 signals in their own store makes "v1 fixture untouched" a
// filesystem fact, not just a hoped-for invariant.
const FIXTURE_STORE_V2 = path.join(HERE, "fixtures", "evolution-baseline-store-v2");
const AS_OF = "2026-09-17";

// ---------------------------------------------------------------------------
// ISO week / date-window arithmetic
// ---------------------------------------------------------------------------

test("isoWeekLabel: 2026-09-17 (Thursday) falls in ISO week 2026-W38", () => {
  assert.equal(isoWeekLabel(new Date("2026-09-17T00:00:00.000Z")), "2026-W38");
});

test("computeLast4FullIsoWeeks: excludes the as-of (partial) week, oldest->newest", () => {
  const weeks = computeLast4FullIsoWeeks(new Date(`${AS_OF}T00:00:00.000Z`));
  assert.deepEqual(
    weeks.map((w) => w.iso_week),
    ["2026-W34", "2026-W35", "2026-W36", "2026-W37"]
  );
  assert.deepEqual(weeks[0], { iso_week: "2026-W34", start: "2026-08-17", end: "2026-08-23" });
  assert.deepEqual(weeks[3], { iso_week: "2026-W37", start: "2026-09-07", end: "2026-09-13" });
});

test("computeLast28DayWindow: inclusive [as_of-27, as_of]", () => {
  const w = computeLast28DayWindow(new Date(`${AS_OF}T00:00:00.000Z`));
  assert.deepEqual(w, { start: "2026-08-21", end: "2026-09-17" });
});

// ---------------------------------------------------------------------------
// Fixture end-to-end: every metric family against hand-computed values
// ---------------------------------------------------------------------------

test("computeBaseline on fixture store matches hand-computed values for all 5 metric families", () => {
  const result = computeBaseline({ storeRoot: FIXTURE_STORE, asOf: AS_OF });

  assert.equal(result.schema, SCHEMA_VERSION);
  assert.equal(result.as_of, AS_OF);
  assert.equal(result.generated_at, "2026-09-17T00:00:00.000Z");

  // (a) corrections captured per week, by provenance.
  // proj-alpha: c1 2026-08-18(W34,none) c2 2026-08-26(W35,told) c3 2026-09-10(W37,observed)
  //             c4 2026-09-16(W38 current-partial, EXCLUDED) c5 2026-07-01(too old, EXCLUDED)
  // proj-junk : good 2026-08-25(W35,none); corrupt.json is invalid JSON, EXCLUDED (diagnostics only)
  const a = result.metrics.corrections_captured_per_week;
  assert.deepEqual(a.map((w) => w.total), [1, 2, 0, 1]); // W34,W35,W36,W37
  assert.deepEqual(a[0].by_provenance, { none: 1, observed: 0, told: 0 }); // W34: c1
  assert.deepEqual(a[1].by_provenance, { none: 1, observed: 0, told: 1 }); // W35: good(none) + c2(told)
  assert.deepEqual(a[2].by_provenance, { none: 0, observed: 0, told: 0 }); // W36: nothing
  assert.deepEqual(a[3].by_provenance, { none: 0, observed: 1, told: 0 }); // W37: c3(observed)

  // (b) outcome events per week by kind — same 4-week window, ALL projects' _outcomes.jsonl.
  // W34: c1 retrieved+heeded (2). W35: c2 retrieved+unknown, good retrieved+heeded (4).
  // W36: c-kinds-test triggered/predicted/predict_hit/not_violated/not_triggered/unknown (6)
  //      + 1 bogus_future_kind event -> "other" bucket (1) = 7 total.
  // W37: c3 retrieved+heeded+unknown (3).
  const b = result.metrics.outcome_events_per_week;
  assert.deepEqual(b.map((w) => w.total), [2, 4, 7, 3]);
  assert.deepEqual(b[0].by_kind, {
    retrieved: 1, triggered: 0, heeded: 1, recurred: 0, not_violated: 0,
    unknown: 0, not_triggered: 0, predicted: 0, predict_hit: 0, other: 0,
  });
  assert.deepEqual(b[1].by_kind, {
    retrieved: 2, triggered: 0, heeded: 1, recurred: 0, not_violated: 0,
    unknown: 1, not_triggered: 0, predicted: 0, predict_hit: 0, other: 0,
  });
  assert.deepEqual(b[2].by_kind, {
    retrieved: 0, triggered: 1, heeded: 0, recurred: 0, not_violated: 1,
    unknown: 1, not_triggered: 1, predicted: 1, predict_hit: 1, other: 1,
  });
  assert.deepEqual(b[3].by_kind, {
    retrieved: 1, triggered: 0, heeded: 1, recurred: 0, not_violated: 0,
    unknown: 1, not_triggered: 0, predicted: 0, predict_hit: 0, other: 0,
  });
  // KNOWN_OUTCOME_KINDS is exhaustive per corrections.ts:224-225 (9 kinds); "other" is the
  // defensive catch-all this test exercises via the injected bogus_future_kind event.
  assert.equal(KNOWN_OUTCOME_KINDS.length, 9);

  // (c) verdict coverage — all-time, all projects. Denominator = distinct (project,id)
  // pairs with >=1 "retrieved" event: {alpha:c1, alpha:c2, alpha:c3, alpha:c4, junk:good} = 5.
  // (alpha:c5 has ZERO outcome events -> excluded; alpha:c-kinds-test has no "retrieved" event -> excluded.)
  //   c1: retrieved -> heeded (latest verdict = heeded)              => COVERED
  //   c2: retrieved -> unknown (latest verdict = unknown)            => NOT covered
  //   c3: retrieved -> heeded -> unknown (latest verdict = unknown)  => NOT covered (literal spec)
  //       but canonical presence-based formula (has "heeded") DOES count it => the documented divergence
  //   c4: retrieved -> heeded                                        => COVERED
  //   good: retrieved -> heeded                                      => COVERED
  // literal numerator = {c1, c4, good} = 3 -> 3/5 = 0.6
  // canonical numerator = {c1, c3, c4, good} = 4 -> 4/5 = 0.8
  const vc = result.metrics.verdict_coverage;
  assert.equal(vc.denominator, 5);
  assert.equal(vc.numerator, 3);
  assert.equal(vc.coverage, 0.6);
  assert.deepEqual([...VERDICT_KINDS].sort(), ["heeded", "not_triggered", "not_violated", "recurred", "unknown"]);
  assert.equal(vc.canonical_production_comparison.denominator, 5);
  assert.equal(vc.canonical_production_comparison.numerator, 4);
  assert.equal(vc.canonical_production_comparison.coverage, 0.8);
  // The literal-vs-canonical divergence is exactly 1 id (c3) — proves the two formulas are
  // NOT aliases of each other, i.e. the documented CHALLENGE divergence is real, not theoretical.
  assert.notEqual(vc.numerator, vc.canonical_production_comparison.numerator);

  // (d) distinct corrections retrieved in last 28 days [2026-08-21..2026-09-17].
  // c1's only retrieved event is 2026-08-19 (BEFORE the window) -> excluded.
  // c2(08-27), c3(09-11), c4(09-16), good(08-25) all fall inside -> 4.
  assert.equal(result.metrics.distinct_corrections_retrieved_last_28_days, 4);

  // (e) association edges — explicit constant.
  assert.equal(result.metrics.association_edges, 0);

  // Resilience diagnostics (constraint 4): corrupt files/lines counted, never thrown.
  const d = result.diagnostics;
  assert.equal(d.projects_scanned, 4); // alpha, junk-mega-slug, empty, no-corrections-dir
  assert.equal(d.projects_with_corrections_dir, 3); // empty HAS a corrections/ dir (just no files in it)
  assert.equal(d.projects_without_corrections_dir, 1); // proj-no-corrections-dir
  assert.equal(d.correction_json_files_found, 7); // alpha:5 + junk:2 (good.json + corrupt.json)
  assert.equal(d.correction_json_files_parsed_ok, 6);
  assert.equal(d.correction_json_files_corrupt_skipped, 1);
  assert.equal(d.correction_json_files_missing_date_skipped, 0);
  assert.equal(d.outcomes_files_found, 2); // alpha, junk
  assert.equal(d.outcomes_files_missing, 1); // proj-empty has a corrections/ dir but no _outcomes.jsonl
  assert.equal(d.outcomes_lines_total, 20); // alpha:17 (16 valid + 1 corrupt) + junk:3 (2 valid + 1 corrupt)
  assert.equal(d.outcomes_lines_parsed_ok, 18);
  assert.equal(d.outcomes_lines_corrupt_skipped, 2);
  assert.equal(d.outcomes_lines_invalid_timestamp_skipped, 0);
});

// ---------------------------------------------------------------------------
// Resilience: a store root that doesn't exist at all must not throw.
// ---------------------------------------------------------------------------

test("computeBaseline never throws on a missing store root", () => {
  const missing = path.join(os.tmpdir(), "evolution-baseline-does-not-exist-" + Date.now());
  const result = computeBaseline({ storeRoot: missing, asOf: AS_OF });
  assert.equal(result.diagnostics.store_projects_dir_exists, false);
  assert.equal(result.diagnostics.projects_scanned, 0);
  assert.equal(result.metrics.verdict_coverage.coverage, null);
  assert.equal(result.metrics.distinct_corrections_retrieved_last_28_days, 0);
});

test("computeBaseline rejects a malformed --as-of instead of silently misbehaving", () => {
  assert.throws(() => computeBaseline({ storeRoot: FIXTURE_STORE, asOf: "not-a-date" }));
});

// ---------------------------------------------------------------------------
// Determinism (constraint 2): two consecutive CLI runs against the fixture
// store, same --as-of, must produce a byte-identical JSON artifact.
// ---------------------------------------------------------------------------

test("CLI: two consecutive runs against the fixture store are byte-identical", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evolution-baseline-determinism-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const out1 = path.join(tmpDir, "run1.json");
  const out2 = path.join(tmpDir, "run2.json");
  execFileSync("node", [SCRIPT, "--store", FIXTURE_STORE, "--as-of", AS_OF, "--out", out1, "--quiet"]);
  execFileSync("node", [SCRIPT, "--store", FIXTURE_STORE, "--as-of", AS_OF, "--out", out2, "--quiet"]);

  const buf1 = fs.readFileSync(out1);
  const buf2 = fs.readFileSync(out2);
  assert.ok(buf1.equals(buf2), "artifact bytes differ between two consecutive runs");

  const parsed = JSON.parse(buf1.toString("utf-8"));
  assert.equal(parsed.generated_at, "2026-09-17T00:00:00.000Z"); // derived from --as-of, not wall clock
});

// ---------------------------------------------------------------------------
// Key order determinism: JSON.stringify must produce the same key order
// across two independent computeBaseline() calls (constraint 2).
// ---------------------------------------------------------------------------

test("computeBaseline output has stable key order across repeated calls", () => {
  const r1 = computeBaseline({ storeRoot: FIXTURE_STORE, asOf: AS_OF });
  const r2 = computeBaseline({ storeRoot: FIXTURE_STORE, asOf: AS_OF });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

// ===========================================================================
// evolution p1c — schema evolution-baseline/v2 (additive):
//   (f) cited/ignored/audit-recurred events per week (same 4-week window)
//   (g) injection_precision = cited/(cited+ignored), null when denom 0
//   (h) implicit-correction counts (provenance.mode === "observed"), total
//       (all-time) and per-week, keyed by provenance.source
//   (i) injection-outcome coverage, dual denominators (theoretical/achievable)
// ===========================================================================

test("schema bumps to evolution-baseline/v2", () => {
  assert.equal(SCHEMA_VERSION, "evolution-baseline/v2");
});

// ---------------------------------------------------------------------------
// v1 fixture (UNTOUCHED — see FIXTURE_STORE_V2 comment above) must still
// produce well-formed v2 fields: zero counts / null ratios, never a crash.
// This is the "byte-identical for a store with no v2 signals" proof the
// brief's CHALLENGE clause asks for, applied to the additive (non-refactor)
// fields — every v1 metric value asserted in the test above is unchanged
// (same computeBaseline() call, same fixture bytes, same numbers), and the
// new v2 fields degrade to their documented "uncomputable" defaults.
// ---------------------------------------------------------------------------

test("v2 fields on the v1 (no v2 signals) fixture: all-zero / null, never crash", () => {
  const result = computeBaseline({ storeRoot: FIXTURE_STORE, asOf: AS_OF });

  for (const w of result.metrics.transcript_audit_events_per_week) {
    assert.equal(w.cited, 0);
    assert.equal(w.ignored, 0);
    assert.equal(w.audit_recurred, 0);
  }
  assert.equal(result.metrics.injection_precision.cited, 0);
  assert.equal(result.metrics.injection_precision.ignored, 0);
  assert.equal(result.metrics.injection_precision.precision, null); // denom 0 -> null, never 0

  // NOTE: the v1 fixture's c3 (2026-09-10, W37) DOES carry
  // provenance={source:"session-id-xyz",mode:"observed"} (see the (a)
  // hand-computed comment above) — that's a real "no v2 CODE changed
  // behavior" signal, not a v2-only fixture concern. (h)'s definition
  // (mode==="observed") picks it up correctly, proving (h) is not
  // accidentally gated on any v2-only fixture data.
  assert.deepEqual(result.metrics.implicit_corrections.total_by_source, { "session-id-xyz": 1 });
  assert.deepEqual(
    result.metrics.implicit_corrections.per_week.map((w) => w.by_source),
    [{ "session-id-xyz": 0 }, { "session-id-xyz": 0 }, { "session-id-xyz": 0 }, { "session-id-xyz": 1 }],
  );

  assert.equal(result.metrics.injection_outcome_coverage.theoretical.denominator, 5);
  assert.equal(result.metrics.injection_outcome_coverage.theoretical.numerator, 0);
  assert.equal(result.metrics.injection_outcome_coverage.theoretical.coverage, 0);
  assert.equal(result.metrics.injection_outcome_coverage.achievable.denominator, 0);
  assert.equal(result.metrics.injection_outcome_coverage.achievable.numerator, 0);
  assert.equal(result.metrics.injection_outcome_coverage.achievable.coverage, null); // denom 0 -> null, never 0
});

// ---------------------------------------------------------------------------
// Fixture end-to-end (v2 signals): every new metric family against
// hand-computed values. Store: fixtures/evolution-baseline-store-v2/
// (single project "proj-v2"). Walked through in the worker report, not
// re-derived from the script under test.
// ---------------------------------------------------------------------------

test("computeBaseline on the v2-signal fixture matches hand-computed values for (f)/(g)/(h)/(i)", () => {
  const result = computeBaseline({ storeRoot: FIXTURE_STORE_V2, asOf: AS_OF });

  // (f) transcript-audit events per week — W34..W37.
  // D1=08-18(W34) cA cited; D2=08-19(W34) cB audit-recurred;
  // D4=08-26(W35) cA ignored; D5=09-05(W36) cA PLAIN recurred (evidence
  // "session-end:..." — NOT "transcript-audit:" prefixed) must NOT count.
  const f = result.metrics.transcript_audit_events_per_week;
  assert.deepEqual(
    f.map((w) => [w.cited, w.ignored, w.audit_recurred]),
    [
      [1, 0, 1], // W34: cA cited (D1) + cB audit-recurred (D2)
      [0, 1, 0], // W35: cA ignored (D4)
      [0, 0, 0], // W36: cA's D5 recurred is plain, excluded
      [0, 0, 0], // W37: nothing
    ],
  );

  // (g) injection_precision = cited/(cited+ignored) over the SAME 4-week
  // window as (f): cited=1 (D1), ignored=1 (D4) -> 1/2 = 0.5.
  const g = result.metrics.injection_precision;
  assert.equal(g.cited, 1);
  assert.equal(g.ignored, 1);
  assert.equal(g.precision, 0.5);

  // (h) implicit corrections (provenance.mode === "observed"), keyed by
  // provenance.source. imp1(08-18,W34,transcript-implicit) imp2(08-27,W35,
  // transcript-implicit) imp3(09-10,W37,dream-implicit-audit)
  // imp4(09-16,W38 CURRENT PARTIAL, transcript-implicit) — excluded from
  // per_week, included in the all-time total. told1(mode=told) and
  // c-no-prov(no provenance) are negative cases, excluded entirely.
  const h = result.metrics.implicit_corrections;
  assert.deepEqual(h.total_by_source, { "dream-implicit-audit": 1, "transcript-implicit": 3 });
  assert.deepEqual(
    h.per_week.map((w) => w.by_source),
    [
      { "dream-implicit-audit": 0, "transcript-implicit": 1 }, // W34: imp1
      { "dream-implicit-audit": 0, "transcript-implicit": 1 }, // W35: imp2
      { "dream-implicit-audit": 0, "transcript-implicit": 0 }, // W36: nothing
      { "dream-implicit-audit": 1, "transcript-implicit": 0 }, // W37: imp3
    ],
  );
  // total (3) != sum of the windowed per_week transcript-implicit column (2)
  // -- imp4 falls in the excluded current-partial week but still counts
  // toward the all-time total. Proves total is NOT window-limited.
  const perWeekTranscriptImplicitSum = h.per_week.reduce((a, w) => a + w.by_source["transcript-implicit"], 0);
  assert.equal(h.total_by_source["transcript-implicit"], 3);
  assert.equal(perWeekTranscriptImplicitSum, 2);
  assert.notEqual(h.total_by_source["transcript-implicit"], perWeekTranscriptImplicitSum);

  // (i) injection-outcome coverage, ALL-TIME (not window-limited), dual
  // denominators. retrievedPairs = {cA/D1, cB/D2, cC/D3, cA/D4, cD/D4} = 5.
  //   cA/D1 -> covered (cited D1)          cB/D2 -> covered (audit-recurred D2)
  //   cC/D3 -> NOT covered, D3 has ZERO transcript-audit evidence anywhere
  //           (proj-v2 or otherwise) -> excluded from ACHIEVABLE denominator
  //   cA/D4 -> covered (ignored D4)         cD/D4 -> NOT covered, but D4 IS
  //           globally audited (via cA's ignored event) -> INCLUDED in
  //           achievable denominator as a real, uncovered gap.
  // theoretical = 3/5 = 0.6.  achievable = 3/4 = 0.75 (cC/D3 dropped from
  // the denominator; numerator unchanged since every covered pair's day is
  // trivially globally-audited by construction).
  const i = result.metrics.injection_outcome_coverage;
  assert.equal(i.theoretical.denominator, 5);
  assert.equal(i.theoretical.numerator, 3);
  assert.equal(i.theoretical.coverage, 0.6);
  assert.equal(i.achievable.denominator, 4);
  assert.equal(i.achievable.numerator, 3);
  assert.equal(i.achievable.coverage, 0.75);
  // Achievable is strictly the more generous number here (excludes an
  // unauditable day) — proves the two denominators are NOT aliases.
  assert.notEqual(i.theoretical.coverage, i.achievable.coverage);
  assert.ok(i.achievable.coverage > i.theoretical.coverage);
});

// ---------------------------------------------------------------------------
// Determinism on the v2-signal fixture too (constraint 3): two consecutive
// CLI runs must produce a byte-identical artifact.
// ---------------------------------------------------------------------------

test("CLI: two consecutive runs against the v2-signal fixture store are byte-identical", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evolution-baseline-v2-determinism-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const out1 = path.join(tmpDir, "run1.json");
  const out2 = path.join(tmpDir, "run2.json");
  execFileSync("node", [SCRIPT, "--store", FIXTURE_STORE_V2, "--as-of", AS_OF, "--out", out1, "--quiet"]);
  execFileSync("node", [SCRIPT, "--store", FIXTURE_STORE_V2, "--as-of", AS_OF, "--out", out2, "--quiet"]);

  const buf1 = fs.readFileSync(out1);
  const buf2 = fs.readFileSync(out2);
  assert.ok(buf1.equals(buf2), "artifact bytes differ between two consecutive runs (v2-signal fixture)");
});
