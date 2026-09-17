/**
 * association.test.mjs
 *
 * Evolution p2 — `ar assoc rebuild` / `ar assoc stats` core logic
 * (packages/core/src/tools-logic/association.ts). The S_ji associative-
 * strength matrix, derived purely from Phase-1a's `cited` events.
 *
 * Coverage (brief item 4's fixture families):
 *  1. Multi-session co-citation — edge weight counts DISTINCT co-activation
 *     groups (sessions), never raw event count (a duplicate cited line
 *     inside one session must not inflate the weight).
 *  2. Granularity fallback ladder — session_id > transcript_basename >
 *     (project, day), including the "+"-joined multi-transcript tag
 *     defensively falling through to project_day rather than being
 *     misread as a single transcript.
 *  3. Cross-project isolation — same session_id AND same correction_id
 *     string across two projects never produces a cross-project edge.
 *  4. Degenerate-graph rendering — the exact "DEGENERATE: <reason>" probe
 *     string for both trigger conditions (<5 edges, all-equal weights) and
 *     its absence on a healthy graph.
 *  5. Per-item resilience — corrupt/malformed ledger lines are skipped and
 *     counted, never crash the rebuild.
 *  6. Determinism — rebuild twice over the same ledger is byte-identical.
 *  7. --dry-run computes but writes nothing.
 *  8. Edge sort contract (weight desc, then "a|b" key asc).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  runAssocRebuild,
  buildAssociationGraph,
  computeAssocStats,
  computeDegenerateReason,
  sortAssocEdges,
  assocNodeId,
  parseAssocNodeId,
  assocEdgeKey,
  parseTranscriptBasenameFromEvidence,
  defaultEdgesPathFor,
} from "../dist/index.js";

let testRoot;

function corrDir(project) {
  return path.join(testRoot, "projects", project, "corrections");
}
function outcomesFile(project) {
  return path.join(corrDir(project), "_outcomes.jsonl");
}
function appendLine(project, obj) {
  fs.mkdirSync(corrDir(project), { recursive: true });
  fs.appendFileSync(outcomesFile(project), JSON.stringify(obj) + "\n", "utf-8");
}
function appendRaw(project, rawLine) {
  fs.mkdirSync(corrDir(project), { recursive: true });
  fs.appendFileSync(outcomesFile(project), rawLine + "\n", "utf-8");
}
function cited({ project, correctionId, at, evidence, sessionId }) {
  return {
    correction_id: correctionId,
    project,
    kind: "cited",
    at,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
  };
}
function isoFor(day) {
  return `${day}T12:00:00.000Z`;
}
function edgeBetween(edges, a, b) {
  return edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
}

beforeEach(() => {
  testRoot = path.join(tmpdir(), `ar-assoc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure grammar helpers
// ---------------------------------------------------------------------------

describe("node id / edge key grammar", () => {
  it("assocNodeId / parseAssocNodeId round-trip", () => {
    const id = assocNodeId("my-project", "2026-07-01-never-skip-tests");
    assert.equal(id, "corr:my-project/2026-07-01-never-skip-tests");
    assert.deepEqual(parseAssocNodeId(id), { project: "my-project", correctionId: "2026-07-01-never-skip-tests" });
  });

  it("parseAssocNodeId returns null for non-matching grammar", () => {
    assert.equal(parseAssocNodeId("not-a-node-id"), null);
  });

  it("assocEdgeKey is order-independent and lexicographically sorted", () => {
    assert.equal(assocEdgeKey("corr:a/1", "corr:b/2"), "corr:a/1|corr:b/2");
    assert.equal(assocEdgeKey("corr:b/2", "corr:a/1"), "corr:a/1|corr:b/2");
  });

  it("parseTranscriptBasenameFromEvidence extracts a single basename tag", () => {
    assert.equal(
      parseTranscriptBasenameFromEvidence("transcript-audit:aaaa-bbbb:cited — matched [id:x]"),
      "aaaa-bbbb",
    );
  });

  it("parseTranscriptBasenameFromEvidence rejects a '+'-joined multi-transcript tag", () => {
    assert.equal(parseTranscriptBasenameFromEvidence("transcript-audit:base1+base2:ignored — no citation"), null);
  });

  it("parseTranscriptBasenameFromEvidence returns null for non-transcript-audit evidence and undefined", () => {
    assert.equal(parseTranscriptBasenameFromEvidence("dream-audit:whatever"), null);
    assert.equal(parseTranscriptBasenameFromEvidence(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// 1. Multi-session co-citation
// ---------------------------------------------------------------------------

describe("multi-session co-citation — weight counts sessions, not events", () => {
  it("a pair cited together in 3 sessions gets weight 3, even with a duplicate line inside one session", () => {
    const PROJECT = "proj-multisession";
    const D1 = "2026-07-01", D2 = "2026-07-02", D3 = "2026-07-03";

    // Session s1: c1 + c2 co-cited.
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c1", at: isoFor(D1), sessionId: "s1" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c2", at: isoFor(D1), sessionId: "s1" }));
    // Session s2: c1 + c2 co-cited again.
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c1", at: isoFor(D2), sessionId: "s2" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c2", at: isoFor(D2), sessionId: "s2" }));
    // Session s3: c1 cited TWICE (duplicate line) + c2 once — still ONE session.
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c1", at: isoFor(D3), sessionId: "s3" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c1", at: isoFor(D3), sessionId: "s3" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c2", at: isoFor(D3), sessionId: "s3" }));

    const { file } = buildAssociationGraph(testRoot);
    assert.equal(file.groups.by_granularity.session_id, 3, "3 distinct sessions, not 3.5 or 8");
    assert.equal(file.built_from_events, 7, "7 valid cited events read");

    const c1 = assocNodeId(PROJECT, "c1");
    const c2 = assocNodeId(PROJECT, "c2");
    const edge = edgeBetween(file.edges, c1, c2);
    assert.ok(edge, "c1-c2 edge must exist");
    assert.equal(edge.weight, 3, "weight must be the number of DISTINCT sessions (3), not raw event pairs");
    assert.equal(edge.first_seen, D1);
    assert.equal(edge.last_seen, D3);
  });
});

// ---------------------------------------------------------------------------
// 2. Granularity fallback ladder
// ---------------------------------------------------------------------------

describe("granularity fallback ladder — session_id > transcript_basename > project_day", () => {
  it("classifies each tier correctly, including a defensive '+' -> project_day fallback", () => {
    const PROJECT = "proj-granularity";
    const D1 = "2026-08-01", D2 = "2026-08-02", D3 = "2026-08-03";

    // Group A — session_id present.
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c1", at: isoFor(D1), sessionId: "sidA" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c2", at: isoFor(D1), sessionId: "sidA" }));

    // Group B — no session_id, single-transcript evidence tag.
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c3", at: isoFor(D1), evidence: "transcript-audit:baseB:cited — matched [id:x]" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c4", at: isoFor(D1), evidence: "transcript-audit:baseB:cited — matched [id:y]" }));

    // Group C — no session_id, no evidence at all -> (project, day) fallback, day D2.
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c5", at: isoFor(D2) }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c6", at: isoFor(D2) }));

    // Group D — no session_id, a "+"-joined multi-transcript tag (never emitted for
    // "cited" by transcript-audit.ts today, but this module must not misread it
    // as a single transcript identity) -> (project, day) fallback, day D3 (kept
    // on a DIFFERENT day from Group C so it forms its own group).
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c7", at: isoFor(D3), evidence: "transcript-audit:baseX+baseY:cited — no citation/recurrence across 2 transcript(s)" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c8", at: isoFor(D3), evidence: "transcript-audit:baseX+baseY:cited — no citation/recurrence across 2 transcript(s)" }));

    const { file } = buildAssociationGraph(testRoot);

    assert.equal(file.groups.total, 4);
    assert.deepEqual(file.groups.by_granularity, { session_id: 1, transcript_basename: 1, project_day: 2 });
    assert.equal(file.nodes, 8);
    assert.equal(file.edges.length, 4);

    for (const [x, y] of [["c1", "c2"], ["c3", "c4"], ["c5", "c6"], ["c7", "c8"]]) {
      const edge = edgeBetween(file.edges, assocNodeId(PROJECT, x), assocNodeId(PROJECT, y));
      assert.ok(edge, `${x}-${y} edge must exist`);
      assert.equal(edge.weight, 1);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-project isolation
// ---------------------------------------------------------------------------

describe("cross-project isolation", () => {
  it("same session_id AND same correction_id string across two projects never forms a cross-project edge", () => {
    const D1 = "2026-09-01";

    appendLine("proj-a", cited({ project: "proj-a", correctionId: "shared-id", at: isoFor(D1), sessionId: "shared-session" }));
    appendLine("proj-a", cited({ project: "proj-a", correctionId: "only-a", at: isoFor(D1), sessionId: "shared-session" }));

    appendLine("proj-b", cited({ project: "proj-b", correctionId: "shared-id", at: isoFor(D1), sessionId: "shared-session" }));
    appendLine("proj-b", cited({ project: "proj-b", correctionId: "only-b", at: isoFor(D1), sessionId: "shared-session" }));

    const { file } = buildAssociationGraph(testRoot);

    // Two SEPARATE groups (project-scoped), never one merged cross-project group.
    assert.equal(file.groups.total, 2);
    assert.equal(file.groups.by_granularity.session_id, 2);
    assert.equal(file.nodes, 4);
    assert.equal(file.edges.length, 2);

    const aEdge = edgeBetween(file.edges, assocNodeId("proj-a", "shared-id"), assocNodeId("proj-a", "only-a"));
    const bEdge = edgeBetween(file.edges, assocNodeId("proj-b", "shared-id"), assocNodeId("proj-b", "only-b"));
    assert.ok(aEdge, "proj-a's own edge must exist");
    assert.ok(bEdge, "proj-b's own edge must exist");

    const crossEdge = edgeBetween(file.edges, assocNodeId("proj-a", "shared-id"), assocNodeId("proj-b", "shared-id"));
    assert.equal(crossEdge, undefined, "a cross-project edge must never be created");
  });
});

// ---------------------------------------------------------------------------
// 4. Degenerate-graph rendering (exact probe string)
// ---------------------------------------------------------------------------

describe("DEGENERATE probe (exact string, Phase-2 exit condition)", () => {
  function edge(a, b, weight, day = "2026-01-01") {
    return { a, b, weight, first_seen: day, last_seen: day };
  }

  it("fires exactly on < 5 edges", () => {
    const edges = [edge("a", "b", 2), edge("c", "d", 1)];
    assert.equal(computeDegenerateReason(edges), "fewer than 5 edges (2 found)");

    const stats = computeAssocStats({ schema: "assoc-edges/v1", built_from_events: 0, groups: { total: 0, by_granularity: { session_id: 0, transcript_basename: 0, project_day: 0 } }, nodes: 4, edges });
    assert.equal(stats.degenerate, "fewer than 5 edges (2 found)");
  });

  it("fires exactly when >=5 edges all share the same weight", () => {
    const edges = [edge("a", "b", 1), edge("c", "d", 1), edge("e", "f", 1), edge("g", "h", 1), edge("i", "j", 1)];
    assert.equal(computeDegenerateReason(edges), "all 5 edge weights are equal (weight=1)");
  });

  it("is null (healthy) with >=5 edges and differing weights", () => {
    const edges = [edge("a", "b", 5), edge("c", "d", 4), edge("e", "f", 3), edge("g", "h", 2), edge("i", "j", 1)];
    assert.equal(computeDegenerateReason(edges), null);
  });
});

// ---------------------------------------------------------------------------
// 5. Per-item resilience
// ---------------------------------------------------------------------------

describe("per-item resilience — corrupt ledger lines", () => {
  it("skips and counts malformed lines without crashing, and still processes the good ones", () => {
    const PROJECT = "proj-corrupt";
    fs.mkdirSync(corrDir(PROJECT), { recursive: true });

    appendRaw(PROJECT, "{not valid json at all");
    appendLine(PROJECT, { correction_id: undefined, project: PROJECT, kind: "cited", at: isoFor("2026-07-01") }); // missing correction_id after JSON.stringify drops undefined key entirely -> also missing
    appendLine(PROJECT, { project: PROJECT, kind: "retrieved", at: isoFor("2026-07-01") }); // irrelevant kind — never malformed, silently skipped
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "cGood1", at: isoFor("2026-07-01"), sessionId: "sOK" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "cGood2", at: isoFor("2026-07-01"), sessionId: "sOK" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "cBadDate", at: "not-a-real-timestamp", sessionId: "sOK" }));

    const { file, malformedRows } = buildAssociationGraph(testRoot);

    // 1 unparseable JSON line + 1 missing-correction_id "cited" line + 1
    // unparseable-`at` "cited" line = 3 malformed rows. The "retrieved"-kind
    // line is silently ignored (not malformed — just irrelevant).
    assert.equal(malformedRows.length, 3);
    assert.ok(malformedRows.every((m) => m.project === PROJECT));

    assert.equal(file.built_from_events, 2, "only the two well-formed cited events count");
    const c1 = assocNodeId(PROJECT, "cGood1");
    const c2 = assocNodeId(PROJECT, "cGood2");
    const edge = edgeBetween(file.edges, c1, c2);
    assert.ok(edge, "the two well-formed cited events must still form an edge");
    assert.equal(edge.weight, 1);
  });

  it("an unreadable ledger (missing file) yields an empty graph, never throws", () => {
    // No _outcomes.jsonl at all for this project dir.
    fs.mkdirSync(path.join(testRoot, "projects", "proj-empty"), { recursive: true });
    const { file, malformedRows, projectsScanned } = buildAssociationGraph(testRoot);
    assert.equal(projectsScanned, 1);
    assert.equal(malformedRows.length, 0);
    assert.equal(file.nodes, 0);
    assert.equal(file.edges.length, 0);
  });

  it("a completely missing projects/ directory yields an empty graph, never throws", () => {
    const { file, projectsScanned } = buildAssociationGraph(path.join(testRoot, "does-not-exist"));
    assert.equal(projectsScanned, 0);
    assert.equal(file.nodes, 0);
    assert.equal(file.edges.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. Determinism / byte-identical rebuild
// ---------------------------------------------------------------------------

describe("determinism — byte-identical rebuild", () => {
  it("rebuilding twice over the same unchanged ledger produces byte-identical edges.json", async () => {
    const PROJECT = "proj-determinism";
    const D1 = "2026-07-01";
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c1", at: isoFor(D1), sessionId: "s1" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c2", at: isoFor(D1), sessionId: "s1" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c3", at: isoFor(D1), sessionId: "s2" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c1", at: isoFor(D1), sessionId: "s2" }));

    const outPath = defaultEdgesPathFor(testRoot);

    const r1 = await runAssocRebuild({ storeRoot: testRoot });
    assert.equal(r1.written, true);
    const bytes1 = fs.readFileSync(outPath, "utf-8");

    const r2 = await runAssocRebuild({ storeRoot: testRoot });
    assert.equal(r2.written, true);
    const bytes2 = fs.readFileSync(outPath, "utf-8");

    assert.equal(bytes1, bytes2, "rebuild must be byte-identical across reruns over the same ledger");
    assert.deepEqual(r1.file, r2.file);
  });
});

// ---------------------------------------------------------------------------
// 7. --dry-run
// ---------------------------------------------------------------------------

describe("--dry-run", () => {
  it("computes the correct graph but writes nothing", async () => {
    const PROJECT = "proj-dryrun";
    const D1 = "2026-07-01";
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c1", at: isoFor(D1), sessionId: "s1" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c2", at: isoFor(D1), sessionId: "s1" }));

    const outPath = defaultEdgesPathFor(testRoot);
    assert.equal(fs.existsSync(outPath), false);

    const result = await runAssocRebuild({ storeRoot: testRoot, dryRun: true });
    assert.equal(result.written, false);
    assert.equal(result.dry_run, true);
    assert.equal(result.file.edges.length, 1);
    assert.equal(fs.existsSync(outPath), false, "--dry-run must never write edges.json");
  });

  it("does not touch an already-written edges.json", async () => {
    const PROJECT = "proj-dryrun2";
    const D1 = "2026-07-01";
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c1", at: isoFor(D1), sessionId: "s1" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c2", at: isoFor(D1), sessionId: "s1" }));

    await runAssocRebuild({ storeRoot: testRoot }); // real write
    const outPath = defaultEdgesPathFor(testRoot);
    const before = fs.readFileSync(outPath, "utf-8");

    // Add a NEW cited event, then dry-run — the on-disk file must stay as it was.
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c3", at: isoFor(D1), sessionId: "s2" }));
    const result = await runAssocRebuild({ storeRoot: testRoot, dryRun: true });
    assert.equal(result.written, false);

    const after = fs.readFileSync(outPath, "utf-8");
    assert.equal(after, before, "dry-run must not overwrite the existing edges.json even though the computed graph changed");
  });
});

// ---------------------------------------------------------------------------
// 8. Edge sort contract
// ---------------------------------------------------------------------------

describe("edge sort contract — weight desc, then 'a|b' key asc", () => {
  it("sortAssocEdges orders heaviest first, ties broken by lexicographic key", () => {
    const edges = [
      { a: "corr:p/z", b: "corr:p/zz", weight: 1, first_seen: "2026-01-01", last_seen: "2026-01-01" },
      { a: "corr:p/a", b: "corr:p/b", weight: 5, first_seen: "2026-01-01", last_seen: "2026-01-01" },
      { a: "corr:p/a", b: "corr:p/aa", weight: 1, first_seen: "2026-01-01", last_seen: "2026-01-01" },
    ];
    const sorted = sortAssocEdges(edges);
    assert.equal(sorted[0].weight, 5);
    // The two weight=1 edges must be ordered by "a|b" key ascending:
    // "corr:p/a|corr:p/aa" < "corr:p/z|corr:p/zz"
    assert.equal(sorted[1].a, "corr:p/a");
    assert.equal(sorted[1].b, "corr:p/aa");
    assert.equal(sorted[2].a, "corr:p/z");
  });
});

// ---------------------------------------------------------------------------
// `ar assoc rebuild` end-to-end summary shape
// ---------------------------------------------------------------------------

describe("runAssocRebuild — result shape", () => {
  it("reports store_root, out_path, projects_scanned, and the persisted file", async () => {
    const PROJECT = "proj-summary";
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c1", at: isoFor("2026-07-01"), sessionId: "s1" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c2", at: isoFor("2026-07-01"), sessionId: "s1" }));

    const result = await runAssocRebuild({ storeRoot: testRoot });
    assert.equal(result.store_root, testRoot);
    assert.equal(result.out_path, defaultEdgesPathFor(testRoot));
    assert.equal(result.projects_scanned, 1);
    assert.equal(result.file.schema, "assoc-edges/v1");
    assert.equal(result.file.nodes, 2);
    assert.equal(result.file.edges.length, 1);
  });

  it("honors a custom --out path", async () => {
    const PROJECT = "proj-customout";
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c1", at: isoFor("2026-07-01"), sessionId: "s1" }));
    appendLine(PROJECT, cited({ project: PROJECT, correctionId: "c2", at: isoFor("2026-07-01"), sessionId: "s1" }));

    const customOut = path.join(testRoot, "custom-dir", "my-edges.json");
    const result = await runAssocRebuild({ storeRoot: testRoot, outPath: customOut });
    assert.equal(result.out_path, customOut);
    assert.ok(fs.existsSync(customOut));
    assert.equal(fs.existsSync(defaultEdgesPathFor(testRoot)), false, "must not ALSO write the default path");
  });
});
