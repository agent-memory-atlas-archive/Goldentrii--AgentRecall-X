/**
 * retier.test.mjs — evolution p4 (soft-constraint ladder), `ar corrections
 * retier`'s core module (tools-logic/retier.ts).
 *
 * Coverage:
 *   1. HAND-TUNED constants pinned to their documented values.
 *   2. tierOf() truth table — hand-computed, including the two explicit
 *      cold-start rows (fresh p0 → nudge, fresh p1 → watch) and boundary
 *      (inclusive) rows for every threshold.
 *   3. stepDownTier() ladder.
 *   4. demotionOf() triggers — RED (no trigger) → GREEN (trigger fires) for
 *      each of the two triggers, plus the watch-floor short-circuit.
 *   5. archiveCandidates / promoteToGateCandidates as PURE proposal lists.
 *   6. runRetier() integration: cross-project dry-run table, --write
 *      persistence via the sanctioned setCorrectionTier path, idempotency
 *      (second --write changes zero records), demotion pulling a record
 *      below its raw gate formula, --store root-swap-and-restore (proves
 *      the ambient global root is untouched after the call), and proof
 *      that a --write run never applies/mutates the proposal lists.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Pure-function tests need no fixture root at all — load once at module
// scope (top-level await, established convention — see e.g.
// auto-name.test.mjs). The integration describe() below re-imports via
// dynamic import in beforeEach AFTER AGENT_RECALL_ROOT is set, matching
// export-corrections.test.mjs's convention (module-level cache would
// otherwise pin the FIRST root ever set for storage-layer modules).
const retierPure = await import("../dist/tools-logic/retier.js");

let retier;
let corr;
let typesMod;
let TEST_ROOT;

const AS_OF = "2026-09-17";
const PROJECT_A = "retier-proj-a";
const PROJECT_B = "retier-proj-b";

function correctionsDirFor(root, slug) {
  return path.join(root, "projects", slug, "corrections");
}

/** Write a minimal correction JSON file straight into a project's seeded store — mirrors export-corrections.test.mjs's convention. */
function seed(root, slug, rec) {
  const dir = correctionsDirFor(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec), "utf-8");
}

