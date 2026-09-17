#!/usr/bin/env node
/**
 * activation-eval.mjs — evolution p3 offline counterfactual eval.
 *
 * MEASUREMENT-ONLY, READ-ONLY. Answers: "if activation had been ON, would
 * the corrections that a transcript-audit later marked `cited` have ranked
 * higher at the moment they were `retrieved`?" — using ONLY information a
 * live session_start call could have had AT THAT TIME (STRICT TEMPORAL
 * SPLIT, see below). Never writes to the store; never tunes anything.
 *
 * ── STRICT TEMPORAL SPLIT (the whole point of this script) ─────────────────
 * For a candidate correction retrieved on calendar day D, the ONLY
 * legitimate co-activation evidence is a `cited` event from BEFORE day D
 * (`day < D`, never `<=`) — a same-day `cited` event is proof the CURRENT
 * session already worked, which a same-day session_start call could never
 * have known about. Audit days are iterated in ascending order; for each
 * day D, the graph is rebuilt IN-MEMORY from every project's `cited` events
 * with `day < D` via `buildAssociationGraphFromEvents` (Phase 2's own
 * exported pure derivation, packages/core/src/tools-logic/association.ts —
 * reused verbatim, never forked, per the brief).
 *
 * ── Per (project, day) methodology ──────────────────────────────────────
 *   candidates  = distinct correction ids with a `retrieved` event that day
 *   ground truth = the subset of `candidates` that ALSO have a `cited`
 *                  event that SAME day (same project, same ledger)
 *   ranking A   = the real, unmodified `rankCorrections()` order over the
 *                 candidates' current on-disk records
 *   ranking B   = ranking A with an activation TIE-BREAK — context is the
 *                 FIXED top-2 node ids of ranking A itself (a STATIC
 *                 context, deliberately different from the session_start
 *                 integration's GREEDY growing context — this is what the
 *                 brief specifies for this eval specifically: "context must
 *                 be knowable at rank time")
 *   metrics     = MRR and hit@3 of the cited ground-truth items, under A vs B
 * A (project, day) pair is EVALUABLE only when it has >=1 ground-truth
 * cited item (otherwise there is nothing to rank against — MRR/hit@3 would
 * be vacuous).
 *
 * ── CLAIM-GATE DISCIPLINE ───────────────────────────────────────────────
 * Point estimates print ONLY when evaluable pairs >= MIN_EVALUABLE_PAIRS
 * (20) AND evaluable days >= MIN_EVALUABLE_DAYS (5); otherwise this prints
 * the literal string "CANNOT CLAIM (n=<X> evaluable pairs < gate 20)" (or
 * the days-gate's own literal analog) alongside the raw counts — NEVER a
 * synthesized number. A null/negative uplift, once the gate passes, is
 * printed exactly like a positive one — it is a valid, publishable result.
 *
 * Usage:
 *   node scripts/eval/activation-eval.mjs                      # ~/.agent-recall, human report
 *   node scripts/eval/activation-eval.mjs --store <dir>         # fixture / explicit store root
 *   node scripts/eval/activation-eval.mjs --json                # JSON to stdout
 *
 * Exit codes: 0 always (a read-only measurement instrument; CANNOT CLAIM is
 * an honest finding, not a process failure — same convention as
 * evolution-baseline.mjs / ab-report.mjs).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Claim gates (brief-specified literals)
// ---------------------------------------------------------------------------

export const MIN_EVALUABLE_PAIRS = 20;
export const MIN_EVALUABLE_DAYS = 5;

// ---------------------------------------------------------------------------
// Store readers — mirrors the established idiom (rmr-report.mjs's
// readCorrections/readOutcomes, evolution-baseline.mjs's own readers):
// direct, resilient fs reads against an EXPLICIT storeRoot, never coupled to
// the core package's process-global getRoot() (consistent with
// association.ts's own "explicit storeRoot threading" design note).
// ---------------------------------------------------------------------------

export function defaultStoreRoot() {
  return path.join(os.homedir(), ".agent-recall");
}

/** Sorted project directory names under `<root>/projects/`. [] if absent. */
export function listProjects(root) {
  const base = path.join(root, "projects");
  if (!fs.existsSync(base)) return [];
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort();
}

