// packages/core/test/activation.test.mjs
//
// Evolution p3 — ACT-R declarative-memory activation
// (packages/core/src/retrieval/activation.ts). Coverage (brief item 4):
//   1. Activation math — hand-computed assocStrength/activationBonus.
//   2. Degradation — missing/corrupt/wrong-shape edges.json -> null, never throw.
//   3. Flag-off byte-identity — session_start + smart_recall payloads are
//      identical whether or not a graph exists on disk, with the flag off.
//   4. Flag-ON sanity — the wiring actually engages when the flag is on and
//      a real graph is present (activation_leg / reordering).
//
// The STRICT TEMPORAL SPLIT leakage guard and the fixture-ledger-known-MRR
// eval live in scripts/eval/activation-eval.test.mjs (that script's own
// pure functions), not here.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  setRoot,
  resetRoot,
  journalDir,
  sessionStart,
  smartRecall,
  assocNodeId,
  adjacencyFromEdgesFile,
  defaultEdgesPathFor,
  loadAssocGraph,
  assocStrength,
  activationBonus,
  activationTieBreak,
  applyActivationRerank,
  S_DECAY,
  ACT_ALPHA,
  ACTIVATION_FLAG_ENV,
} from "../dist/index.js";

function correctionsDirFor(project) {
  return path.join(path.dirname(journalDir(project)), "corrections");
}

function seedCorrection(root, project, rec) {
  const dir = correctionsDirFor(project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec));
}

function writeEdges(root, edges, extra = {}) {
  const p = defaultEdgesPathFor(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({
      schema: "assoc-edges/v1",
      built_from_events: extra.built_from_events ?? edges.length,
      groups: extra.groups ?? { total: edges.length, by_granularity: { session_id: edges.length, transcript_basename: 0, project_day: 0 } },
      nodes: extra.nodes ?? new Set(edges.flatMap((e) => [e.a, e.b])).size,
      edges,
    }),
  );
  return p;
}

// ---------------------------------------------------------------------------
// 1. Activation math — hand-computed
// ---------------------------------------------------------------------------

describe("activation math — hand-computed", () => {
  it("assocStrength: days=0 (asOfDay === last_seen) reduces to the raw weight (exp(0)=1)", () => {
    const edge = { a: "corr:p/x", b: "corr:p/y", weight: 4, first_seen: "2026-08-01", last_seen: "2026-08-01" };
    assert.equal(assocStrength(edge, "2026-08-01"), 4);
  });

  it("assocStrength: S_DECAY=30 — 30 days of decay halves-ish via exp(-1) (hand-computed)", () => {
    const edge = { a: "corr:p/x", b: "corr:p/y", weight: 3, first_seen: "2026-08-01", last_seen: "2026-08-01" };
    const expected = 3 * Math.exp(-30 / S_DECAY); // = 3 * e^-1 ≈ 1.103638...
    assert.equal(S_DECAY, 30, "S_DECAY must be the documented HAND-TUNED 30");
    assert.ok(Math.abs(assocStrength(edge, "2026-08-31") - expected) < 1e-9);
    assert.ok(Math.abs(assocStrength(edge, "2026-08-31") - 1.1036383235143266) < 1e-9);
  });

  it("assocStrength: malformed last_seen degrades to 0, never throws", () => {
    const edge = { a: "corr:p/x", b: "corr:p/y", weight: 5, first_seen: "2026-08-01", last_seen: "not-a-date" };
    assert.equal(assocStrength(edge, "2026-08-31"), 0);
  });

  it("assocStrength: a last_seen AFTER asOfDay clamps days at 0 rather than boosting via a negative exponent", () => {
    const edge = { a: "corr:p/x", b: "corr:p/y", weight: 2, first_seen: "2026-08-01", last_seen: "2026-09-05" };
    assert.equal(assocStrength(edge, "2026-08-31"), 2); // clamps to days=0 -> weight * exp(0)
  });

  it("activationBonus: single context item WITH an edge to the candidate, weight=1/|context|", () => {
    const graph = adjacencyFromEdgesFile({
      schema: "assoc-edges/v1",
      built_from_events: 1,
      groups: { total: 1, by_granularity: { session_id: 1, transcript_basename: 0, project_day: 0 } },
      nodes: 2,
      edges: [{ a: "corr:p/x", b: "corr:p/y", weight: 2, first_seen: "2026-08-01", last_seen: "2026-08-01" }],
    });
    // asOfDay === last_seen -> S_ji = weight exactly = 2; |context|=1 -> bonus = 1*2 = 2.
    assert.equal(activationBonus("corr:p/x", ["corr:p/y"], graph, "2026-08-01"), 2);
  });

  it("activationBonus: two context items, only one has an edge — contributes (1/2)*S for that one, 0 for the other", () => {
    const graph = adjacencyFromEdgesFile({
      schema: "assoc-edges/v1",
      built_from_events: 1,
      groups: { total: 1, by_granularity: { session_id: 1, transcript_basename: 0, project_day: 0 } },
      nodes: 2,
      edges: [{ a: "corr:p/x", b: "corr:p/y", weight: 4, first_seen: "2026-08-01", last_seen: "2026-08-01" }],
    });
    const bonus = activationBonus("corr:p/x", ["corr:p/y", "corr:p/z"], graph, "2026-08-01");
    assert.equal(bonus, 0.5 * 4); // (1/2)*4 + (1/2)*0
  });

  it("activationBonus: no edge to the candidate at all -> 0", () => {
    const graph = adjacencyFromEdgesFile({
      schema: "assoc-edges/v1", built_from_events: 0,
      groups: { total: 0, by_granularity: { session_id: 0, transcript_basename: 0, project_day: 0 } },
      nodes: 0, edges: [],
    });
    assert.equal(activationBonus("corr:p/x", ["corr:p/y"], graph, "2026-08-01"), 0);
  });

  it("activationBonus: a context item equal to the candidate itself is skipped (no self-loop in this graph)", () => {
    const graph = adjacencyFromEdgesFile({
      schema: "assoc-edges/v1", built_from_events: 1,
      groups: { total: 1, by_granularity: { session_id: 1, transcript_basename: 0, project_day: 0 } },
      nodes: 2, edges: [{ a: "corr:p/x", b: "corr:p/y", weight: 9, first_seen: "2026-08-01", last_seen: "2026-08-01" }],
    });
    assert.equal(activationBonus("corr:p/x", ["corr:p/x"], graph, "2026-08-01"), 0);
  });

  it("activationBonus: null graph or empty context -> 0", () => {
    assert.equal(activationBonus("corr:p/x", ["corr:p/y"], null, "2026-08-01"), 0);
    const graph = adjacencyFromEdgesFile({
      schema: "assoc-edges/v1", built_from_events: 0,
      groups: { total: 0, by_granularity: { session_id: 0, transcript_basename: 0, project_day: 0 } },
      nodes: 0, edges: [],
    });
    assert.equal(activationBonus("corr:p/x", [], graph, "2026-08-01"), 0);
  });
});