function readBack(root, slug, id) {
  const dir = correctionsDirFor(root, slug);
  const file = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .find((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")).id === id);
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
}

describe("retier — pure formulas (no I/O)", () => {
  const retier = retierPure;

  it("HAND-TUNED constants match the documented v1 formula", () => {
    assert.equal(retier.GATE_MIN_PROOF_CONFIDENCE, 0.7);
    assert.equal(retier.GATE_RETRIEVED_WITHIN_DAYS, 30);
    assert.equal(retier.NUDGE_P1_MIN_PROOF_CONFIDENCE, 0.6);
    assert.equal(retier.NUDGE_RETRIEVED_WITHIN_DAYS, 60);
    assert.equal(retier.DEMOTE_NOT_VIOLATED_MIN, 3);
    assert.equal(retier.DEMOTE_RETRIEVAL_STALE_DAYS, 90);
    assert.equal(retier.ARCHIVE_STALE_DAYS, 180);
  });

  describe("tierOf — truth table", () => {
    const rows = [
      // [label, record, expectedTier]
      ["p0 high-confidence retrieved 7d ago -> gate",
        { severity: "p0", proof_confidence: 0.9, last_retrieved: "2026-09-10T00:00:00Z" }, "gate"],
      ["p0 low-confidence retrieved 7d ago -> nudge (fails gate's confidence clause)",
        { severity: "p0", proof_confidence: 0.5, last_retrieved: "2026-09-10T00:00:00Z" }, "nudge"],
      ["p0 high-confidence retrieved 78d ago -> nudge (fails gate's recency clause)",
        { severity: "p0", proof_confidence: 0.9, last_retrieved: "2026-07-01T00:00:00Z" }, "nudge"],
      ["COLD-START: fresh p0 (never retrieved) -> nudge, regardless of confidence",
        { severity: "p0", proof_confidence: 0.5, last_retrieved: undefined }, "nudge"],
      ["p1 confidence 0.8 retrieved 7d ago -> nudge",
        { severity: "p1", proof_confidence: 0.8, last_retrieved: "2026-09-10T00:00:00Z" }, "nudge"],
      ["p1 confidence 0.5 (below 0.6) retrieved 7d ago -> watch",
        { severity: "p1", proof_confidence: 0.5, last_retrieved: "2026-09-10T00:00:00Z" }, "watch"],
      ["p1 confidence 0.8 retrieved 108d ago -> watch (fails nudge's recency clause)",
        { severity: "p1", proof_confidence: 0.8, last_retrieved: "2026-06-01T00:00:00Z" }, "watch"],
      ["COLD-START: fresh p1 (never retrieved) -> watch",
        { severity: "p1", proof_confidence: 0.5, last_retrieved: undefined }, "watch"],
      ["DEFENSIVE fallback: p0 with no proof_confidence/weight at all -> uses severity prior (1.0) -> gate",
        { severity: "p0", last_retrieved: "2026-09-10T00:00:00Z" }, "gate"],
      ["DEFENSIVE fallback: proof_confidence absent, weight present -> uses weight",
        { severity: "p1", weight: 0.9, last_retrieved: "2026-09-10T00:00:00Z" }, "nudge"],
      ["boundary: p0 confidence EXACTLY 0.7 retrieved EXACTLY 30d ago -> gate (inclusive)",
        { severity: "p0", proof_confidence: 0.7, last_retrieved: "2026-08-18T00:00:00Z" }, "gate"],
      ["boundary: p0 confidence 0.7 retrieved 31d ago -> nudge (just over the window)",
        { severity: "p0", proof_confidence: 0.7, last_retrieved: "2026-08-17T00:00:00Z" }, "nudge"],
      ["boundary: p1 confidence EXACTLY 0.6 retrieved EXACTLY 60d ago -> nudge (inclusive)",
        { severity: "p1", proof_confidence: 0.6, last_retrieved: "2026-07-19T00:00:00Z" }, "nudge"],
      ["boundary: p1 confidence 0.6 retrieved 61d ago -> watch (just over the window)",
        { severity: "p1", proof_confidence: 0.6, last_retrieved: "2026-07-18T00:00:00Z" }, "watch"],
    ];
    for (const [label, record, expected] of rows) {
      it(label, () => {
        assert.equal(retier.tierOf(record, AS_OF), expected);
      });
    }
  });

  describe("stepDownTier — the ladder", () => {
    it("gate -> nudge", () => assert.equal(retier.stepDownTier("gate"), "nudge"));
    it("nudge -> watch", () => assert.equal(retier.stepDownTier("nudge"), "watch"));
    it("watch -> watch (floor)", () => assert.equal(retier.stepDownTier("watch"), "watch"));
  });

  describe("demotionOf — triggers", () => {
    it("RED: not_violated_count below the threshold never triggers not_violated_plateau", () => {
      const triggers = retier.demotionOf(
        { not_violated_count: 2, heeded_count: 0, recurrence_count: 0, last_retrieved: AS_OF, date: "2026-01-01" },
        "gate", AS_OF,
      );
      assert.deepEqual(triggers, []);
    });
    it("GREEN: not_violated_count >= 3 with zero heeded/recurred triggers not_violated_plateau", () => {
      const triggers = retier.demotionOf(
        { not_violated_count: 3, heeded_count: 0, recurrence_count: 0, last_retrieved: AS_OF, date: "2026-01-01" },
        "gate", AS_OF,
      );
      assert.deepEqual(triggers, ["not_violated_plateau"]);
    });
    it("RED: not_violated_count >= 3 but heeded_count > 0 does NOT trigger (documented lifetime-zero approximation)", () => {
      const triggers = retier.demotionOf(
        { not_violated_count: 5, heeded_count: 1, recurrence_count: 0, last_retrieved: AS_OF, date: "2026-01-01" },
        "gate", AS_OF,
      );
      assert.deepEqual(triggers, []);
    });
    it("RED: retrieved 89d ago does not trigger retrieval_stale_90d", () => {
      const triggers = retier.demotionOf(
        { not_violated_count: 0, heeded_count: 0, recurrence_count: 0, last_retrieved: "2026-06-20T00:00:00Z", date: "2026-01-01" },
        "gate", AS_OF,
      );
      assert.deepEqual(triggers, []);
    });
    it("GREEN: retrieved exactly 90d ago triggers retrieval_stale_90d (inclusive)", () => {
      const triggers = retier.demotionOf(
        { not_violated_count: 0, heeded_count: 0, recurrence_count: 0, last_retrieved: "2026-06-19T00:00:00Z", date: "2026-01-01" },
        "gate", AS_OF,
      );
      assert.deepEqual(triggers, ["retrieval_stale_90d"]);
    });
    it("GREEN: never retrieved, created 91d ago (record.date anchor) triggers retrieval_stale_90d", () => {
      const triggers = retier.demotionOf(
        { not_violated_count: 0, heeded_count: 0, recurrence_count: 0, last_retrieved: undefined, date: "2026-06-18" },
        "nudge", AS_OF,
      );
      assert.deepEqual(triggers, ["retrieval_stale_90d"]);
    });
    it("RED: never retrieved but created only 5d ago does NOT trigger (no 90-day window has elapsed yet)", () => {
      const triggers = retier.demotionOf(
        { not_violated_count: 0, heeded_count: 0, recurrence_count: 0, last_retrieved: undefined, date: "2026-09-12" },
        "nudge", AS_OF,
      );
      assert.deepEqual(triggers, []);
    });
    it("watch is the floor: demotionOf always returns [] for currentTier='watch', even with both triggers' conditions met", () => {
      const triggers = retier.demotionOf(
        { not_violated_count: 10, heeded_count: 0, recurrence_count: 0, last_retrieved: undefined, date: "2020-01-01" },
        "watch", AS_OF,
      );
      assert.deepEqual(triggers, []);
    });
  });

  describe("archiveCandidates / promoteToGateCandidates — pure proposal lists", () => {
    it("archiveCandidates: a watch-tier record with zero touches for >=180d is a candidate", () => {
      const record = {
        project: "p", id: "old-watch", rule: "an old dormant p1 rule",
        severity: "p1", proof_confidence: 0.5, date: "2026-03-21",
      };
      const out = retier.archiveCandidates([record], AS_OF);
      assert.equal(out.length, 1);
      assert.equal(out[0].id, "old-watch");
      assert.equal(out[0].last_touch, null); // never touched — falls back to record.date, reported as null
    });
    it("archiveCandidates: a watch-tier record touched recently is NOT a candidate", () => {
      const record = {
        project: "p", id: "fresh-watch", rule: "a recent p1 rule",
        severity: "p1", proof_confidence: 0.5, date: "2026-03-21", last_retrieved: "2026-09-10T00:00:00Z",
      };
      assert.deepEqual(retier.archiveCandidates([record], AS_OF), []);
    });
    it("REGRESSION (found live, 2026-09-17): a malformed record with NO `date` field at all (violates the required-string contract) never crashes archiveCandidates — degrades to not-a-candidate rather than throwing", () => {
      // Reproduces packages/core/... /projects/probe-proj/corrections/
      // undefined--*.json on the live store: date is entirely absent, no
      // last_retrieved/last_outcome/last_predicted either — a watch-tier
      // record with ZERO anchors of any kind. Pre-fix this threw
      // "Cannot read properties of undefined (reading 'slice')".
      const record = {
        project: "probe-proj", id: "corr-a", rule: "malformed — no date field",
        severity: "p1", proof_confidence: 0.7,
        // `date` deliberately omitted — TS's required `string` says this
        // can't happen; real on-disk data proved otherwise.
      };
      assert.doesNotThrow(() => retier.archiveCandidates([record], AS_OF));
      assert.deepEqual(retier.archiveCandidates([record], AS_OF), [], "no anchor at all -> cannot judge staleness -> not a candidate, not a crash");
      assert.doesNotThrow(() => retier.demotionOf(record, "watch", AS_OF));
      assert.equal(retier.tierOf(record, AS_OF), "watch");
    });

    it("archiveCandidates: a gate/nudge-tier record is NEVER a candidate regardless of staleness", () => {
      const record = {
        project: "p", id: "old-gate", rule: "an old but still gate-qualifying rule",
        severity: "p0", proof_confidence: 0.95, date: "2020-01-01", last_retrieved: "2026-09-10T00:00:00Z",
      };
      assert.deepEqual(retier.archiveCandidates([record], AS_OF), []);
    });
    it("promoteToGateCandidates: a record meeting the gate formula whose stored tier is NOT yet 'gate' is a candidate", () => {
      const record = {
        project: "p", id: "ready-for-gate", rule: "a p0 rule that now qualifies",
        severity: "p0", proof_confidence: 0.9, date: "2026-01-01", last_retrieved: "2026-09-10T00:00:00Z",
        tier: "nudge",
      };
      const out = retier.promoteToGateCandidates([record], AS_OF);
      assert.equal(out.length, 1);
      assert.equal(out[0].id, "ready-for-gate");
    });
    it("promoteToGateCandidates: a record already stored as 'gate' is NOT re-proposed", () => {
      const record = {
        project: "p", id: "already-gate", rule: "already gate",
        severity: "p0", proof_confidence: 0.9, date: "2026-01-01", last_retrieved: "2026-09-10T00:00:00Z",
        tier: "gate",
      };
      assert.deepEqual(retier.promoteToGateCandidates([record], AS_OF), []);
    });
    it("promoteToGateCandidates: a p1 record can never appear (gate is severity-gated to p0)", () => {
      const record = {
        project: "p", id: "p1-cannot-gate", rule: "a p1 rule, however strong its evidence",
        severity: "p1", proof_confidence: 1.0, date: "2026-01-01", last_retrieved: "2026-09-10T00:00:00Z",
      };
      assert.deepEqual(retier.promoteToGateCandidates([record], AS_OF), []);
    });

    it("REGRESSION (found in review, 2026-09-17): a record meeting the RAW gate formula but with an ACTIVE demotion trigger is NOT a promotion candidate — must not contradict runRetier's own final_tier", () => {
      // Exact repro fixture from the finding: p0, proof_confidence 0.9,
      // last_retrieved 7d ago, not_violated_count:5 / heeded:0 / recurrence:0.
      // tierOf() alone says "gate"; demotionOf() fires
      // "not_violated_plateau" for this same record, so runRetier's row
      // would show final_tier:"nudge" — promoteToGateCandidates must agree,
      // not recommend promoting it.
      const record = {
        project: "p", id: "gate-but-demoted", rule: "p0 rule with a not_violated plateau",
        severity: "p0", proof_confidence: 0.9, date: "2026-01-01",
        last_retrieved: "2026-09-10T00:00:00Z",
        not_violated_count: 5, heeded_count: 0, recurrence_count: 0,
        // tier deliberately absent/below gate — this is exactly the case
        // the (unfixed) function would have flagged as "should promote".
      };
      assert.equal(retier.tierOf(record, AS_OF), "gate", "raw formula alone says gate");
      assert.deepEqual(
        retier.demotionOf(record, "gate", AS_OF),
        ["not_violated_plateau"],
        "and this same record has an active demotion trigger",
      );
      assert.deepEqual(
        retier.promoteToGateCandidates([record], AS_OF),
        [],
        "a demotion-triggered record must never appear in promote_to_gate_candidates",
      );
    });
  });
});

describe("retier — runRetier() integration (fixture store, filesystem)", () => {
  beforeEach(async () => {
    TEST_ROOT = path.join(
      os.tmpdir(),
      "ar-retier-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2),
    );
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;

    typesMod = await import("../dist/types.js");
    typesMod.resetRoot();
    typesMod.setRoot(TEST_ROOT);

    retier = await import("../dist/tools-logic/retier.js");
    corr = await import("../dist/storage/corrections.js");
  });

  afterEach(() => {
    typesMod.resetRoot();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("dry-run: computes the full table across projects and writes NOTHING to disk", async () => {
    seed(TEST_ROOT, PROJECT_A, {
      id: "a-gate", date: "2026-09-01", severity: "p0", project: PROJECT_A,
      rule: "gate-qualifying p0", context: "ctx", tags: [], active: true, kind: "correction",
      weight: 1.0, proof_confidence: 0.9, last_retrieved: "2026-09-10T00:00:00Z",
    });
    seed(TEST_ROOT, PROJECT_B, {
      id: "b-watch", date: "2026-09-01", severity: "p1", project: PROJECT_B,
      rule: "watch-tier p1", context: "ctx", tags: [], active: true, kind: "correction",
      weight: 0.5, proof_confidence: 0.4,
    });

    const beforeA = fs.readFileSync(path.join(correctionsDirFor(TEST_ROOT, PROJECT_A), "a-gate.json"), "utf-8");
    const beforeB = fs.readFileSync(path.join(correctionsDirFor(TEST_ROOT, PROJECT_B), "b-watch.json"), "utf-8");

    const result = await retier.runRetier({ asOfDay: AS_OF });

    assert.equal(result.dry_run, true);
    assert.equal(result.projects_scanned, 2);
    assert.equal(result.rows.length, 2);
    assert.equal(result.written, 0);
    const rowA = result.rows.find((r) => r.id === "a-gate");
    const rowB = result.rows.find((r) => r.id === "b-watch");
    assert.equal(rowA.computed_tier, "gate");
    assert.equal(rowA.stored_tier, null);
    assert.equal(rowB.computed_tier, "watch");
    assert.equal(result.tier_distribution.gate, 1);
    assert.equal(result.tier_distribution.watch, 1);
    assert.equal(result.tier_distribution.nudge, 0);

    // MARKER PROBE — read-only proof: the on-disk bytes are byte-identical
    // after a --dry-run call (no lock file residue, no tier field written).
    const afterA = fs.readFileSync(path.join(correctionsDirFor(TEST_ROOT, PROJECT_A), "a-gate.json"), "utf-8");
    const afterB = fs.readFileSync(path.join(correctionsDirFor(TEST_ROOT, PROJECT_B), "b-watch.json"), "utf-8");
    assert.equal(afterA, beforeA, "dry-run must not touch project A's file bytes");
    assert.equal(afterB, beforeB, "dry-run must not touch project B's file bytes");
    assert.ok(!JSON.parse(afterA).tier, "dry-run must not persist a tier field");
  });

  it("--write persists the computed tier via setCorrectionTier, and a second --write run is a no-op (idempotent)", async () => {
    seed(TEST_ROOT, PROJECT_A, {
      id: "a-gate", date: "2026-09-01", severity: "p0", project: PROJECT_A,
      rule: "gate-qualifying p0", context: "ctx", tags: [], active: true, kind: "correction",
      weight: 1.0, proof_confidence: 0.9, last_retrieved: "2026-09-10T00:00:00Z",
    });

    const first = await retier.runRetier({ asOfDay: AS_OF, write: true });
    assert.equal(first.written, 1);
    const persisted = readBack(TEST_ROOT, PROJECT_A, "a-gate");
    assert.equal(persisted.tier, "gate");
    // Every other field survives byte-for-byte (additive write only).
    assert.equal(persisted.rule, "gate-qualifying p0");
    assert.equal(persisted.proof_confidence, 0.9);

    function correctionFilePathFor(id) {
      const dir = correctionsDirFor(TEST_ROOT, PROJECT_A);
      const file = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .find((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")).id === id);
      return path.join(dir, file);
    }

    const mtimeAfterFirstWrite = fs.statSync(correctionFilePathFor("a-gate")).mtimeMs;

    const second = await retier.runRetier({ asOfDay: AS_OF, write: true });
    assert.equal(second.written, 0, "second --write run over unchanged inputs must persist zero records");

    const mtimeAfterSecondWrite = fs.statSync(correctionFilePathFor("a-gate")).mtimeMs;
    assert.equal(mtimeAfterSecondWrite, mtimeAfterFirstWrite, "no-op write must not even rewrite the file");
  });

  it("demotion pulls a record's persisted tier BELOW the raw gate formula", async () => {
    // Meets the raw gate formula (p0, high confidence, retrieved recently)
    // but has accrued a not_violated plateau with zero heeded/recurred.
    seed(TEST_ROOT, PROJECT_A, {
      id: "a-demoted", date: "2026-01-01", severity: "p0", project: PROJECT_A,
      rule: "p0 rule going stale via not_violated plateau", context: "ctx", tags: [], active: true, kind: "correction",
      weight: 1.0, proof_confidence: 0.9, last_retrieved: "2026-09-10T00:00:00Z",
      not_violated_count: 4, heeded_count: 0, recurrence_count: 0,
    });

    const result = await retier.runRetier({ asOfDay: AS_OF, write: true });
    const row = result.rows.find((r) => r.id === "a-demoted");
    assert.equal(row.computed_tier, "gate", "raw formula alone would say gate");
    assert.deepEqual(row.triggers, ["not_violated_plateau"]);
    assert.equal(row.final_tier, "nudge", "demotion steps it down exactly one notch");

    const persisted = readBack(TEST_ROOT, PROJECT_A, "a-demoted");
    assert.equal(persisted.tier, "nudge", "the DEMOTED tier is what --write persists, not the raw formula's");
  });

  it("REGRESSION (found in review, 2026-09-17): a demoted record's own row (final_tier:'nudge') must NOT also appear in promote_to_gate_candidates — in BOTH --dry-run and --write", async () => {
    seed(TEST_ROOT, PROJECT_A, {
      id: "a-demoted-2", date: "2026-01-01", severity: "p0", project: PROJECT_A,
      rule: "p0 rule going stale via not_violated plateau", context: "ctx", tags: [], active: true, kind: "correction",
      weight: 1.0, proof_confidence: 0.9, last_retrieved: "2026-09-10T00:00:00Z",
      not_violated_count: 5, heeded_count: 0, recurrence_count: 0,
    });

    const dry = await retier.runRetier({ asOfDay: AS_OF });
    const dryRow = dry.rows.find((r) => r.id === "a-demoted-2");
    assert.equal(dryRow.computed_tier, "gate");
    assert.deepEqual(dryRow.triggers, ["not_violated_plateau"]);
    assert.equal(dryRow.final_tier, "nudge");
    assert.ok(
      !dry.promote_to_gate_candidates.some((c) => c.id === "a-demoted-2"),
      "dry-run: the tool's own demotion pass excluded this record from gate — promote_to_gate_candidates must agree",
    );

    const written = await retier.runRetier({ asOfDay: AS_OF, write: true });
    const writtenRow = written.rows.find((r) => r.id === "a-demoted-2");
    assert.equal(writtenRow.final_tier, "nudge");
    assert.ok(
      !written.promote_to_gate_candidates.some((c) => c.id === "a-demoted-2"),
      "--write: same self-contradiction must not appear here either",
    );
    assert.equal(readBack(TEST_ROOT, PROJECT_A, "a-demoted-2").tier, "nudge");
  });

  it("REGRESSION (found in review, 2026-09-17): a record --write JUST persisted to 'gate' this same call must NOT still be listed in promote_to_gate_candidates as pending", async () => {
    seed(TEST_ROOT, PROJECT_A, {
      id: "a-fresh-gate", date: "2026-09-01", severity: "p0", project: PROJECT_A,
      rule: "a fresh gate-qualifying p0 rule", context: "ctx", tags: [], active: true, kind: "correction",
      weight: 1.0, proof_confidence: 0.9, last_retrieved: "2026-09-10T00:00:00Z",
    });

    const result = await retier.runRetier({ asOfDay: AS_OF, write: true });
    const row = result.rows.find((r) => r.id === "a-fresh-gate");
    assert.equal(row.final_tier, "gate");
    assert.equal(result.written, 1, "this call actually persisted the tier");
    assert.ok(
      !result.promote_to_gate_candidates.some((c) => c.id === "a-fresh-gate"),
      "a record this SAME call just wrote to gate must not simultaneously be reported as still-pending promotion",
    );
    assert.equal(readBack(TEST_ROOT, PROJECT_A, "a-fresh-gate").tier, "gate");
  });

  it("retracted (active:false) records are excluded from the table, demotion, and every proposal list", async () => {
    seed(TEST_ROOT, PROJECT_A, {
      id: "a-retracted", date: "2026-01-01", severity: "p0", project: PROJECT_A,
      rule: "a retracted rule", context: "ctx", tags: [], active: false, kind: "correction",
      weight: 1.0, proof_confidence: 0.9, last_retrieved: "2026-09-10T00:00:00Z",
    });
    const result = await retier.runRetier({ asOfDay: AS_OF });
    assert.equal(result.rows.length, 0);
    assert.equal(result.promote_to_gate_candidates.length, 0);
    assert.equal(result.archive_candidates.length, 0);
  });

  it("a --write run NEVER applies archive/promote-to-gate proposals — they remain proposal-only after --write", async () => {
    // Watch-tier, 200d dormant -> archive candidate. --write must not
    // retract it, flip `active`, or otherwise mutate it beyond `tier`.
    seed(TEST_ROOT, PROJECT_A, {
      id: "a-archivable", date: "2026-03-01", severity: "p1", project: PROJECT_A,
      rule: "a long-dormant p1 rule", context: "ctx", tags: [], active: true, kind: "correction",
      weight: 0.5, proof_confidence: 0.4,
    });

    const result = await retier.runRetier({ asOfDay: AS_OF, write: true });
    assert.equal(result.archive_candidates.length, 1);
    assert.equal(result.archive_candidates[0].id, "a-archivable");

    const persisted = readBack(TEST_ROOT, PROJECT_A, "a-archivable");
    assert.equal(persisted.active, true, "--write must never retract an archive candidate");
    assert.equal(persisted.tier, "watch", "the ONLY field --write touches is tier");

    // Running again still reports it as a candidate — the proposal list is
    // not consumed/cleared by a prior --write having "seen" it.
    const again = await retier.runRetier({ asOfDay: AS_OF });
    assert.equal(again.archive_candidates.length, 1);
  });

  it("--store swaps the root for the call only, then restores the PRIOR root (association.ts-style safety, but for a call that DOES need to mutate)", async () => {
    // Ambient global root points at a DECOY dir with different content.
    const decoyRoot = path.join(TEST_ROOT, "decoy");
    fs.mkdirSync(decoyRoot, { recursive: true });
    seed(decoyRoot, "decoy-proj", {
      id: "decoy-record", date: "2026-01-01", severity: "p1", project: "decoy-proj",
      rule: "decoy — should never be touched", context: "ctx", tags: [], active: true, kind: "correction",
      weight: 0.5, proof_confidence: 0.4,
    });
    typesMod.setRoot(decoyRoot);
    assert.equal(typesMod.getRoot(), decoyRoot);

    // The REAL target store, passed explicitly via storeRoot.
    const explicitRoot = path.join(TEST_ROOT, "explicit-target");
    fs.mkdirSync(explicitRoot, { recursive: true });
    seed(explicitRoot, PROJECT_A, {
      id: "explicit-record", date: "2026-09-01", severity: "p0", project: PROJECT_A,
      rule: "the record the explicit --store call should see", context: "ctx", tags: [], active: true, kind: "correction",
      weight: 1.0, proof_confidence: 0.9, last_retrieved: "2026-09-10T00:00:00Z",
    });

    const result = await retier.runRetier({ storeRoot: explicitRoot, asOfDay: AS_OF, write: true });

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].id, "explicit-record", "must have scanned the EXPLICIT store, not the ambient decoy root");
    assert.equal(result.written, 1);

    // Restoration: the ambient global root is back to the decoy, untouched.
    assert.equal(typesMod.getRoot(), decoyRoot, "global root must be restored after the call");
    const decoyAfter = readBack(decoyRoot, "decoy-proj", "decoy-record");
    assert.equal(decoyAfter.tier, undefined, "the decoy store (ambient root) must be completely untouched");

    typesMod.setRoot(TEST_ROOT); // restore for afterEach's cleanup assumptions
  });
});