/** Read every correction JSON record for a project. Malformed/unreadable files are skipped. */
export function readCorrectionRecords(root, project) {
  const dir = path.join(root, "projects", project, "corrections");
  if (!fs.existsSync(dir)) return [];
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const f of files) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (rec && typeof rec.id === "string") records.push(rec);
    } catch {
      // skip malformed
    }
  }
  return records;
}

/**
 * Read EVERY outcome-ledger line for a project (any `kind`) —
 * `readCitedEvents` (reused below for the graph) only surfaces
 * `kind==="cited"`; this eval also needs `kind==="retrieved"` to define
 * `candidates`, so it reads the raw ledger itself rather than widening
 * association.ts's own reader's contract.
 */
export function readOutcomeLedger(root, project) {
  const file = path.join(root, "projects", project, "corrections", "_outcomes.jsonl");
  if (!fs.existsSync(file)) return [];
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    if (typeof rec.correction_id !== "string" || typeof rec.at !== "string") continue;
    out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Temporal split
// ---------------------------------------------------------------------------

/**
 * Filters an eventsByProject map (association.ts's `CitedEventRaw[]` per
 * project) to events strictly BEFORE `cutoffDay` — the one function this
 * whole script's correctness rests on. `dayOfFn` is injected (always
 * `heedTierDayOf` in production) so the leakage-guard test can assert this
 * function's boundary behavior directly without needing a live dist import.
 */
export function filterEventsBeforeDay(eventsByProject, cutoffDay, dayOfFn) {
  const out = new Map();
  for (const [project, events] of eventsByProject) {
    out.set(
      project,
      events.filter((e) => {
        const d = dayOfFn(e.at);
        return d !== null && d < cutoffDay;
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// (project, day) candidate/ground-truth extraction
// ---------------------------------------------------------------------------

/**
 * Builds the full list of evaluable-shaped (project, day, candidates,
 * cited) tuples from one project's raw outcome ledger. `dayOfFn` computes
 * the local-calendar day for an ISO `at` (same "sv"-locale convention Phase
 * 2's own graph derivation uses — see activation.ts's header) so "day" means
 * the exact same thing everywhere in this script.
 */
export function computeProjectDayPairs(project, ledgerEvents, dayOfFn) {
  const retrievedByDay = new Map(); // day -> Set(correction_id)
  const citedByDay = new Map();
  for (const evt of ledgerEvents) {
    const day = dayOfFn(evt.at);
    if (!day) continue;
    if (evt.kind === "retrieved") {
      if (!retrievedByDay.has(day)) retrievedByDay.set(day, new Set());
      retrievedByDay.get(day).add(evt.correction_id);
    } else if (evt.kind === "cited") {
      if (!citedByDay.has(day)) citedByDay.set(day, new Set());
      citedByDay.get(day).add(evt.correction_id);
    }
  }
  const pairs = [];
  for (const [day, candidateSet] of retrievedByDay) {
    const candidates = [...candidateSet].sort();
    const citedSet = citedByDay.get(day);
    const cited = citedSet ? candidates.filter((id) => citedSet.has(id)) : [];
    pairs.push({ project, day, candidates, cited });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Ranking B — activation tie-break with a FIXED context (this eval's own
// spec: "context = top-2 candidates by ranking A", knowable at rank time —
// deliberately NOT the greedy growing context activation.ts::
// activationTieBreak uses for the session_start integration point).
// Built from the CORE primitives only (assocNodeId, activationBonus) —
// the ACT-R math itself is never re-derived here.
// ---------------------------------------------------------------------------

export function tieBreakFixedContext(rankingA, project, context, graph, asOfDay, deps) {
  const { assocNodeId, activationBonus } = deps;
  const effConf = (r) => (typeof r.proof_confidence === "number" ? r.proof_confidence : (r.weight ?? 0));
  const result = [];
  let i = 0;
  while (i < rankingA.length) {
    let j = i;
    while (
      j + 1 < rankingA.length &&
      rankingA[j + 1].severity === rankingA[i].severity &&
      effConf(rankingA[j + 1]) === effConf(rankingA[i])
    ) {
      j++;
    }
    const group = rankingA.slice(i, j + 1).map((r, idx) => ({ r, idx }));
    group.sort((a, b) => {
      const sa = activationBonus(assocNodeId(project, a.r.id), context, graph, asOfDay);
      const sb = activationBonus(assocNodeId(project, b.r.id), context, graph, asOfDay);
      if (sb !== sa) return sb - sa;
      return a.idx - b.idx; // stable — preserves ranking A's own relative order
    });
    for (const g of group) result.push(g.r);
    i = j + 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** 1/rank of the first cited item (0 if none found — should not happen for an evaluable pair). */
function mrrOf(ranking, citedSet) {
  for (let i = 0; i < ranking.length; i++) {
    if (citedSet.has(ranking[i].id)) return 1 / (i + 1);
  }
  return 0;
}

/** 1 if any cited item appears in the top 3, else 0. */
function hit3Of(ranking, citedSet) {
  for (let i = 0; i < Math.min(3, ranking.length); i++) {
    if (citedSet.has(ranking[i].id)) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Per-(project,day) evaluation
// ---------------------------------------------------------------------------

export function evaluateDayPair(pair, recordsById, graph, deps) {
  const { rankCorrections, assocNodeId } = deps;
  const candidateRecords = pair.candidates
    .map((id) => recordsById.get(id))
    .filter((r) => r !== undefined);
  if (candidateRecords.length === 0 || pair.cited.length === 0) return null;

  const rankingA = rankCorrections(candidateRecords);
  const citedSet = new Set(pair.cited);

  const contextSize = Math.min(2, rankingA.length);
  const context = rankingA.slice(0, contextSize).map((r) => assocNodeId(pair.project, r.id));
  const rankingB = tieBreakFixedContext(rankingA, pair.project, context, graph, pair.day, deps);

  return {
    project: pair.project,
    day: pair.day,
    n_candidates: candidateRecords.length,
    n_cited: pair.cited.length,
    mrr_a: mrrOf(rankingA, citedSet),
    mrr_b: mrrOf(rankingB, citedSet),
    hit3_a: hit3Of(rankingA, citedSet),
    hit3_b: hit3Of(rankingB, citedSet),
  };
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

export async function runEval({ storeRoot, deps }) {
  const {
    readCitedEvents,
    buildAssociationGraphFromEvents,
    adjacencyFromEdgesFile,
    heedTierDayOf,
  } = deps;

  const projects = listProjects(storeRoot);

  // 1. Raw per-project reads, ONCE (pure in-memory filtering per day below —
  //    no re-reading disk per iteration).
  const citedEventsByProject = new Map();
  const ledgerByProject = new Map();
  const recordsByIdByProject = new Map();
  for (const project of projects) {
    const { events } = readCitedEvents(storeRoot, project);
    citedEventsByProject.set(project, events);
    ledgerByProject.set(project, readOutcomeLedger(storeRoot, project));
    const recordsById = new Map();
    for (const rec of readCorrectionRecords(storeRoot, project)) recordsById.set(rec.id, rec);
    recordsByIdByProject.set(project, recordsById);
  }

  // 2. Every (project, day, candidates, cited) tuple, across every project.
  const allPairs = [];
  for (const project of projects) {
    const pairs = computeProjectDayPairs(project, ledgerByProject.get(project), heedTierDayOf);
    allPairs.push(...pairs);
  }

  // 3. Audit days in ascending order — the SET of days that appear as a
  //    retrieved-day for ANY project (global calendar day, since the
  //    association graph itself is a single global structure).
  const auditDays = [...new Set(allPairs.map((p) => p.day))].sort();

  const results = [];
  for (const day of auditDays) {
    // STRICT TEMPORAL SPLIT: rebuild the graph from cited events with
    // day < D ONLY, freshly, for this D — reusing Phase 2's own exported
    // pure derivation verbatim.
    const filtered = filterEventsBeforeDay(citedEventsByProject, day, heedTierDayOf);
    const { file } = buildAssociationGraphFromEvents(filtered);
    const graph = adjacencyFromEdgesFile(file);

    const dayPairs = allPairs.filter((p) => p.day === day);
    for (const pair of dayPairs) {
      const recordsById = recordsByIdByProject.get(pair.project);
      const evalResult = evaluateDayPair(pair, recordsById, graph, deps);
      if (evalResult) results.push(evalResult);
    }
  }

  const evaluableDays = new Set(results.map((r) => r.day));
  const n = results.length;
  const days = evaluableDays.size;
  const gatePassed = n >= MIN_EVALUABLE_PAIRS && days >= MIN_EVALUABLE_DAYS;

  const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  const summary = {
    n_evaluable_pairs: n,
    n_evaluable_days: days,
    gate_passed: gatePassed,
    mrr_a: gatePassed ? mean(results.map((r) => r.mrr_a)) : null,
    mrr_b: gatePassed ? mean(results.map((r) => r.mrr_b)) : null,
    hit3_a: gatePassed ? mean(results.map((r) => r.hit3_a)) : null,
    hit3_b: gatePassed ? mean(results.map((r) => r.hit3_b)) : null,
    claim: gatePassed
      ? null
      : n < MIN_EVALUABLE_PAIRS
        ? `CANNOT CLAIM (n=${n} evaluable pairs < gate ${MIN_EVALUABLE_PAIRS})`
        : `CANNOT CLAIM (days=${days} evaluable days < gate ${MIN_EVALUABLE_DAYS})`,
  };
  if (gatePassed) {
    summary.mrr_uplift = summary.mrr_b - summary.mrr_a;
    summary.hit3_uplift = summary.hit3_b - summary.hit3_a;
  }

  return { store_root: storeRoot, projects_scanned: projects.length, per_pair: results, summary };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { store: defaultStoreRoot(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--store") args.store = argv[++i];
    else if (a === "--json") args.json = true;
  }
  return args;
}

function renderReport(result) {
  const s = result.summary;
  const lines = [];
  lines.push(`activation-eval — store: ${result.store_root}`);
  lines.push(`projects scanned: ${result.projects_scanned}`);
  lines.push(`evaluable (project,day) pairs: ${s.n_evaluable_pairs}  evaluable days: ${s.n_evaluable_days}`);
  if (!s.gate_passed) {
    lines.push(s.claim);
    return lines.join("\n") + "\n";
  }
  lines.push(`ranking A (existing rankCorrections):      MRR=${s.mrr_a.toFixed(4)}  hit@3=${s.hit3_a.toFixed(4)}`);
  lines.push(`ranking B (A + activation tie-break):      MRR=${s.mrr_b.toFixed(4)}  hit@3=${s.hit3_b.toFixed(4)}`);
  lines.push(`uplift (B - A):                            MRR=${s.mrr_uplift.toFixed(4)}  hit@3=${s.hit3_uplift.toFixed(4)}`);
  return lines.join("\n") + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const storeRoot = path.resolve(args.store);
  const core = await import("../../packages/core/dist/index.js");
  const deps = {
    readCitedEvents: core.readCitedEvents,
    buildAssociationGraphFromEvents: core.buildAssociationGraphFromEvents,
    adjacencyFromEdgesFile: core.adjacencyFromEdgesFile,
    assocNodeId: core.assocNodeId,
    activationBonus: core.activationBonus,
    rankCorrections: core.rankCorrections,
    heedTierDayOf: core.heedTierDayOf,
  };
  const result = await runEval({ storeRoot, deps });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(renderReport(result));
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  await main();
}