// ---------------------------------------------------------------------------
// activationTieBreak — greedy, tie-class-scoped ordering (session_start integration shape)
// ---------------------------------------------------------------------------

describe("activationTieBreak — tie-class scoping and greedy context growth", () => {
  const graph = adjacencyFromEdgesFile({
    schema: "assoc-edges/v1", built_from_events: 1,
    groups: { total: 1, by_granularity: { session_id: 1, transcript_basename: 0, project_day: 0 } },
    nodes: 2,
    edges: [{ a: assocNodeId("proj", "b"), b: assocNodeId("proj", "c"), weight: 5, first_seen: "2026-08-01", last_seen: "2026-08-01" }],
  });

  it("never reorders ACROSS a (severity, proof_confidence) boundary, even with a strong edge", () => {
    // "a" has HIGHER proof_confidence than "b"/"c" — must stay first regardless
    // of any edge involving b/c.
    const ranked = [
      { id: "a", severity: "p0", proof_confidence: 0.9 },
      { id: "b", severity: "p0", proof_confidence: 0.1 },
      { id: "c", severity: "p0", proof_confidence: 0.1 },
    ];
    const out = activationTieBreak(ranked, { project: "proj", graph, asOfDay: "2026-08-01" });
    assert.equal(out[0].id, "a");
  });

  it("within a tie-class, activation reorders greedily: the item connected to the growing context wins", () => {
    // b and c tie (same severity+conf); d is an unconnected third tied item.
    const ranked = [
      { id: "d", severity: "p0", proof_confidence: 0 },
      { id: "b", severity: "p0", proof_confidence: 0 },
      { id: "c", severity: "p0", proof_confidence: 0 },
    ];
    const out = activationTieBreak(ranked, { project: "proj", graph, asOfDay: "2026-08-01" });
    // All three tie on (severity, conf) -> ONE tie-class. First pick: all
    // three have activationBonus=0 against an EMPTY context (nothing picked
    // yet) -> stable, first-original-position wins -> "d" picked first, its
    // node id joins context. Second pick: among {b, c}, "c" now has an edge
    // to "d"? No — the edge is b<->c, not d. So context={corr:proj/d} gives
    // both b and c bonus 0 still -> stable order preserves b before c.
    assert.deepEqual(out.map((r) => r.id), ["d", "b", "c"]);
  });

  it("within a tie-class, when the FIRST pick is itself one of the two connected items, the SECOND pick favors its edge partner", () => {
    const ranked = [
      { id: "b", severity: "p0", proof_confidence: 0 },
      { id: "d", severity: "p0", proof_confidence: 0 },
      { id: "c", severity: "p0", proof_confidence: 0 },
    ];
    const out = activationTieBreak(ranked, { project: "proj", graph, asOfDay: "2026-08-01" });
    // First pick: all tie at bonus 0 vs empty context -> "b" (original first) wins.
    // context = [corr:proj/b]. Second pick, among {d, c}: c has an edge to b
    // (bonus > 0), d has none (bonus 0) -> "c" wins over "d" despite "d"
    // being earlier in the original order.
    assert.deepEqual(out.map((r) => r.id), ["b", "c", "d"]);
  });

  it("no graph -> output is IDENTICAL to the input order (every bonus is 0, first-position always wins)", () => {
    const ranked = [
      { id: "z", severity: "p1", proof_confidence: 0 },
      { id: "y", severity: "p1", proof_confidence: 0 },
      { id: "x", severity: "p1", proof_confidence: 0 },
    ];
    const out = activationTieBreak(ranked, { project: "proj", graph: null, asOfDay: "2026-08-01" });
    assert.deepEqual(out.map((r) => r.id), ["z", "y", "x"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Degradation — loadAssocGraph / applyActivationRerank
// ---------------------------------------------------------------------------

describe("degradation — missing/corrupt/wrong-shape edges.json never throws", () => {
  let TMP;
  before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-activation-degrade-")); });
  after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

  it("no association/ dir at all -> null", () => {
    assert.equal(loadAssocGraph(TMP), null);
  });

  it("association dir exists but edges.json missing -> null", () => {
    const dir = path.join(TMP, "association");
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(loadAssocGraph(TMP), null);
  });

  it("corrupt JSON -> null, never throws", () => {
    const p = defaultEdgesPathFor(TMP);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ not: valid json,,,");
    assert.doesNotThrow(() => loadAssocGraph(TMP));
    assert.equal(loadAssocGraph(TMP), null);
  });

  it("valid JSON, wrong shape (missing schema field) -> null", () => {
    const p = defaultEdgesPathFor(TMP);
    fs.writeFileSync(p, JSON.stringify({ edges: [] }));
    assert.equal(loadAssocGraph(TMP), null);
  });

  it("a genuinely valid, EMPTY edges file (0 edges) is a real graph, NOT null", () => {
    writeEdges(TMP, []);
    const graph = loadAssocGraph(TMP);
    assert.notEqual(graph, null);
    assert.equal(graph.edgeCount, 0);
  });

  it("applyActivationRerank: no graph -> results left completely untouched + diagnosable reason", () => {
    const results = [{ id: "a", score: 0.5 }, { id: "b", score: 0.3 }];
    const before = JSON.parse(JSON.stringify(results));
    const note = applyActivationRerank(results, "proj", { storeRoot: TMP, graph: null });
    assert.deepEqual(results, before);
    assert.equal(note.used, false);
    assert.match(note.reason, /no association graph/);
  });

  it("applyActivationRerank: graph present but zero bonus among top candidates -> untouched + reason", () => {
    const graph = adjacencyFromEdgesFile({
      schema: "assoc-edges/v1", built_from_events: 0,
      groups: { total: 0, by_granularity: { session_id: 0, transcript_basename: 0, project_day: 0 } },
      nodes: 0, edges: [],
    });
    const results = [{ id: "a", score: 0.5 }, { id: "b", score: 0.3 }];
    const before = JSON.parse(JSON.stringify(results));
    const note = applyActivationRerank(results, "proj", { storeRoot: TMP, graph, asOfDay: "2026-08-01" });
    assert.deepEqual(results, before);
    assert.equal(note.used, false);
    assert.match(note.reason, /no edges/);
  });

  it("applyActivationRerank: graph present WITH a real edge among top candidates -> used:true, boost applied, dimensionless multiplier bounded", () => {
    const graph = adjacencyFromEdgesFile({
      schema: "assoc-edges/v1", built_from_events: 1,
      groups: { total: 1, by_granularity: { session_id: 1, transcript_basename: 0, project_day: 0 } },
      nodes: 2,
      edges: [{ a: assocNodeId("proj", "b"), b: assocNodeId("proj", "c"), weight: 5, first_seen: "2026-08-01", last_seen: "2026-08-01" }],
    });
    // context = top-3 by fused score = [a, b, c] (only 3 items here).
    // "b" has an edge to "c" (in context) -> gets a real bonus; "a"/"c" less/none.
    const results = [{ id: "a", score: 0.3 }, { id: "b", score: 0.29 }, { id: "c", score: 0.28 }];
    const note = applyActivationRerank(results, "proj", { storeRoot: TMP, graph, asOfDay: "2026-08-01" });
    assert.equal(note.used, true);
    // "b" got boosted by (1 + ACT_ALPHA * normalized) with normalized in [0,1) — multiplier is at most 1+ACT_ALPHA.
    const bItem = results.find((r) => r.id === "b");
    assert.ok(bItem.score > 0.29 && bItem.score <= 0.29 * (1 + ACT_ALPHA));
    // "a" (no edges at all in this graph) is numerically untouched (×1 exactly).
    const aItem = results.find((r) => r.id === "a");
    assert.equal(aItem.score, 0.3);
  });
});

// ---------------------------------------------------------------------------
// 3. Flag-off byte-identity (integration points)
// ---------------------------------------------------------------------------

describe("flag-off byte-identity — session_start", () => {
  const PROJECT = "activation-ss-equiv";
  let STORE_NO_GRAPH, STORE_WITH_GRAPH;
  let savedAbEnabled, savedAbForce;

  before(() => {
    delete process.env[ACTIVATION_FLAG_ENV];
    // Hermeticity (same hazard session-start-single-scan.test.mjs already
    // guards against): an ambient AR_AB_ENABLED=1 in the dev shell makes
    // session_start's corrections section A/B-gated by a per-slug arm
    // assignment, unrelated to this module — neutralize it so this test's
    // ONLY variable is activation's own flag/graph presence.
    savedAbEnabled = process.env.AR_AB_ENABLED;
    savedAbForce = process.env.AR_AB_FORCE;
    delete process.env.AR_AB_ENABLED;
    delete process.env.AR_AB_FORCE;
    STORE_NO_GRAPH = fs.mkdtempSync(path.join(os.tmpdir(), "ar-activation-ss-nograph-"));
    STORE_WITH_GRAPH = fs.mkdtempSync(path.join(os.tmpdir(), "ar-activation-ss-graph-"));
    for (const root of [STORE_NO_GRAPH, STORE_WITH_GRAPH]) {
      setRoot(root);
      seedCorrection(root, PROJECT, {
        id: "2026-01-01-p0-one", date: "2026-01-01", severity: "p0", project: PROJECT,
        rule: "Always run code-reviewer after writing code", context: "Always run code-reviewer after writing code",
        tags: [], active: true,
      });
      seedCorrection(root, PROJECT, {
        id: "2026-01-02-p0-two", date: "2026-01-02", severity: "p0", project: PROJECT,
        rule: "Never commit secrets to the repo", context: "Never commit secrets to the repo",
        tags: [], active: true,
      });
    }
    // Only STORE_WITH_GRAPH gets a real, non-trivial association graph
    // connecting the two P0 nodes above.
    writeEdges(STORE_WITH_GRAPH, [
      { a: assocNodeId(PROJECT, "2026-01-01-p0-one"), b: assocNodeId(PROJECT, "2026-01-02-p0-two"), weight: 7, first_seen: "2026-01-01", last_seen: "2026-01-02" },
    ]);
  });
  after(() => {
    resetRoot();
    if (savedAbEnabled !== undefined) process.env.AR_AB_ENABLED = savedAbEnabled;
    if (savedAbForce !== undefined) process.env.AR_AB_FORCE = savedAbForce;
    fs.rmSync(STORE_NO_GRAPH, { recursive: true, force: true });
    fs.rmSync(STORE_WITH_GRAPH, { recursive: true, force: true });
  });

  it("flag OFF: the `corrections` payload is identical whether or not association/edges.json exists on disk", async () => {
    setRoot(STORE_NO_GRAPH);
    const withoutGraph = await sessionStart({ project: PROJECT });
    setRoot(STORE_WITH_GRAPH);
    const withGraph = await sessionStart({ project: PROJECT });
    assert.deepEqual(withGraph.corrections, withoutGraph.corrections);
    assert.ok(withGraph.corrections.length >= 2, "fixture must actually surface both P0s");
  });

  it("flag OFF, double-run diff: calling session_start twice against the SAME (graph-bearing) store yields the same `corrections` order both times", async () => {
    setRoot(STORE_WITH_GRAPH);
    const first = await sessionStart({ project: PROJECT });
    const second = await sessionStart({ project: PROJECT });
    assert.deepEqual(second.corrections, first.corrections);
  });
});

describe("flag-off byte-identity — smart_recall", () => {
  const PROJECT = "activation-sr-equiv";
  let TMP;
  const QUERY = "zzactivationkeyword smoke check";

  before(() => {
    delete process.env[ACTIVATION_FLAG_ENV];
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-activation-sr-equiv-"));
    setRoot(TMP);
    seedCorrection(TMP, PROJECT, {
      id: "2026-02-01-alpha", date: "2026-02-01", severity: "p1", project: PROJECT,
      rule: "Run the zzactivationkeyword smoke check before every release", context: "", tags: [], active: true,
    });
    seedCorrection(TMP, PROJECT, {
      id: "2026-02-02-beta", date: "2026-02-02", severity: "p1", project: PROJECT,
      rule: "The zzactivationkeyword smoke check also covers staging", context: "", tags: [], active: true,
    });
  });
  after(() => { resetRoot(); fs.rmSync(TMP, { recursive: true, force: true }); });

  it("flag OFF: results + absence of activation_leg are identical with and without edges.json on disk", async () => {
    const edgesPath = defaultEdgesPathFor(TMP);
    fs.rmSync(edgesPath, { force: true });
    const baseline = await smartRecall({ query: QUERY, project: PROJECT, limit: 10, drilldown: false });
    assert.ok(!("activation_leg" in baseline), "flag-off must never carry activation_leg");
    assert.ok(baseline.results.length >= 2, "fixture must surface both corrections lexically");

    writeEdges(TMP, [
      { a: assocNodeId(PROJECT, "2026-02-01-alpha"), b: assocNodeId(PROJECT, "2026-02-02-beta"), weight: 9, first_seen: "2026-02-01", last_seen: "2026-02-02" },
    ]);
    const withGraph = await smartRecall({ query: QUERY, project: PROJECT, limit: 10, drilldown: false });
    assert.ok(!("activation_leg" in withGraph));
    assert.deepEqual(withGraph.results, baseline.results);
  });
});

// ---------------------------------------------------------------------------
// 4. Flag-ON sanity — the wiring actually engages
// ---------------------------------------------------------------------------

describe("flag ON — the wiring actually engages (sanity, not a golden-number pin)", () => {
  const PROJECT = "activation-on-sanity";
  let TMP;
  const QUERY = "zzactivationon smoke check";

  before(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-activation-on-"));
    setRoot(TMP);
    seedCorrection(TMP, PROJECT, {
      id: "2026-03-01-one", date: "2026-03-01", severity: "p1", project: PROJECT,
      rule: "Run the zzactivationon smoke check before every deploy", context: "", tags: [], active: true,
    });
    seedCorrection(TMP, PROJECT, {
      id: "2026-03-02-two", date: "2026-03-02", severity: "p1", project: PROJECT,
      rule: "The zzactivationon smoke check also covers rollback", context: "", tags: [], active: true,
    });
    writeEdges(TMP, [
      { a: assocNodeId(PROJECT, "2026-03-01-one"), b: assocNodeId(PROJECT, "2026-03-02-two"), weight: 10, first_seen: "2026-03-01", last_seen: "2026-03-02" },
    ]);
  });
  after(() => {
    resetRoot();
    delete process.env[ACTIVATION_FLAG_ENV];
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("smart_recall: activation_leg is present and reports used:true when a real edge connects top candidates", async () => {
    process.env[ACTIVATION_FLAG_ENV] = "1";
    const res = await smartRecall({ query: QUERY, project: PROJECT, limit: 10, drilldown: false });
    assert.ok(res.activation_leg, "activation_leg must be present when the flag is on");
    assert.equal(res.activation_leg.used, true);
  });

  it("smart_recall: flag ON but NO edges.json at all -> degrades cleanly (used:false, results unaffected)", async () => {
    process.env[ACTIVATION_FLAG_ENV] = "1";
    const edgesPath = defaultEdgesPathFor(TMP);
    const saved = fs.readFileSync(edgesPath, "utf-8");
    fs.rmSync(edgesPath);
    try {
      const res = await smartRecall({ query: QUERY, project: PROJECT, limit: 10, drilldown: false });
      assert.equal(res.activation_leg.used, false);
      assert.match(res.activation_leg.reason, /no association graph/);
    } finally {
      fs.writeFileSync(edgesPath, saved);
    }
  });
});
